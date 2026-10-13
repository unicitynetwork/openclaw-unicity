/**
 * Wallet lifecycle. The gateway holds the only Sphere over DATA_DIR (under the cross-process wallet lock) for as long
 * as the service runs; CLI commands open short messaging-only sessions under the same lock. Incoming transfers and
 * payment requests are buffered from the moment Sphere.init resolves until the channel subscribes. Until then the
 * wallet-api reads that surface them (the wake socket, mailbox and payment-request listings) are held back; events
 * emitted with no listener anyway (e.g. while closing) are left to the channel's reconciliation on the next start.
 */

import { Sphere, TokenRegistry } from "@unicitylabs/sphere-sdk";
import type { IncomingTransfer, SphereInitResult } from "@unicitylabs/sphere-sdk";
import { createNodeProviders, createWalletApiProviders } from "@unicitylabs/sphere-sdk/impl/nodejs";
import type { PaymentRequestView } from "@unicitylabs/sphere-sdk/payments-v2";
import { API_KEY_HINT, effectiveApiKey, NETWORK_DEFAULTS, type UnicityConfig } from "./config.js";
import { NameVerifier, getOwnerAuthority, shortKey, toXOnly, type OwnerAuthority } from "./identity.js";
import { acquireWalletLock, WalletLockedError, type WalletLock } from "./lock.js";
import type { UnicityLogger } from "./runtime.js";
import {
  MNEMONIC_PATH, ensureDataDir, getOrCreateDeviceId, readMnemonic, resolveDataDir, saveMnemonic, writeGatewayStatus,
} from "./storage.js";
import { errorMessage, withTimeout } from "./util.js";

const LOCK_WAIT_MS = 120_000;
const API_FETCH_TIMEOUT_MS = 15_000;
const BLOB_FETCH_TIMEOUT_MS = 120_000;
/** Covers the SDK's worst case for sphere.resolve(): a 5 s transport reconnect plus its 20 s relay query. */
const OWNER_RESOLVE_TIMEOUT_MS = 30_000;
const GREETING_TIMEOUT_MS = 30_000;
/** DM replay window for addresses brought up later by switchToAddress (seconds). */
const DM_LOOKBACK_SECONDS = 86_400;
const MAX_BUFFERED_EVENTS = 1_000;
/** Backstop for a held mailbox/payment-request read (see createEventGate). */
const EVENT_READ_HOLD_MS = 60_000;
/** How long stop() waits for an in-flight open before leaving its teardown to the background (OpenClaw allows 5 s). */
const STOP_WAIT_MS = 3_000;
/** Wallet-storage key (global, unprefixed) of the address a failed nametag registration was last tried on. */
const NAMETAG_ATTEMPT_KEY = "openclaw_nametag_attempt_index";

export type OpenWalletResult = { sphere: Sphere; created: boolean };

export type WalletEventHandlers = {
  onTransfer(t: IncomingTransfer): void;
  onPaymentRequest(r: PaymentRequestView): void;
};

function bareName(n: string | null | undefined): string | undefined {
  return n ? n.replace(/^@/, "").toLowerCase() : undefined;
}

// ───────────────────────── event inbox ─────────────────────────

type WalletEvent = { kind: "transfer"; data: IncomingTransfer } | { kind: "payment_request"; data: PaymentRequestView };

/** FIFO buffer between the wallet's event emitter and a single (replaceable) consumer. */
class WalletEventInbox {
  private buffer: WalletEvent[] = [];
  private handlers: WalletEventHandlers | null = null;
  private offs: Array<() => void> = [];
  private draining = false;
  private log: UnicityLogger = console;

  attach(sphere: Sphere, log: UnicityLogger): void {
    this.log = log;
    this.offs.push(
      sphere.on("transfer:incoming", (data) => this.push({ kind: "transfer", data })),
      sphere.on("payment_request:incoming", (data) => this.push({ kind: "payment_request", data })),
    );
  }

  /** Undelivered events are dropped: the channel reconciles transfers and payment requests on its next start. */
  detach(): void {
    for (const off of this.offs.splice(0)) {
      try {
        off();
      } catch (err) {
        this.log.warn(`[unicity] Failed to remove a wallet event listener: ${errorMessage(err)}`);
      }
    }
    if (this.buffer.length) this.log.warn(`[unicity] Wallet closed with ${this.buffer.length} undelivered wallet event(s)`);
    this.buffer = [];
  }

  subscribe(h: WalletEventHandlers): () => void {
    this.handlers = h;
    this.drain();
    return () => {
      if (this.handlers === h) this.handlers = null;
    };
  }

  private push(e: WalletEvent): void {
    this.buffer.push(e);
    if (!this.handlers && this.buffer.length > MAX_BUFFERED_EVENTS) {
      this.buffer.shift();
      this.log.warn("[unicity] Wallet event buffer full; dropped the oldest event");
    }
    this.drain();
  }

  /** Re-entrancy safe: events emitted while a handler runs are queued behind the ones already buffered. */
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.handlers && this.buffer.length) this.deliver(this.handlers, this.buffer.shift()!);
    } finally {
      this.draining = false;
    }
  }

  private deliver(h: WalletEventHandlers, e: WalletEvent): void {
    const report = (err: unknown): void => this.log.warn(`[unicity] Wallet event handler failed: ${errorMessage(err)}`);
    try {
      const r: unknown = e.kind === "transfer" ? h.onTransfer(e.data) : h.onPaymentRequest(e.data);
      if (r instanceof Promise) r.catch(report);
    } catch (err) {
      report(err);
    }
  }
}

const inbox = new WalletEventInbox();

/**
 * Buffers transfer:incoming and payment_request:incoming from the moment Sphere.init resolves until a consumer
 * subscribes; delivers buffered events on subscribe (FIFO), then live. One consumer at a time (new subscribe replaces old).
 */
export function subscribeWalletEvents(h: WalletEventHandlers): () => void {
  return inbox.subscribe(h);
}

// ───────────────────────── network shims ─────────────────────────

/** The socket shape WalletApiSession drives (sphere-sdk impl/wallet-api-v2/session.ts WebSocketLike). */
type WakeSocket = {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((err: unknown) => void) | null;
  close(code?: number, reason?: string): void;
};

type EventGate = { factory: (url: string) => WakeSocket; reads: Promise<void>; release(): void };

/**
 * Holds back what makes the wallet emit transfer/payment-request events before anyone could have subscribed: the
 * wallet-api wake socket's `open` (and early wake frames) here, the mailbox and payment-request listings in
 * createTimeoutFetch (the SDK's 30 s pull timers and receive poll start inside Sphere.init). Released right after the
 * inbox is attached; Sphere.init never awaits those reads, so holding them cannot stall a healthy open. A failing
 * init's own teardown does wait for them, so held reads also go once the SDK closes its socket (session stop), and
 * after EVENT_READ_HOLD_MS at the latest.
 */
function createEventGate(): EventGate {
  let released = false;
  let releaseReads!: () => void;
  const reads = new Promise<void>((resolve) => (releaseReads = resolve));
  const flushers = new Set<() => void>();
  const factory = (url: string): WakeSocket => {
    const real = new WebSocket(url);
    const shim: WakeSocket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      close: (code, reason) => {
        releaseReads();
        real.close(code, reason);
      },
    };
    let queued: Array<() => void> = [];
    let closed = false;
    const flush = (): void => {
      const q = queued;
      queued = [];
      if (!closed) for (const f of q) f();
    };
    const deliver = (f: () => void): void => {
      if (released) {
        f();
        return;
      }
      queued.push(f);
      flushers.add(flush);
    };
    real.onopen = () => deliver(() => shim.onopen?.());
    real.onmessage = (ev) => deliver(() => shim.onmessage?.({ data: ev.data }));
    real.onerror = (ev) => shim.onerror?.(ev);
    real.onclose = (ev) => {
      closed = true;
      queued = [];
      flushers.delete(flush);
      shim.onclose?.({ code: ev.code });
    };
    return shim;
  };
  return {
    factory,
    reads,
    release(): void {
      if (released) return;
      released = true;
      for (const f of flushers) f();
      flushers.clear();
      releaseReads();
    },
  };
}

/** wallet-api reads that surface incoming transfers / payment requests (paths relative to the API base). */
const EVENT_READ_PATHS = ["/v1/mailbox", "/v1/payment-requests"];

/**
 * The SDK sets no client timeout (a hung wallet-api would hold Sphere.init ~5 min); presigned blob URLs get longer.
 * Event-surfacing reads wait for the gate (see createEventGate); their timeout starts once they are let through.
 */
function createTimeoutFetch(apiBaseUrl: string, gate: EventGate): (url: string, init?: RequestInit) => Promise<Response> {
  const base = new URL(apiBaseUrl);
  const prefix = base.pathname.replace(/\/+$/, "");
  const apiPath = (url: string): string | null => {
    try {
      const u = new URL(url);
      return u.origin === base.origin && (u.pathname === prefix || u.pathname.startsWith(`${prefix}/`))
        ? u.pathname.slice(prefix.length)
        : null;
    } catch {
      return null;
    }
  };
  return async (url, init) => {
    const path = apiPath(url);
    if ((init?.method ?? "GET").toUpperCase() === "GET" && path !== null && EVENT_READ_PATHS.includes(path)) {
      await withTimeout(gate.reads, EVENT_READ_HOLD_MS, "event read hold").catch(() => {});
    }
    const timeout = AbortSignal.timeout(path !== null ? API_FETCH_TIMEOUT_MS : BLOB_FETCH_TIMEOUT_MS);
    return fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
}

// ───────────────────────── shared open steps ─────────────────────────

/** Never passes trustBasePath or tokensDir: the SDK's embedded trust base is the right one for the network. */
function baseProviders(cfg: UnicityConfig) {
  const apiKey = effectiveApiKey(cfg);
  return createNodeProviders({
    network: cfg.network,
    dataDir: resolveDataDir(),
    oracle: apiKey ? { apiKey } : {},
    transport: { debug: false, ...(cfg.additionalRelays?.length ? { additionalRelays: cfg.additionalRelays } : {}) },
  });
}

function walletSecret(): { mnemonic: string } | { autoGenerate: true } {
  const mnemonic = readMnemonic();
  return mnemonic ? { mnemonic } : { autoGenerate: true };
}

const words = (m: string): string => m.trim().split(/\s+/).join(" ");

/**
 * Keeps mnemonic.txt in step with the wallet: writes it when missing (also repairs a create that failed after storing
 * the seed), never overwrites an existing one, and flags a backup that does not belong to the wallet in wallet.json
 * (Sphere.init ignores the given mnemonic when storage already holds a wallet). The seed is always in wallet.json too,
 * so failures here are logged, never thrown.
 */
function persistMnemonic(init: SphereInitResult, log: UnicityLogger): void {
  try {
    const saved = readMnemonic();
    const actual = init.generatedMnemonic ?? init.sphere.getMnemonic();
    if (saved) {
      if (actual && words(actual) !== words(saved)) {
        log.error(
          `[unicity] ${MNEMONIC_PATH} holds a different seed than the wallet in use (wallet.json); ` +
            "it was left unchanged and does NOT restore this wallet.",
        );
      }
      return;
    }
    if (!actual) return;
    saveMnemonic(actual);
    log.info(`[unicity] Mnemonic ${init.generatedMnemonic ? "saved" : "backup restored"} to ${MNEMONIC_PATH}`);
  } catch (err) {
    // The seed is still in wallet.json; the next start retries the backup.
    log.error(`[unicity] Could not write the mnemonic backup ${MNEMONIC_PATH}: ${errorMessage(err)}`);
  }
}

/**
 * Makes the active address carry the configured nametag: switch to a tracked address that already owns it, register
 * it on the current address if that has none, else register it on a fresh address (restoring the old one on failure).
 * A fresh address whose registration failed stays tracked (the SDK cannot untrack it), so it is remembered in wallet
 * storage and reused by the next attempt instead of adding another one each time. Non-fatal: failures are logged.
 */
async function ensureNametag(sphere: Sphere, wanted: string | undefined, log: UnicityLogger): Promise<void> {
  const current = bareName(sphere.identity?.nametag);
  if (!wanted) {
    if (!current) log.warn("[unicity] Wallet has no nametag. Run 'openclaw unicity setup' to configure one.");
    return;
  }
  if (current === wanted) return;
  try {
    const tracked = sphere.getAllTrackedAddresses();
    const currentIndex = sphere.getCurrentAddressIndex();
    const owning = tracked.find((a) => bareName(a.nametag) === wanted);
    if (owning) {
      if (owning.index !== currentIndex) {
        log.info(`[unicity] Switching to address ${owning.index}, which holds nametag @${wanted}...`);
        await sphere.switchToAddress(owning.index);
        log.info(`[unicity] Switched to address ${owning.index} with nametag @${wanted}.`);
      }
      return;
    }
    if (!current) {
      await sphere.registerNametag(wanted);
      log.info(`[unicity] Nametag @${wanted} registered.`);
      return;
    }
    if (!(await sphere.isNametagAvailable(wanted))) {
      log.warn(`[unicity] Nametag @${wanted} is taken; keeping @${current}.`);
      return;
    }
    const storage = sphere.getStorage();
    const saved = await storage.get(NAMETAG_ATTEMPT_KEY);
    const savedIndex = saved === null ? Number.NaN : Number(saved);
    const reusable = savedIndex !== currentIndex && tracked.some((a) => a.index === savedIndex && !a.nametag);
    const next = reusable ? savedIndex : Math.max(currentIndex, ...tracked.map((a) => a.index)) + 1;
    // Recorded before the switch, which already tracks the address durably.
    if (!reusable) await storage.set(NAMETAG_ATTEMPT_KEY, String(next));
    log.info(`[unicity] Registering nametag @${wanted} on address ${next}...`);
    await sphere.switchToAddress(next);
    try {
      await sphere.registerNametag(wanted);
    } catch (err) {
      log.warn(`[unicity] Failed to register nametag @${wanted} on address ${next}: ${errorMessage(err)}; switching back to address ${currentIndex}.`);
      await sphere.switchToAddress(currentIndex);
      return;
    }
    await storage.remove(NAMETAG_ATTEMPT_KEY).catch(() => {});
    log.info(`[unicity] Switched to address ${next} with nametag @${wanted}.`);
  } catch (err) {
    log.warn(`[unicity] Failed to register nametag @${wanted}: ${errorMessage(err)}`);
  }
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

// ───────────────────────── gateway wallet ─────────────────────────

type GatewaySlot = {
  abort: AbortController;
  log: UnicityLogger;
  lock: WalletLock | null;
  /** The lock was taken over: the lock file and the status file belong to the new holder. */
  lockLost: boolean;
  /** Sphere.init was called, so the process-global TokenRegistry may be configured. */
  initStarted: boolean;
  sphere: Sphere | null;
  disposed: Promise<void> | null;
  /** When this open started (ms, floored to the second): the DM cutoff of a wallet other than the recorded one. */
  openedAt: number;
};

type Gateway = { slot: GatewaySlot; promise: Promise<OpenWalletResult> };

let gateway: Gateway | null = null;
const closings = new Set<Promise<void>>();
let activeSphere: Sphere | null = null;
const sphereWaiters = new Set<(s: Sphere) => void>();
let nameVerifier: NameVerifier | null = null;

/**
 * The DM cutoff (ms, floored to the second like DM timestamps): cached DMs older than it are history. Recorded when the
 * gateway first starts opening a wallet, then bound to the wallet that opens (network + chain key). Process-wide, shared
 * by every copy of this module, and kept when the wallet closes: a plugin reload (any plugin-config change) closes the
 * wallet, re-imports this module and reopens it, and DMs that arrived meanwhile are new. Handled DMs, replayed from the
 * cache or re-delivered by the relays, stay skipped by their persisted markers (a DM turn runs only once its marker is
 * written) or, once a marker is evicted, by the floor it leaves (see storage.ts). Another wallet gets a cutoff of its
 * own.
 */
type DmCutoff = { at: number; network: string; chainPubkey: string | null };
const DM_CUTOFF_KEY = Symbol.for("openclaw-unicity.dmCutoff");
const processState = globalThis as unknown as Record<symbol, DmCutoff | undefined>;

const walletKeyOf = (sphere: Sphere): string => sphere.identity?.chainPubkey?.toLowerCase() ?? "";

/** Binds the recorded cutoff to the wallet about to be published, or records `openedAt` for a different wallet. */
function bindDmCutoff(network: string, sphere: Sphere, openedAt: number): void {
  const key = walletKeyOf(sphere);
  const rec = processState[DM_CUTOFF_KEY];
  if (rec?.network === network && (rec.chainPubkey === null || rec.chainPubkey === key)) rec.chainPubkey = key;
  else processState[DM_CUTOFF_KEY] = { at: openedAt, network, chainPubkey: key };
}

/** Detaches `current` (aborting its open) and tears it down in the background, tracked in `closings`. */
function beginClose(current: Gateway): void {
  if (gateway === current) gateway = null;
  current.slot.abort.abort();
  const closing = (async () => {
    await current.promise.catch(() => undefined);
    await disposeSlot(current.slot);
  })();
  closings.add(closing);
  void closing.finally(() => closings.delete(closing));
}

async function acquireGatewayLock(slot: GatewaySlot, signal: AbortSignal): Promise<WalletLock> {
  const { log } = slot;
  // Another process may be writing the wallet now: stop this one's writers rather than keep two of them.
  const onLost = (reason: string): void => {
    slot.lockLost = true;
    log.error(`[unicity] Wallet lock lost (${reason}); closing the wallet. Restart the gateway to reopen it.`);
    if (gateway?.slot === slot) beginClose(gateway);
  };
  try {
    return await acquireWalletLock({ role: "gateway", onLost });
  } catch (err) {
    if (!(err instanceof WalletLockedError)) throw err;
    log.info(`[unicity] ${err.message}; waiting up to ${LOCK_WAIT_MS / 1000}s for it to be released`);
    return acquireWalletLock({ role: "gateway", wait: { timeoutMs: LOCK_WAIT_MS, signal }, onLost });
  }
}

async function sendGreeting(sphere: Sphere, owner: OwnerAuthority, log: UnicityLogger): Promise<void> {
  const target = owner.notifyTarget();
  if (!target) {
    if (owner.nametag) log.warn(`[unicity] Owner @${owner.nametag} has no pinned key yet; skipping the greeting.`);
    return;
  }
  const identity = sphere.identity;
  const nametag = bareName(identity?.nametag);
  const me = nametag ? `@${nametag}` : (toXOnly(identity?.chainPubkey) ?? "your agent");
  const label = owner.nametag ? `@${owner.nametag} (${shortKey(target)})` : shortKey(target);
  log.info(`[unicity] Sending greeting to owner ${label}...`);
  try {
    await withTimeout(sphere.communications.sendDM(target, `I'm online, master! I am ${me}. What can I do for you?`), GREETING_TIMEOUT_MS, "greeting DM");
    log.info(`[unicity] Greeting sent to ${label}`);
  } catch (err) {
    log.warn(`[unicity] Failed to send greeting to ${label}: ${errorMessage(err)}`);
  }
}

function publish(sphere: Sphere): void {
  activeSphere = sphere;
  // Names looked up through an earlier wallet (maybe on another network, or failed while it closed) are not reused.
  nameVerifier = null;
  for (const w of sphereWaiters) w(sphere); // each waiter removes itself
}

/**
 * Destroys the wallet, then (if Sphere.init ran) the process-global TokenRegistry, whose hourly refresh would otherwise
 * keep writing wallet.json through the destroyed Sphere's storage — then unlocks. Never rejects.
 */
async function releaseWallet(sphere: Sphere | null, initStarted: boolean, lock: WalletLock | null, log: UnicityLogger): Promise<void> {
  if (sphere) {
    try {
      await sphere.destroy();
    } catch (err) {
      log.warn(`[unicity] Wallet destroy failed: ${errorMessage(err)}`);
    }
  }
  if (initStarted) {
    try {
      TokenRegistry.destroy();
    } catch (err) {
      log.warn(`[unicity] Token registry dispose failed: ${errorMessage(err)}`);
    }
  }
  await lock?.release();
}

/** Idempotent gateway teardown. */
function disposeSlot(slot: GatewaySlot): Promise<void> {
  slot.disposed ??= (async () => {
    if (activeSphere && activeSphere === slot.sphere) activeSphere = null;
    inbox.detach();
    if (slot.lock && !slot.lockLost) writeGatewayStatus(null);
    await releaseWallet(slot.sphere, slot.initStarted, slot.lock, slot.log);
  })();
  return slot.disposed;
}

async function runGatewayOpen(slot: GatewaySlot, cfg: UnicityConfig, signal: AbortSignal): Promise<OpenWalletResult> {
  const { log } = slot;
  const gate = createEventGate();
  try {
    if (closings.size) await abortable(Promise.all(closings), signal);
    ensureDataDir();
    slot.lock = await acquireGatewayLock(slot, signal);
    writeGatewayStatus(null); // the status file belongs to the lock holder: drop one a crashed predecessor left behind
    signal.throwIfAborted();

    const base = baseProviders(cfg);
    const baseUrl = cfg.walletApiUrl ?? NETWORK_DEFAULTS[cfg.network].walletApiUrl;
    const payments = effectiveApiKey(cfg) !== undefined;
    if (!payments) {
      log.warn(`[unicity] No API key configured: the wallet runs messaging-only (DMs and groups), payments are disabled; ${API_KEY_HINT}.`);
    }
    const providers = payments
      ? createWalletApiProviders(base, {
          baseUrl,
          network: cfg.network,
          deviceId: getOrCreateDeviceId(),
          fetchFn: createTimeoutFetch(baseUrl, gate),
          webSocketFactory: gate.factory,
        })
      : { ...base, walletApi: "none" as const };

    const secret = walletSecret();
    slot.initStarted = true;
    const init = await Sphere.init({
      ...providers,
      network: cfg.network,
      ...secret,
      groupChat: cfg.groupChat,
      dmSince: Math.floor(Date.now() / 1000) - DM_LOOKBACK_SECONDS,
    });
    // Same tick as init resolving: listeners first, then let the held wake socket and event reads through.
    slot.sphere = init.sphere;
    inbox.attach(init.sphere, log);
    gate.release();

    const sphere = init.sphere;
    persistMnemonic(init, log);
    signal.throwIfAborted();
    await ensureNametag(sphere, cfg.nametag, log);
    signal.throwIfAborted();

    const identity = sphere.identity;
    try {
      writeGatewayStatus({
        pid: process.pid,
        startedAt: Date.now(),
        network: cfg.network,
        ...(identity?.nametag ? { nametag: bareName(identity.nametag) } : {}),
        ...(identity?.chainPubkey ? { chainPubkey: identity.chainPubkey } : {}),
        ...(identity?.directAddress ? { directAddress: identity.directAddress } : {}),
        hasPayments: sphere.hasPayments,
      });
    } catch (err) {
      log.warn(`[unicity] Could not write the gateway status file: ${errorMessage(err)}`);
    }
    log.info(
      `[unicity] Wallet open: ${bareName(identity?.nametag) ?? identity?.chainPubkey ?? "unknown"} ` +
        `(network ${cfg.network}, payments ${sphere.hasPayments ? "on" : "off"})`,
    );
    bindDmCutoff(cfg.network, sphere, slot.openedAt);
    publish(sphere);

    const owner = getOwnerAuthority();
    if (owner) {
      await abortable(owner.resolve(sphere, { timeoutMs: OWNER_RESOLVE_TIMEOUT_MS }), signal);
      if (init.created) await abortable(sendGreeting(sphere, owner, log), signal);
    }
    return { sphere, created: init.created };
  } catch (err) {
    gate.release();
    await disposeSlot(slot);
    throw err;
  }
}

/**
 * Gateway path: lock (waits up to 120 s, abortable) -> Sphere.init with the wallet-api composition (messaging-only
 * without an API key) -> event inbox + event gate -> mnemonic backup, nametag -> status file -> owner resolution
 * (bounded, with the OwnerAuthority the entry point set) -> greeting on first creation. Concurrent callers share one
 * in-flight open. On failure or abort everything is torn down and the error (or abort reason) is rethrown. A lost
 * wallet lock closes the wallet.
 */
export function openGatewayWallet(cfg: UnicityConfig, log: UnicityLogger, opts?: { signal?: AbortSignal }): Promise<OpenWalletResult> {
  if (gateway) return gateway.promise;
  const openedAt = Math.floor(Date.now() / 1000) * 1000;
  // Kept across failed attempts: DMs that arrive while the wallet keeps failing to open are new once it opens.
  processState[DM_CUTOFF_KEY] ??= { at: openedAt, network: cfg.network, chainPubkey: null };
  const abort = new AbortController();
  const signal = opts?.signal ? AbortSignal.any([abort.signal, opts.signal]) : abort.signal;
  const slot: GatewaySlot = {
    abort, log, lock: null, lockLost: false, initStarted: false, sphere: null, disposed: null, openedAt,
  };
  const promise = runGatewayOpen(slot, cfg, signal);
  const current = { slot, promise };
  gateway = current;
  // A failed open (already torn down) frees the slot so the next call retries.
  promise.catch(() => {
    if (gateway === current) gateway = null;
  });
  return promise;
}

/**
 * Stop path: abort an in-flight open, destroy the wallet, dispose the token registry, remove the status file, unlock.
 * Waits at most STOP_WAIT_MS: Sphere.init and nametag registration cannot be interrupted, so a slow open is torn down
 * in the background once it settles (the wallet lock, and `closings` for a reopen here, keep the next open out until
 * then). Idempotent.
 */
export async function closeGatewayWallet(): Promise<void> {
  const current = gateway;
  if (current) beginClose(current);
  if (!closings.size) return;
  try {
    await withTimeout(Promise.all(closings), STOP_WAIT_MS, "wallet close");
  } catch {
    current?.slot.log.warn("[unicity] The wallet is still opening; it will be closed in the background (the wallet lock holds the next open until then).");
  }
}

/**
 * Cutoff (ms, floored to the second like DM timestamps) below which cached DMs are history: recorded when the gateway
 * first starts opening a wallet in this process and kept across failed attempts, channel restarts, wallet closes and
 * plugin reloads for as long as the same wallet reopens (see DmCutoff); null before.
 */
export function getDmCutoff(): number | null {
  return processState[DM_CUTOFF_KEY]?.at ?? null;
}

/**
 * Raises the DM cutoff of `sphere`'s wallet to `ms`: DMs before it were ignored on purpose (a dmPolicy "disabled"
 * channel start), so later starts treat them as history, after a plugin reload too. No-op for any other wallet.
 */
export function ignoreDmsBefore(sphere: Sphere, ms: number): void {
  const rec = processState[DM_CUTOFF_KEY];
  if (rec && rec.chainPubkey === walletKeyOf(sphere) && ms > rec.at) rec.at = ms;
}

export function getSphereOrNull(): Sphere | null {
  return activeSphere;
}

/**
 * The one nametag verifier for inbound sender labels and the payment-request tools, so they share its cache: names are
 * forward-resolved through the open wallet (none open: unverified). Created on first use and again for each wallet
 * opened; a copy of this module (plugin reload) has its own, bound to its own wallet.
 */
export function getNameVerifier(): NameVerifier {
  return (nameVerifier ??= new NameVerifier(getSphereOrNull));
}

/** Resolves with the sphere once open; resolves null if the signal aborts or timeoutMs passes; never rejects. */
export function waitForSphere(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Sphere | null> {
  if (activeSphere) return Promise.resolve(activeSphere);
  const signal = opts?.signal;
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise<Sphere | null>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (s: Sphere | null): void => {
      sphereWaiters.delete(finish);
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve(s);
    };
    const onAbort = (): void => finish(null);
    sphereWaiters.add(finish);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (opts?.timeoutMs !== undefined) timer = setTimeout(() => finish(null), opts.timeoutMs);
  });
}

// ───────────────────────── CLI wallet ─────────────────────────

export type CliWallet = {
  sphere: Sphere;
  created: boolean;
  close(): Promise<void>;
  /** Resolves with the reason if the wallet lock is lost; the wallet is closed by then (close() stays safe to call). */
  lost: Promise<string>;
};

/**
 * CLI path: fail-fast lock (throws WalletLockedError while the gateway holds it) and a messaging-only session, so the
 * CLI never drains the payments mailbox meant for the agent. Only `init` applies the configured nametag (it may
 * register it or switch the active address); other commands use the wallet as it is and warn when the config differs.
 * close() destroys, disposes the registry and unlocks. A lost lock closes the wallet; lost during the open, the open
 * fails once its current step settles (Sphere.init cannot be interrupted).
 */
export async function openCliWallet(cfg: UnicityConfig, log: UnicityLogger, command: string): Promise<CliWallet> {
  ensureDataDir();
  let sphere: Sphere | null = null;
  let initStarted = false;
  let opened = false;
  let lostReason: string | null = null;
  let closing: Promise<void> | null = null;
  let lock: WalletLock | null = null;
  const close = (): Promise<void> => (closing ??= releaseWallet(sphere, initStarted, lock, log));
  let reportLost!: (reason: string) => void;
  const lost = new Promise<string>((resolve) => (reportLost = resolve));
  lock = await acquireWalletLock({
    role: "cli",
    command,
    // Another process may be writing the wallet now: stop this one's writers rather than keep two of them.
    onLost: (reason) => {
      lostReason = reason;
      log.error(`[unicity] Wallet lock lost (${reason}); closing the wallet.`);
      if (opened) void close().then(() => reportLost(reason));
    },
  });
  const checkLock = (): void => {
    if (lostReason !== null) throw new Error(`Wallet lock lost while opening the wallet (${lostReason})`);
  };
  try {
    const providers = baseProviders(cfg);
    const secret = walletSecret();
    initStarted = true;
    const init = await Sphere.init({
      ...providers,
      network: cfg.network,
      walletApi: "none",
      ...secret,
      groupChat: false,
      dmSince: Math.floor(Date.now() / 1000) - DM_LOOKBACK_SECONDS,
    });
    sphere = init.sphere;
    checkLock();
    persistMnemonic(init, log);
    if (command === "init") {
      await ensureNametag(init.sphere, cfg.nametag, log);
      checkLock();
    } else {
      const have = bareName(init.sphere.identity?.nametag);
      if (cfg.nametag && have !== cfg.nametag) {
        log.warn(
          `[unicity] Config nametag @${cfg.nametag} differs from the wallet's (${have ? `@${have}` : "none"}); ` +
            "'openclaw unicity init' or the next gateway start applies it.",
        );
      }
    }
    opened = true;
    return { sphere: init.sphere, created: init.created, close, lost };
  } catch (err) {
    await close();
    throw err;
  }
}

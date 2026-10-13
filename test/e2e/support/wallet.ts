/**
 * Shared helpers for the live testnet2 e2e suites. Public sphere-sdk API only; every wallet lives in
 * its own temp dir and callers destroy it (plus TokenRegistry.destroy()) on teardown.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Sphere, type DirectMessage, type SphereInitResult } from "@unicitylabs/sphere-sdk";
import { createNodeProviders, createWalletApiProviders } from "@unicitylabs/sphere-sdk/impl/nodejs";

/** One network literal for createNodeProviders, the wallet-api composition and Sphere.init. */
export const NETWORK = "testnet2";
/** Public testnet2 gateway key (not a secret; sphere-sdk docs/QUICKSTART-NODEJS.md). */
export const TESTNET2_API_KEY = "sk_ddc3cfcc001e4a28ac3fad7407f99590";
export const TESTNET2_WALLET_API = "https://wallet-api.unicity.network";

const NAMETAG_RE = /^[a-z0-9_-]{3,20}$/;
const WALLET_API_TIMEOUT_MS = 30_000;
const BLOB_TIMEOUT_MS = 120_000;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `ocu-e2e-${label}-`));
}

export function removeDir(dir: string | undefined): void {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

/** Random nametag accepted by the SDK (^[a-z0-9_-]{3,20}$); the prefix keeps test wallets recognisable. */
export function randomNametag(prefix: string): string {
  const tag = `${prefix}${randomBytes(10).toString("hex")}`.slice(0, 20);
  if (!NAMETAG_RE.test(tag) || tag.length - prefix.length < 10) throw new Error(`bad nametag prefix "${prefix}"`);
  return tag;
}

/** Canonical identity: lowercase x-only key. 66-hex 02/03 chain keys drop the parity byte. */
export function toXOnly(pk: string | null | undefined): string | null {
  const k = pk?.toLowerCase() ?? "";
  if (/^[0-9a-f]{64}$/.test(k)) return k;
  if (/^0[23][0-9a-f]{64}$/.test(k)) return k.slice(2);
  return null;
}

/**
 * The SDK passes no AbortSignal to fetchFn (one passed later is honoured too): bound wallet-api calls so a hung
 * backend fails the test instead of stalling it.
 */
function timeoutFetch(url: string, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(url.startsWith(TESTNET2_WALLET_API) ? WALLET_API_TIMEOUT_MS : BLOB_TIMEOUT_MS);
  return fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
}

export type TestWalletOptions = {
  label: string;
  dataDir: string;
  /** Registered on create (Nostr identity binding). */
  nametag?: string;
  /** true = wallet-api composition (money); false = messaging-only (walletApi:'none'). */
  payments: boolean;
  /**
   * Aggregator key. Default: the public testnet2 key with payments, none without, as the plugin's gateway composes a
   * wallet (messaging-only exactly when it has no key). A messaging-only wallet with a key is the plugin CLI's composition.
   */
  apiKey?: string;
};

/** Opens (or creates) a testnet2 wallet. Never passes tokensDir or trustBasePath (the SDK embeds the testnet2 trust base). */
export function openTestWallet(o: TestWalletOptions): Promise<SphereInitResult> {
  const apiKey = o.apiKey ?? (o.payments ? TESTNET2_API_KEY : undefined);
  const base = createNodeProviders({ network: NETWORK, dataDir: o.dataDir, oracle: apiKey ? { apiKey } : {} });
  const providers = o.payments
    ? createWalletApiProviders(base, {
        baseUrl: TESTNET2_WALLET_API,
        network: NETWORK,
        deviceId: `ocu-e2e-${o.label}-${randomUUID()}`,
        fetchFn: timeoutFetch,
      })
    : { ...base, walletApi: "none" as const };
  return Sphere.init({ ...providers, network: NETWORK, autoGenerate: true, ...(o.nametag ? { nametag: o.nametag } : {}) });
}

/** Destroys every sphere, logging (not throwing) failures so teardown always completes. */
export async function destroyAll(spheres: Iterable<Sphere | null | undefined>): Promise<void> {
  for (const s of spheres) {
    if (!s) continue;
    try {
      await s.destroy();
    } catch (err) {
      console.warn(`[e2e] sphere.destroy failed: ${String(err)}`);
    }
  }
}

export function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

/** Settles like `p`, or rejects once `ms` elapse (the timer is cleared either way; `p` itself keeps running). */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

/**
 * Polls `probe` until it returns a non-nullish, non-false value. Probe errors are retried; the last one is reported
 * on timeout. A probe that hangs (relay, wallet-api) is cut off at the deadline, so the wait fails with this
 * message instead of the generic test timeout.
 */
export async function pollUntil<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const v = await within(Promise.resolve().then(probe), remaining(deadline), `probe for ${what}`);
      if (v !== null && v !== undefined && v !== false) return v;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const why = lastError === undefined ? "" : ` (last error: ${String(lastError)})`;
      throw new Error(`Timed out after ${opts.timeoutMs}ms waiting for ${what}${why}`);
    }
    await sleep(Math.min(opts.intervalMs ?? 2_000, remaining(deadline)));
  }
}

export type DmMatch = { from?: string; content?: string | RegExp | ((content: string) => boolean) };

/**
 * Records inbound DMs from the moment it is constructed. onDirectMessage replays the cache (including
 * this wallet's OWN sent messages, whose senderPubkey is its chain key) synchronously on subscribe, and
 * the relay may redeliver stored events, so matches are by authenticated sender key and content, never
 * "the first DM".
 */
export class DmInbox {
  readonly received: DirectMessage[] = [];
  private readonly self: string | null;
  private readonly off: () => void;
  /** Pending waitFor() calls: match check -> cancel (clears its timer). */
  private readonly waiters = new Map<() => void, () => void>();

  constructor(sphere: Sphere) {
    this.self = toXOnly(sphere.identity?.chainPubkey);
    this.off = sphere.communications.onDirectMessage((m) => {
      if (toXOnly(m.senderPubkey) === this.self) return;
      if (this.received.some((r) => r.id === m.id)) return;
      this.received.push(m);
      for (const notify of this.waiters.keys()) notify();
    });
  }

  find(match: DmMatch): DirectMessage | undefined {
    const from = match.from === undefined ? undefined : toXOnly(match.from);
    return this.received.find((m) => {
      if (from !== undefined && toXOnly(m.senderPubkey) !== from) return false;
      const c = match.content;
      if (c === undefined) return true;
      if (typeof c === "string") return m.content === c;
      if (c instanceof RegExp) return c.test(m.content);
      return c(m.content);
    });
  }

  waitFor(match: DmMatch, timeoutMs: number, what: string): Promise<DirectMessage> {
    const hit = this.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const check = (): void => {
        const m = this.find(match);
        if (!m) return;
        done();
        resolve(m);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${what}; inbox: ${this.describe()}`));
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      this.waiters.set(check, done);
    });
  }

  describe(): string {
    if (this.received.length === 0) return "(empty)";
    return this.received.map((m) => `[${toXOnly(m.senderPubkey)?.slice(0, 12) ?? m.senderPubkey}…] ${JSON.stringify(m.content.slice(0, 120))}`).join("; ");
  }

  /** Unsubscribes and drops pending waits (their timers too, so an abandoned wait cannot reject after teardown). */
  close(): void {
    this.off();
    for (const cancel of this.waiters.values()) cancel();
  }
}

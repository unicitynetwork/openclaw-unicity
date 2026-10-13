/**
 * Authenticated identity helpers. Authority comes only from keys that authenticated an event (DM seal key, group
 * event key, transfer/request chain key); sender-asserted nametags are display hints until forward-verified.
 */

import type { Sphere } from "@unicitylabs/sphere-sdk";
import type { UnicityLogger } from "./runtime.js";
import { OWNER_PIN_PATH, readJsonFileStrict, resolveDataDir, writeJsonFileAtomic } from "./storage.js";
import { errorMessage, withTimeout } from "./util.js";
import { normalizeNametag } from "./validation.js";

const HEX64 = /^[0-9a-fA-F]{64}$/;
const HEX66 = /^0[23][0-9a-fA-F]{64}$/;

/** Canonical identity: lowercase x-only key. For one private key the 66-hex chain key minus its prefix is the Nostr key. */
export function toXOnly(pk: string | null | undefined): string | null {
  const k = pk?.trim();
  if (!k) return null;
  if (HEX64.test(k)) return k.toLowerCase();
  if (HEX66.test(k)) return k.slice(2).toLowerCase();
  return null;
}

/** First 12 hex chars of the x-only key + "…". */
export function shortKey(pk: string): string {
  return `${(toXOnly(pk) ?? pk).slice(0, 12)}…`;
}

/** Sender-asserted names are attacker text: normalized and charset-checked, anything else dropped. */
export function sanitizeNametagClaim(raw: unknown): string | undefined {
  return typeof raw === "string" ? (normalizeNametag(raw) ?? undefined) : undefined;
}

/** Result of forward-verifying a claimed nametag: `verified` when it resolves to the sender's key, else `claimed`. */
export type NameCheck = { verified?: string; claimed?: string };

/** " (claims @x, unverified)" for a valid claimed name, else "" — the only way an unverified claim is ever shown. */
export function claimedNameSuffix(raw: unknown): string {
  const claim = sanitizeNametagClaim(raw);
  return claim ? ` (claims @${claim}, unverified)` : "";
}

/**
 * x-only key of a self-consistent nametag binding: its chain key must be present and belong to the key that signed it.
 * Null otherwise (missing binding, missing or foreign chain key).
 */
export function bindingKey(peer: { transportPubkey?: string; chainPubkey?: string } | null | undefined): string | null {
  const key = toXOnly(peer?.transportPubkey);
  return key && toXOnly(peer?.chainPubkey) === key ? key : null;
}

/** Forward UNIP-01 lookup of '@name' (see bindingKey). Null when absent, ambiguous or inconsistent; throws when the wallet is not ready. */
async function resolveNameKey(sphere: Sphere, name: string): Promise<string | null> {
  return bindingKey(await sphere.resolve(`@${name}`));
}

type PinFile = { pins: Record<string, { key: string; pinnedAt: number }> };
/** A name's pin: its x-only key (null when the name has none), or why the pin file cannot be trusted. */
type PinRead = { key: string | null } | { broken: string };

/** The pin of `name`; a malformed entry for it is broken, never absent (absent would let it be re-pinned). */
function pinOf(pins: PinFile["pins"], name: string): PinRead {
  if (!Object.hasOwn(pins, name)) return { key: null };
  const entry: unknown = pins[name];
  const raw = entry !== null && typeof entry === "object" ? (entry as { key?: unknown }).key : undefined;
  const key = typeof raw === "string" ? toXOnly(raw) : null;
  return key ? { key } : { broken: `the pin for @${name} holds no valid key` };
}

const RETRY_INTERVAL_MS = 60_000;

/**
 * Owner authority: explicit ownerPubkeys and a hex `owner` are authoritative; a nametag `owner` is resolved once via
 * sphere.resolve('@'+owner), checked self-consistent and pinned TOFU in OWNER_PIN_PATH, and trusted only once the pin
 * is on disk. A pin is never replaced automatically: a later different answer is logged as an error and the pin is
 * kept (delete the file to re-pin). A pin file that exists but cannot be read or parsed fails closed: nametag authority
 * stays off for this instance, since reading it as empty would pin whatever the name resolves to now.
 */
export class OwnerAuthority {
  /** Owner nametag when `owner` is a nametag (resolved + pinned); null when it is a key or unset. */
  readonly nametag: string | null;
  private readonly ownerKey: string | null;
  private readonly extraKeys: string[];
  private readonly log: UnicityLogger;
  private pinned: string | null;
  /** The pin file cannot be trusted: no lookup, no pin, no nametag-derived owner (see failClosed). */
  private pinBroken = false;
  private audited = false;
  private attempt: Promise<void> | null = null;
  private lastAttemptAt = 0;
  private settled = false;
  private readonly firstSettled: Promise<void>;
  private markSettled: () => void = () => {};

  constructor(opts: { owner?: string; ownerPubkeys: string[]; log: UnicityLogger }) {
    this.log = opts.log;
    const owner = opts.owner?.trim().replace(/^@/, "");
    this.ownerKey = toXOnly(owner);
    this.nametag = !this.ownerKey && owner ? normalizeNametag(owner) : null;
    this.extraKeys = [...new Set(opts.ownerPubkeys.map((k) => toXOnly(k)).filter((k): k is string => !!k))];
    const pin: PinRead = this.nametag ? this.readPin(this.nametag) : { key: null };
    this.pinned = "key" in pin ? pin.key : this.failClosed(pin.broken);
    this.firstSettled = new Promise<void>((resolve) => {
      this.markSettled = () => {
        this.settled = true;
        resolve();
      };
    });
    if (!this.nametag || this.pinned || this.pinBroken) this.markSettled();
  }

  /** Synchronous; accepts 64- or 66-hex keys. */
  isOwnerKey(pk: string | null | undefined): boolean {
    const x = toXOnly(pk);
    return !!x && (x === this.ownerKey || x === this.pinned || this.extraKeys.includes(x));
  }

  /** x-only keys currently trusted as the owner. */
  ownerKeys(): string[] {
    return [...new Set([this.ownerKey, this.pinned, ...this.extraKeys].filter((k): k is string => !!k))];
  }

  /** x-only key to DM owner notices to (never '@owner', which is re-resolved and hijackable); null = no owner known. */
  notifyTarget(): string | null {
    return this.ownerKey ?? this.pinned ?? this.extraKeys[0] ?? null;
  }

  hasOwnerConfigured(): boolean {
    return !!this.ownerKey || !!this.nametag || this.extraKeys.length > 0;
  }

  /** Resolve (or audit an existing pin) at most once per minute; idempotent, bounded by timeoutMs, never throws. */
  async resolve(sphere: Sphere, opts?: { timeoutMs?: number }): Promise<void> {
    const name = this.nametag;
    if (!name || this.pinBroken || (this.pinned && this.audited)) return;
    if (!this.attempt) {
      if (Date.now() - this.lastAttemptAt < RETRY_INTERVAL_MS) return;
      this.lastAttemptAt = Date.now();
      this.attempt = this.runAttempt(sphere, name).finally(() => {
        this.attempt = null;
        this.markSettled();
      });
    }
    await withTimeout(this.attempt, opts?.timeoutMs ?? 20_000).catch(() => {});
  }

  /** Resolves when the first resolve() attempt settled (immediately when nothing needs resolving) or after timeoutMs. */
  async whenSettled(timeoutMs: number): Promise<void> {
    if (this.settled) return;
    await withTimeout(this.firstSettled, timeoutMs).catch(() => {});
  }

  private async runAttempt(sphere: Sphere, name: string): Promise<void> {
    let key: string | null;
    try {
      key = await resolveNameKey(sphere, name);
    } catch (err) {
      this.log.warn(`[unicity] Owner @${name} lookup failed: ${errorMessage(err)}`);
      return;
    }
    if (this.pinned) {
      this.audited = true;
      if (key && key !== this.pinned) {
        this.log.error(
          `[unicity] Owner @${name} now resolves to ${key}, but ${this.pinned} is pinned; keeping the pin. ` +
            `Delete ${OWNER_PIN_PATH} to re-pin, or list the new key in ownerPubkeys.`,
        );
      }
      return;
    }
    if (!key) {
      this.log.warn(
        `[unicity] Owner @${name} did not resolve to a self-consistent key (absent, ambiguous or timed out); ` +
          "owner-only actions stay disabled until it does. Set ownerPubkeys to configure owner keys directly.",
      );
      return;
    }
    const pinned = this.savePin(name, key);
    if (!pinned) return;
    this.pinned = pinned;
    this.log.info(`[unicity] Owner @${name} pinned to ${pinned} (${OWNER_PIN_PATH}); set ownerPubkeys to add more owner keys`);
  }

  /** Turns nametag authority off for this instance (see the class comment); returns null, the pinned key it leaves. */
  private failClosed(reason: string): null {
    this.pinBroken = true;
    this.log.error(
      `[unicity] Owner pin file ${OWNER_PIN_PATH} cannot be used (${reason}). Owner @${this.nametag} gets no authority ` +
        "until the file is repaired or deleted and the gateway restarted: read as empty, it would let the owner be " +
        "re-pinned to another key. ownerPubkeys and a hex owner keep working.",
    );
    return null;
  }

  /** All pins, or why the file cannot be trusted: only a missing file reads as no pins. */
  private readPins(): { pins: PinFile["pins"] } | { broken: string } {
    resolveDataDir();
    let raw: unknown;
    try {
      raw = readJsonFileStrict<unknown>(OWNER_PIN_PATH, { pins: {} });
    } catch (err) {
      return { broken: errorMessage(err) };
    }
    const pins = raw !== null && typeof raw === "object" ? (raw as { pins?: unknown }).pins : undefined;
    if (!pins || typeof pins !== "object" || Array.isArray(pins)) return { broken: 'not a {"pins": {...}} object' };
    return { pins: pins as PinFile["pins"] };
  }

  private readPin(name: string): PinRead {
    const file = this.readPins();
    return "broken" in file ? file : pinOf(file.pins, name);
  }

  /**
   * Writes the pin unless another process pinned this name meanwhile; returns the effective pinned key, or null when
   * the pin file cannot be trusted (then nothing is written and nametag authority turns off) or the pin could not be
   * written. An unwritten pin grants nothing: trusted now, it would be gone after a restart, and a binding changed
   * meanwhile would become the owner. The next lookup (at most once a minute) tries again.
   */
  private savePin(name: string, key: string): string | null {
    const file = this.readPins();
    if ("broken" in file) return this.failClosed(file.broken);
    const existing = pinOf(file.pins, name);
    if ("broken" in existing) return this.failClosed(existing.broken);
    if (existing.key) {
      if (existing.key !== key) {
        this.log.error(`[unicity] Owner @${name} resolved to ${key}, but ${existing.key} is already pinned; keeping the pin.`);
      }
      return existing.key;
    }
    try {
      writeJsonFileAtomic(OWNER_PIN_PATH, { pins: { ...file.pins, [name]: { key, pinnedAt: Date.now() } } });
    } catch (err) {
      this.log.error(
        `[unicity] Owner @${name} resolved to ${key}, but the pin cannot be saved to ${OWNER_PIN_PATH} ` +
          `(${errorMessage(err)}); owner-only actions stay disabled until it is (retried on the next lookup).`,
      );
      return null;
    }
    return key;
  }
}

let ownerAuthority: OwnerAuthority | null = null;

export function setOwnerAuthority(a: OwnerAuthority): void {
  ownerAuthority = a;
}

export function getOwnerAuthority(): OwnerAuthority | null {
  return ownerAuthority;
}

const VERIFIED_TTL_MS = 10 * 60_000;
const UNVERIFIED_TTL_MS = 60_000;
const MAX_CACHED_NAMES = 2000;

/** Forward-verifies a claimed nametag against an authenticated key, with TTL cache (10 min hit / 1 min miss) + in-flight dedup. */
export class NameVerifier {
  private readonly getSphere: () => Sphere | null;
  private readonly cache = new Map<string, { key: string | null; expires: number }>();
  private readonly inflight = new Map<string, Promise<string | null>>();

  constructor(getSphere: () => Sphere | null) {
    this.getSphere = getSphere;
  }

  async verify(claimed: string | undefined, senderPubkey: string): Promise<NameCheck> {
    const name = sanitizeNametagClaim(claimed);
    if (!name) return {};
    const sender = toXOnly(senderPubkey);
    if (!sender) return { claimed: name };
    return (await this.keyOf(name)) === sender ? { verified: name } : { claimed: name };
  }

  /** "@name" when verified, else "<shortKey>" or "<shortKey> (claims @x, unverified)". */
  label(r: NameCheck, senderPubkey: string): string {
    return r.verified ? `@${r.verified}` : `${shortKey(senderPubkey)}${claimedNameSuffix(r.claimed)}`;
  }

  private keyOf(name: string): Promise<string | null> {
    const hit = this.cache.get(name);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.key);
    const running = this.inflight.get(name);
    if (running) return running;
    const sphere = this.getSphere();
    if (!sphere) return Promise.resolve(null);
    const p = resolveNameKey(sphere, name)
      .catch(() => null) // transport down or wallet closing: unverified, short TTL
      .then((key) => {
        this.cache.delete(name);
        if (this.cache.size >= MAX_CACHED_NAMES) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(name, { key, expires: Date.now() + (key ? VERIFIED_TTL_MS : UNVERIFIED_TTL_MS) });
        return key;
      })
      .finally(() => this.inflight.delete(name));
    this.inflight.set(name, p);
    return p;
  }
}

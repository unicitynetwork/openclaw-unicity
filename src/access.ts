/**
 * DM admission for the Unicity channel: the policy decision, allowFrom resolution and pairing challenges.
 *
 * Every decision is keyed on the authenticated x-only sender key. Sender-asserted nametags are never compared;
 * nametag allowFrom entries are resolved forward (`@name` -> key) and matched against the authenticated key.
 */

import type { Sphere } from "@unicitylabs/sphere-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { CHANNEL_ID, type DmPolicy } from "./config.js";
import { bindingKey, toXOnly } from "./identity.js";
import type { UnicityLogger } from "./runtime.js";
import { errorMessage, withTimeout } from "./util.js";
import { normalizeNametag } from "./validation.js";

export type AccessDecision = { kind: "admit"; isOwner: boolean } | { kind: "pair" } | { kind: "drop"; reason: string };

/**
 * Pure DM gate.
 * - disabled: drops everything, the owner included (kill switch).
 * - the owner is admitted under every other policy.
 * - open: everyone is admitted (pass the result of effectiveDmPolicy, which turns "open" with concrete entries into allowlist).
 * - allowlist: listed keys only ("*" lists everyone); the pairing store is not consulted.
 * - pairing: listed or approved keys; others get a pairing challenge when `mayPair` (never for wallet events).
 */
export function decideDmAccess(input: {
  policy: DmPolicy;
  senderKey: string;
  isOwner: boolean;
  allowKeys: Set<string>;
  allowAll: boolean;
  pairedKeys: Set<string>;
  mayPair: boolean;
}): AccessDecision {
  if (input.policy === "disabled") return { kind: "drop", reason: "dm-disabled" };
  if (input.isOwner) return { kind: "admit", isOwner: true };
  if (input.policy === "open") return { kind: "admit", isOwner: false };
  if (input.allowAll || input.allowKeys.has(input.senderKey)) return { kind: "admit", isOwner: false };
  if (input.policy === "pairing") {
    if (input.pairedKeys.has(input.senderKey)) return { kind: "admit", isOwner: false };
    return input.mayPair ? { kind: "pair" } : { kind: "drop", reason: "not-paired" };
  }
  return { kind: "drop", reason: "not-allowlisted" };
}

/** Effective policy: unset means "open"; "open" with concrete allowFrom entries and no "*" admits only those (core semantics). */
export function effectiveDmPolicy(policy: DmPolicy | undefined, allowFrom: readonly string[] | undefined): DmPolicy {
  const resolved = policy ?? "open";
  const entries = (allowFrom ?? []).map((e) => String(e).trim()).filter(Boolean);
  return resolved === "open" && entries.length > 0 && !entries.includes("*") ? "allowlist" : resolved;
}

/** Drops an optional "unicity:" prefix (allowFrom entries, pairing store entries, outbound targets). */
export function stripChannelPrefix(raw: string): string {
  return raw.trim().replace(/^unicity:/i, "");
}

/**
 * Core's rule for a configured command owner: a non-empty commands.ownerAllowFrom entry that is not a wildcard ("*" or
 * "<channel>:*"). Without one, `openclaw pairing approve` makes the approved sender the command owner.
 */
export function hasConfiguredCommandOwner(cfg: unknown): boolean {
  const entries = (cfg as { commands?: { ownerAllowFrom?: unknown } } | null | undefined)?.commands?.ownerAllowFrom;
  if (!Array.isArray(entries)) return false;
  return entries.some((e) => {
    const entry = typeof e === "string" || typeof e === "number" ? String(e).trim() : "";
    return entry !== "" && entry !== "*" && !entry.endsWith(":*");
  });
}

/** Canonical allowFrom entry: "*", an x-only pubkey, "@nametag", or the lowercased input when unrecognized. */
export function normalizeAllowEntry(raw: string): string {
  const entry = stripChannelPrefix(String(raw));
  if (entry === "*") return "*";
  const key = toXOnly(entry);
  if (key) return key;
  const tag = normalizeNametag(entry);
  return tag ? `@${tag}` : entry.toLowerCase();
}

/** Entry form used by core command authorization (matched against the x-only SenderId): no '@', lowercase. */
export function formatAllowEntry(raw: string): string {
  const entry = normalizeAllowEntry(raw);
  return entry.startsWith("@") ? entry.slice(1) : entry;
}

/** Pubkeys are bound by the NIP-17 seal signature; nametags are vouched for by the relay binding only. */
export function classifyAllowEntry(raw: string): "verified" | "asserted" | undefined {
  const entry = normalizeAllowEntry(raw);
  if (entry === "*") return undefined;
  if (toXOnly(entry)) return "verified";
  return entry.startsWith("@") ? "asserted" : undefined;
}

/** `failed`: the lookup failed and no recent key stood in, so the null is no answer about the name. */
type CachedKey = { key: string | null; expiresAt: number; resolvedAt: number; failed: boolean };

const NAME_TTL_MS = 5 * 60_000;
const NAME_MISS_TTL_MS = 60_000;
const NAME_STALE_MAX_MS = 60 * 60_000;
/** The SDK's own binding-query timeout: under relay load a nametag binding query takes several seconds. */
const NAME_TIMEOUT_MS = 20_000;
/** At most one warning per name and window about a failed lookup with no recent key to stand in. */
const NAME_FAIL_WARN_MS = 10 * 60_000;

/**
 * Resolves allowFrom entries to x-only keys. Nametags are resolved forward with sphere.resolve('@name') and accepted only
 * when the binding is self-consistent (identity.bindingKey: a chain key is present and its x-only form equals the
 * transport key).
 * Cache: 5 min hits, 1 min misses. A lookup that errors or times out keeps the last good key for at most 1 hour;
 * without one, the entry is reported `unresolved` (no answer, so a drop that rests on it is not final). A lookup that
 * returns nothing (absent or ambiguous name) fails closed.
 */
export class AllowFromResolver {
  private readonly cache = new Map<string, CachedKey>();
  private readonly inflight = new Map<string, Promise<CachedKey>>();
  private readonly warned = new Set<string>();
  private readonly failWarnedAt = new Map<string, number>();

  constructor(
    private readonly getSphere: () => Sphere | null,
    /** The logger of the start that uses it now (one resolver serves every start on a wallet). */
    public log: UnicityLogger,
  ) {}

  /** A new start looks failed names up again at once instead of waiting out the miss cache; last good keys stay. */
  retryFailed(): void {
    for (const [name, entry] of this.cache) if (entry.failed) this.cache.delete(name);
  }

  /** `unresolved`: the @nametag entries whose lookup failed with no recent key to stand in. */
  async resolve(entries: string[]): Promise<{ keys: Set<string>; allowAll: boolean; unresolved: string[] }> {
    const keys = new Set<string>();
    const unresolved: string[] = [];
    let allowAll = false;
    await Promise.all(
      entries.map(async (raw) => {
        const entry = normalizeAllowEntry(raw);
        if (entry === "*") {
          allowAll = true;
          return;
        }
        const key = toXOnly(entry);
        if (key) {
          keys.add(key);
          return;
        }
        if (entry.startsWith("@")) {
          const resolved = await this.resolveName(entry.slice(1));
          if (resolved.key) keys.add(resolved.key);
          else if (resolved.failed) unresolved.push(entry);
          return;
        }
        if (!this.warned.has(entry)) {
          this.warned.add(entry);
          this.log.warn(`[unicity] ignoring allowFrom entry "${entry}": expected a 64/66-hex pubkey, @nametag or "*"`);
        }
      }),
    );
    return { keys, allowAll, unresolved: unresolved.sort() };
  }

  private resolveName(name: string): Promise<CachedKey> {
    const hit = this.cache.get(name);
    if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit);
    const running = this.inflight.get(name);
    if (running) return running;
    const lookup = this.lookup(name, hit).finally(() => this.inflight.delete(name));
    this.inflight.set(name, lookup);
    return lookup;
  }

  private async lookup(name: string, previous: CachedKey | undefined): Promise<CachedKey> {
    const sphere = this.getSphere();
    const now = Date.now();
    let entry: CachedKey;
    try {
      if (!sphere) throw new Error("wallet not open");
      // A timeout must reject: it is a failed lookup (stale key kept), not an absent name.
      const peer = await withTimeout(sphere.resolve(`@${name}`), NAME_TIMEOUT_MS, `allowFrom @${name} lookup`);
      const key = bindingKey(peer);
      if (peer && !key) {
        this.log.warn(`[unicity] allowFrom @${name}: binding is not self-consistent (missing or mismatched chain key); ignoring it`);
      }
      entry = { key, expiresAt: now + (key ? NAME_TTL_MS : NAME_MISS_TTL_MS), resolvedAt: key ? now : 0, failed: false };
    } catch (err) {
      const stale = previous?.key && now - previous.resolvedAt < NAME_STALE_MAX_MS ? previous.key : null;
      entry = { key: stale, expiresAt: now + NAME_MISS_TTL_MS, resolvedAt: stale ? previous!.resolvedAt : 0, failed: !stale };
      const text = `[unicity] allowFrom @${name} lookup failed (${errorMessage(err)})`;
      const warnedAt = this.failWarnedAt.get(name);
      if (stale) {
        this.log.debug?.(`${text}; using last known key`);
      } else if (warnedAt === undefined || now - warnedAt >= NAME_FAIL_WARN_MS) {
        this.failWarnedAt.set(name, now);
        this.log.warn(`${text}; DMs that only it would admit are not decided until a lookup succeeds`);
      } else {
        this.log.debug?.(text);
      }
    }
    this.cache.set(name, entry);
    return entry;
  }
}

type PairingRuntime = PluginRuntime["channel"]["pairing"];

const CHALLENGE_THROTTLE_MS = 5 * 60_000;
const CHALLENGE_TRACK_MAX = 1000;

/**
 * Pairing via the core pairing store (`openclaw pairing list/approve unicity`). Approvals are read back on every event
 * because they are written by another process; the stored entry is the request id, i.e. the x-only key.
 */
export class PairingChallenger {
  private readonly recent = new Map<string, number>();

  constructor(
    private readonly pairing: PairingRuntime,
    private readonly accountId: string,
  ) {}

  /**
   * Per-sender rate limit shared by pairing challenges and "pairing paused" notices: false when this key was claimed
   * within the last 5 minutes.
   */
  claim(senderKey: string): boolean {
    const now = Date.now();
    const last = this.recent.get(senderKey);
    if (last !== undefined && now - last < CHALLENGE_THROTTLE_MS) return false;
    this.recent.delete(senderKey);
    this.recent.set(senderKey, now);
    if (this.recent.size > CHALLENGE_TRACK_MAX) this.recent.delete(this.recent.keys().next().value!);
    return true;
  }

  async readPairedKeys(): Promise<Set<string>> {
    const entries = await this.pairing.readAllowFromStore({ channel: CHANNEL_ID, accountId: this.accountId });
    return new Set(entries.map((e) => toXOnly(stripChannelPrefix(e))).filter((k): k is string => !!k));
  }

  /**
   * Upserts a pairing request and sends the code to the sender only when a new request was created (core caps pending
   * requests at 3 per account for 1 hour). Repeat DMs from the same key within 5 minutes skip the store write.
   * Returns null when throttled.
   */
  async challenge(
    senderKey: string,
    meta: Record<string, string> | undefined,
    sendReply: (text: string) => Promise<void>,
  ): Promise<{ code: string; created: boolean } | null> {
    if (!this.claim(senderKey)) return null;
    const { code, created } = await this.pairing.upsertPairingRequest({
      channel: CHANNEL_ID,
      id: senderKey,
      accountId: this.accountId,
      ...(meta ? { meta } : {}),
    });
    if (created && code) {
      await sendReply(
        this.pairing.buildPairingReply({ channel: CHANNEL_ID, idLine: `Your Unicity public key: ${senderKey}`, code }),
      );
    }
    return { code, created };
  }
}

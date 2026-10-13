/**
 * Persisted, bounded intent ledger for money operations, plus the local record of payment requests this wallet sent
 * (the SDK does not track outgoing requests). An intent is written BEFORE the SDK call, so a crash mid-operation
 * leaves an "intent" entry that still blocks an identical retry. Both files are read strictly: only a missing file is
 * empty, and an unreadable or corrupt one throws instead of being overwritten.
 */

import { randomUUID } from "node:crypto";
import { LEDGER_PATH, OUTGOING_REQUESTS_PATH, readJsonFileStrict, resolveDataDir, writeJsonFileAtomic } from "./storage.js";

export type LedgerEntry = {
  id: string;
  op: "send" | "pay" | "mint" | "request";
  key: string;
  /** Other keys naming the same operation (e.g. the recipient as typed when `key` names the resolved payee). */
  aliases?: string[];
  /**
   * A pay: the duplicate-guard key of the send it makes (see paymentKey). The SDK pays a request as a plain send of its
   * amount to the requester, so the entry also counts as that send.
   */
  sendKey?: string;
  at: number;
  state: "intent" | "done" | "failed" | "possibly_committed";
  transferId?: string;
  /** The SDK error code that settled a failed or possibly-committed operation, or a short remark. */
  note?: string;
  /** A completed send whose delivery to the recipient was still pending: it blocks like an unresolved entry. */
  deliveryPending?: boolean;
};

/**
 * `to` is the recipient as given; `toKey` the 66-hex chain key the request was addressed to. `origin`: who asked for
 * it, the owner or (in a DM, addressed to themselves) the payer; missing reads as "owner".
 */
export type OutgoingRequest = {
  requestId: string;
  to: string;
  toKey?: string;
  coinId: string;
  amount: string;
  memo?: string;
  createdAt: number;
  origin?: "owner" | "sender";
};

/**
 * Kept per operation kind, so a flood of one kind (non-owners can trigger payment requests) never evicts the
 * send/pay/mint entries that block a double payment.
 */
const MAX_ENTRIES_PER_OP = 500;
/** Sent requests are kept per origin for the same reason, and per payer among the ones payers asked for. */
const MAX_OUTGOING_REQUESTS = 200;
const MAX_SENDER_REQUESTS_PER_PAYER = 20;

/** Identical money operations inside this window are refused unless the caller passes allowDuplicate. */
export const DUPLICATE_WINDOW_MS = 15 * 60_000;

/**
 * How long an unresolved entry (intent, possibly_committed, or a completed send whose delivery was still pending)
 * whose transfer cannot be looked up keeps blocking by default.
 */
export const UNRESOLVED_WINDOW_MS = 24 * 3600_000;

/**
 * What keeps an entry blocking past the duplicate window. The SDK keeps a possibly-committed transfer open, with no
 * time limit, until it converges, so an entry blocks while its transfer is still pending (`pendingIds`: snapshot of
 * pendingTransfers() ids, null when unreadable). An unresolved entry (see UNRESOLVED_WINDOW_MS) also blocks for
 * `unresolvedWindowMs` when that cannot be checked: it has no transfer id, or the snapshot is null. A completed send
 * whose delivery was pending stops blocking as soon as a readable snapshot no longer lists its transfer.
 */
export type SettlingCheck = { pendingIds: Set<string> | null; unresolvedWindowMs?: number };

/** Duplicate-guard key: recipient compared case-insensitively ('@Alice' == 'alice'), coin id, base-unit amount. */
export function paymentKey(recipient: string, coinId: string, amount: bigint): string {
  return `${recipient.trim().replace(/^@/, "").toLowerCase()}|${coinId.toLowerCase()}|${amount}`;
}

function isLedgerEntry(v: unknown): v is LedgerEntry {
  const e = v as Partial<LedgerEntry> | null;
  return !!e && typeof e.id === "string" && typeof e.op === "string" && typeof e.key === "string" &&
    typeof e.at === "number" && typeof e.state === "string";
}

/** Rows of a JSON array file; throws when the file is unreadable, corrupt or not an array. */
function loadRows<T>(path: string, isRow: (v: unknown) => v is T): T[] {
  const raw = readJsonFileStrict<unknown>(path, []);
  if (!Array.isArray(raw)) throw new Error(`${path} is not a JSON array`);
  return raw.filter(isRow);
}

function loadLedger(): LedgerEntry[] {
  resolveDataDir();
  return loadRows(LEDGER_PATH, isLedgerEntry);
}

/** The newest `max` rows of each group, in their original order; rows whose group is null are not capped. */
function newestPerGroup<T>(rows: readonly T[], groupOf: (row: T) => string | null, max: number): T[] {
  const counts = new Map<string, number>();
  const kept: T[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const group = groupOf(rows[i]);
    if (group !== null) {
      const count = counts.get(group) ?? 0;
      if (count >= max) continue;
      counts.set(group, count + 1);
    }
    kept.push(rows[i]);
  }
  return kept.reverse();
}

function saveLedger(entries: LedgerEntry[]): void {
  resolveDataDir();
  writeJsonFileAtomic(LEDGER_PATH, newestPerGroup(entries, (e) => e.op, MAX_ENTRIES_PER_OP));
}

/** Whether `e` is an `op` under any of `keys` (key or alias), counting a pay as the send it makes (sendKey). */
function matches(e: LedgerEntry, op: LedgerEntry["op"], keys: readonly string[]): boolean {
  if (e.op === op) return keys.some((k) => e.key === k || (Array.isArray(e.aliases) && e.aliases.includes(k)));
  return op === "send" && e.op === "pay" && typeof e.sendKey === "string" && keys.includes(e.sendKey);
}

/** Whether an entry's transfer is in the pending snapshot. */
export function isStillSettling(e: LedgerEntry, settling: SettlingCheck | undefined): boolean {
  return !!e.transferId && !!settling?.pendingIds?.has(e.transferId);
}

function stillBlocks(e: LedgerEntry, now: number, windowMs: number, settling: SettlingCheck | undefined): boolean {
  if (e.state === "failed") return false;
  if (e.at >= now - windowMs) return true;
  if (!settling) return false;
  if (isStillSettling(e, settling)) return true;
  const unresolved = e.state === "intent" || e.state === "possibly_committed" || (e.state === "done" && e.deliveryPending === true);
  const cannotLookUp = !e.transferId || settling.pendingIds === null;
  return unresolved && cannotLookUp && e.at >= now - (settling.unresolvedWindowMs ?? UNRESOLVED_WINDOW_MS);
}

/**
 * Most recent entry for `op` under any of `keys` (key or alias; for a send, also a pay's sendKey) that still blocks a
 * repeat: its operation did not cleanly fail and it was recorded within `windowMs` or, with `settling`, it is still
 * settling (see SettlingCheck). Throws on an unreadable ledger.
 */
export function findBlockingEntry(
  op: LedgerEntry["op"],
  keys: readonly string[],
  windowMs: number,
  settling?: SettlingCheck,
): LedgerEntry | null {
  const now = Date.now();
  let found: LedgerEntry | null = null;
  for (const e of loadLedger()) {
    if (matches(e, op, keys) && stillBlocks(e, now, windowMs, settling) && (!found || e.at >= found.at)) found = e;
  }
  return found;
}

function newEntry(op: LedgerEntry["op"], key: string, aliases: readonly string[] | undefined, sendKey?: string): LedgerEntry {
  const distinct = [...new Set(aliases)].filter((a) => a !== key);
  return {
    id: randomUUID(),
    op,
    key,
    ...(distinct.length ? { aliases: distinct } : {}),
    ...(sendKey !== undefined ? { sendKey } : {}),
    at: Date.now(),
    state: "intent",
  };
}

/**
 * Persists a new intent entry (`sendKey`: a pay's, see LedgerEntry); throws if the ledger cannot be read or written
 * (the caller must then not start the operation).
 */
export function recordIntent(op: LedgerEntry["op"], key: string, aliases?: readonly string[], sendKey?: string): LedgerEntry {
  const entry = newEntry(op, key, aliases, sendKey);
  saveLedger([...loadLedger(), entry]);
  return entry;
}

/**
 * Records, as possibly committed, an operation the SDK attempted on the wallet's behalf without an intent of its own
 * (the remainder of a partial send). Best effort, never throws: the caller is in its commit phase.
 */
export function recordPossiblyCommitted(
  op: LedgerEntry["op"],
  key: string,
  extra?: { aliases?: readonly string[]; transferId?: string; note?: string },
): void {
  try {
    const entry: LedgerEntry = { ...newEntry(op, key, extra?.aliases), state: "possibly_committed" };
    if (extra?.transferId) entry.transferId = extra.transferId;
    if (extra?.note) entry.note = extra.note;
    saveLedger([...loadLedger(), entry]);
  } catch {
    // the operation's own entry still records the payment
  }
}

/** Newest non-failed "pay" entry per request id, with no time window; null when the ledger cannot be read. Never throws. */
export function latestPayAttempts(): Map<string, LedgerEntry> | null {
  try {
    const latest = new Map<string, LedgerEntry>();
    for (const e of loadLedger()) {
      if (e.op !== "pay" || e.state === "failed") continue;
      const prev = latest.get(e.key);
      if (!prev || e.at >= prev.at) latest.set(e.key, e);
    }
    return latest;
  } catch {
    return null;
  }
}

/** Best effort, never throws: a write failure leaves the entry as "intent", which still blocks duplicates. */
export function settle(
  id: string,
  state: Exclude<LedgerEntry["state"], "intent">,
  extra?: { transferId?: string; note?: string; deliveryPending?: boolean },
): void {
  try {
    const entries = loadLedger();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    entry.state = state;
    if (extra?.transferId) entry.transferId = extra.transferId;
    if (extra?.note) entry.note = extra.note;
    if (extra?.deliveryPending) entry.deliveryPending = true;
    saveLedger(entries);
  } catch {
    // keep the conservative "intent" state
  }
}

/**
 * Coin and base-unit amount of the sends recorded under each of `transferIds`, read from their duplicate-guard keys
 * (`payee|coinId|amount`); ids with no such send are absent, and an unreadable ledger gives an empty map. Never throws.
 */
export function recordedSendAmounts(transferIds: readonly string[]): Map<string, { coinId: string; amount: string }> {
  const found = new Map<string, { coinId: string; amount: string }>();
  if (!transferIds.length) return found;
  try {
    const wanted = new Set(transferIds);
    for (const e of loadLedger()) {
      if (e.op !== "send" || !e.transferId || !wanted.has(e.transferId)) continue;
      const [, coinId, amount, ...rest] = e.key.split("|");
      if (coinId && /^\d+$/.test(amount ?? "") && rest.length === 0) found.set(e.transferId, { coinId, amount });
    }
  } catch {
    // only a label is lost
  }
  return found;
}

function isOutgoingRequest(v: unknown): v is OutgoingRequest {
  const r = v as Partial<OutgoingRequest> | null;
  return !!r && typeof r.requestId === "string" && typeof r.to === "string" && typeof r.coinId === "string" &&
    typeof r.amount === "string" && typeof r.createdAt === "number" && (r.toKey === undefined || typeof r.toKey === "string") &&
    (r.origin === undefined || r.origin === "owner" || r.origin === "sender");
}

function loadOutgoing(): OutgoingRequest[] {
  resolveDataDir();
  return loadRows(OUTGOING_REQUESTS_PATH, isOutgoingRequest);
}

/**
 * Records a payment request this wallet sent; throws if the record cannot be read or written. The newest
 * MAX_OUTGOING_REQUESTS of each origin are kept, so requests payers ask for never evict the owner's own.
 */
export function recordOutgoingRequest(r: OutgoingRequest): void {
  resolveDataDir();
  const perPayer = newestPerGroup(
    [...loadOutgoing(), r],
    (x) => (x.origin === "sender" ? (x.toKey ?? x.to).toLowerCase() : null),
    MAX_SENDER_REQUESTS_PER_PAYER,
  );
  writeJsonFileAtomic(OUTGOING_REQUESTS_PATH, newestPerGroup(perPayer, (x) => x.origin ?? "owner", MAX_OUTGOING_REQUESTS));
}

/** Payment requests this wallet sent, newest first; throws when the record is unreadable. */
export function listOutgoingRequests(): OutgoingRequest[] {
  return loadOutgoing().sort((a, b) => b.createdAt - a.createdAt);
}

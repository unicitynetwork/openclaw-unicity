/**
 * Money-operation helpers shared by the send, pay, mint and request tools: coin/amount resolution, the ledger
 * reservation that guards against duplicates, and the commit-phase reading of a failed SDK call.
 */

import type { Sphere } from "@unicitylabs/sphere-sdk";
import { ensureRegistryReady, formatAmount, parseHumanAmount, resolveCoin, type CoinInfo } from "../assets.js";
import { toXOnly } from "../identity.js";
import {
  DUPLICATE_WINDOW_MS,
  findBlockingEntry,
  isStillSettling,
  recordIntent,
  recordedSendAmounts,
  type LedgerEntry,
  type SettlingCheck,
} from "../ledger.js";
import { errorMessage, withTimeout } from "../util.js";
import {
  HISTORY_IS_NOT_PROOF,
  duplicateResult,
  errorCause,
  errorCode,
  errorResult,
  isoTime,
  registryNotReadyResult,
  unknownCoinResult,
  type PaymentsApi,
  type ToolResult,
} from "./result.js";

export type PendingTransfer = Awaited<ReturnType<PaymentsApi["pendingTransfers"]>>[number];

export type CoinAmount = { coin: CoinInfo; amount: bigint; human: string };

/** The coin and base-unit amount named by tool params, or the result refusing them. Waits for the token registry. */
export async function resolveCoinAmount(
  coinParam: unknown,
  amountParam: unknown,
  opts?: { excludeClaimed?: boolean },
): Promise<CoinAmount | { refused: ToolResult }> {
  if (typeof amountParam !== "string") {
    return { refused: errorResult("amount must be a decimal string such as \"1.5\".", "invalid_amount") };
  }
  if (!(await ensureRegistryReady())) return { refused: registryNotReadyResult() };
  const coinInput = typeof coinParam === "string" ? coinParam : "";
  const coin = resolveCoin(coinInput);
  if (!coin) return { refused: unknownCoinResult(coinInput, opts) };
  let amount: bigint;
  try {
    amount = parseHumanAmount(amountParam, coin.decimals);
  } catch (err) {
    return { refused: errorResult(errorMessage(err), "invalid_amount") };
  }
  return { coin, amount, human: formatAmount(amount, coin.coinId, coin.decimals, coin.symbol) };
}

/**
 * Reserves a money operation: abort check, duplicate check, intent record. Synchronous on purpose: with no await
 * between findBlockingEntry and recordIntent, two concurrent sessions cannot both pass the duplicate check.
 * Call it after the caller's last await and start the SDK call right after it. An unreadable or unwritable ledger
 * refuses the operation: treating it as empty would drop the record of an earlier possibly-committed payment.
 */
export function reserveMoneyOp(o: {
  op: LedgerEntry["op"];
  key: string;
  /** Other spellings of the same operation (the recipient as typed): an entry under any of them blocks, and the intent records them. */
  aliases?: readonly string[];
  /** What is being done, for a refusal: "send 1.5 UCT to @alice". */
  what: string;
  /** What a refusal guarantees: "nothing was sent". */
  nothingDone: string;
  allowDuplicate: unknown;
  signal?: AbortSignal;
  windowMs?: number;
  /** Keeps an earlier entry that is unresolved or still settling blocking past the window. */
  settling?: SettlingCheck;
  /** Ids of transfers to the same payee that were still settling (see settlingTo), named in a refusal. */
  settlingToPayee?: readonly string[];
  /**
   * A pay: the duplicate-guard key of the send it makes (see LedgerEntry.sendKey). The pay is then also checked as
   * that send, with a send's window, and its intent records the key, so it blocks an identical send in turn.
   */
  sendKey?: string;
}): { intent: LedgerEntry } | { refused: ToolResult } {
  if (o.signal?.aborted) return { refused: errorResult(`Cancelled before it started; ${o.nothingDone}.`, "aborted") };
  try {
    const own = findBlockingEntry(o.op, [o.key, ...(o.aliases ?? [])], o.windowMs ?? DUPLICATE_WINDOW_MS, o.settling);
    const asSend = o.settling && { pendingIds: o.settling.pendingIds };
    const prior = own ?? (o.sendKey !== undefined ? findBlockingEntry("send", [o.sendKey], DUPLICATE_WINDOW_MS, asSend) : null);
    if (prior && o.allowDuplicate !== true) {
      return {
        refused: duplicateResult(prior, o.what, {
          settling: isStillSettling(prior, o.settling),
          pendingUnreadable: o.settling?.pendingIds === null,
          settlingToPayee: o.settlingToPayee,
          identical: prior === own && prior.op === o.op,
        }),
      };
    }
    return { intent: recordIntent(o.op, o.key, o.aliases, o.sendKey) };
  } catch (err) {
    return {
      refused: errorResult(
        `The payment ledger could not be read or written (${errorMessage(err)}); ${o.nothingDone}. ` +
          "Tell the owner to check payment-ledger.json in the plugin data directory.",
        "ledger_unavailable",
      ),
    };
  }
}

/**
 * SDK codes a send (or the send inside pay) throws only before it spends anything: recipient resolution and the
 * spend queue's coin selection (checked against sphere-sdk 0.18.1). Once a leg was delivered, send() wraps any later
 * error in SEND_PARTIALLY_COMPLETED, so these arrive bare only when nothing left the wallet in this call.
 * Deliberately absent: TRANSFER_CONFLICT and VALIDATION_ERROR (also raised by legs inside the transfer machine),
 * transport, wallet-api and storage codes (raised after certification, e.g. a failed intent completion).
 */
const PRE_SPEND_CODES = new Set(["SEND_INSUFFICIENT_BALANCE", "INVALID_RECIPIENT", "SEND_QUEUE_TIMEOUT", "SEND_QUEUE_FULL"]);

const PENDING_READ_TIMEOUT_MS = 3_000;
const PAYEE_RESOLVE_TIMEOUT_MS = 10_000;
const CHAIN_KEY = /^0[23][0-9a-fA-F]{64}$/;

/**
 * x-only key of the payee a send to `recipient` pays, for the duplicate guard, so that '@alice', her 64/66-hex keys
 * and her DIRECT:// address give one key. The SDK pays a 66-hex key as given and resolves anything else to the chain
 * key its binding names; this does the same lookup, with a bounded wait. Null when the lookup fails or finds nothing.
 * Never throws. Only for the guard: the send still goes to the recipient as typed, so the SDK keeps its network check.
 */
export async function payeeKey(sphere: Sphere, recipient: string, timeoutMs = PAYEE_RESOLVE_TIMEOUT_MS): Promise<string | null> {
  if (CHAIN_KEY.test(recipient)) return toXOnly(recipient);
  try {
    const peer = await withTimeout(Promise.resolve().then(() => sphere.resolve(recipient)), timeoutMs, `resolving ${recipient}`);
    return toXOnly(peer?.chainPubkey);
  } catch {
    return null;
  }
}

/**
 * What became of the remainder of a partial send (SEND_PARTIALLY_COMPLETED). Once a leg was delivered, send() wraps
 * ANY failure of a later attempt, possibly-committed ones included, so remainingAmount is the amount that attempt
 * tried to send, not an amount proven unsent. The remainder was not sent only when there is no cause (the re-plan
 * budget ran out before it was tried) or the cause is a pre-spend error; anything else leaves its outcome unknown.
 */
export function remainderOutcome(err: unknown): "not_sent" | "unknown" {
  const cause = errorCause(err);
  if (cause === undefined) return "not_sent";
  const code = errorCode(cause);
  const preSpend = code !== undefined && PRE_SPEND_CODES.has(code) && (cause as { mayHaveCertified?: unknown }).mayHaveCertified !== true;
  return preSpend ? "not_sent" : "unknown";
}

/** The wallet's pending transfers with a bounded wait; null when unreadable. Never throws. */
export async function readPendingTransfers(payments: PaymentsApi, timeoutMs = PENDING_READ_TIMEOUT_MS): Promise<PendingTransfer[] | null> {
  try {
    const pending = await withTimeout(Promise.resolve().then(() => payments.pendingTransfers()), timeoutMs, "pendingTransfers");
    return Array.isArray(pending) ? pending : null;
  } catch {
    return null;
  }
}

/** Ids of the wallet's pending transfers (snapshot taken before a send or pay); null when unreadable. Never throws. */
export async function pendingTransferIds(payments: PaymentsApi, timeoutMs = PENDING_READ_TIMEOUT_MS): Promise<Set<string> | null> {
  return transferIds(await readPendingTransfers(payments, timeoutMs));
}

/** Ids of pending-transfer rows; null for an unreadable read. */
export function transferIds(rows: readonly PendingTransfer[] | null): Set<string> | null {
  return rows && new Set(rows.map((t) => t.transferId));
}

/**
 * Ids of the transfers still settling (open rows, not partial-send shortfalls) to `recipient`, compared as x-only keys:
 * payments to that recipient in progress. Their absence proves nothing (see HISTORY_IS_NOT_PROOF).
 */
export function settlingTo(rows: readonly PendingTransfer[] | null, recipient: unknown): string[] {
  const key = toXOnly(typeof recipient === "string" ? recipient : null);
  if (!rows || !key) return [];
  return rows
    .filter((t) => t.kind !== "shortfall" && typeof t.recipient === "string" && toXOnly(t.recipient) === key)
    .map((t) => t.transferId);
}

/**
 * One line per transfer still settling (open rows; partial-send shortfalls are left out), at most `max`. A row whose
 * intent already completed and only awaits delivery carries no coin or amount (sphere-sdk 0.18.1 journal-only rows);
 * for those the payment ledger names the send the transfer belongs to, else the amount is said to be unrecorded. That
 * send's amount is "part or all" of the transfer's: the SDK splits a partial send over several attempts, each with
 * its own transfer id, and the ledger keeps the full amount under one of them.
 */
export function settlingTransferLines(rows: readonly PendingTransfer[], max: number): string[] {
  const open = rows.filter((t) => t.kind !== "shortfall").slice(0, max);
  const recorded = recordedSendAmounts(open.filter((t) => !t.tokenId && !(t.coinId && t.amount)).map((t) => t.transferId));
  return open.map((t) => {
    const fromLedger = recorded.get(t.transferId);
    const what = t.tokenId
      ? `token ${t.tokenId}`
      : t.coinId && t.amount
        ? formatAmount(t.amount, t.coinId)
        : fromLedger
          ? `part or all of a ${formatAmount(fromLedger.amount, fromLedger.coinId)} payment`
          : t.deliveryPending && t.createdAt === 0
            ? "a completed transfer (amount not recorded by the wallet)"
            : "a transfer (details unreadable)";
    const delivery = t.deliveryPending ? ", delivery pending" : "";
    return `- ${t.transferId}: ${what} to ${t.recipient} (${t.legs.certified}/${t.legs.total} legs certified${delivery})`;
  });
}

/**
 * True only for a failed send/pay that provably moved nothing: a PRE_SPEND_CODES error, and no pending transfer
 * that is not in `before` (ids snapshotted before the call; compared by id, since journal-only rows carry no time).
 * Any other error, or a snapshot or re-read that failed, counts as possibly committed. Never throws.
 */
export async function isCleanMoneyFailure(err: unknown, payments: PaymentsApi, before: Set<string> | null): Promise<boolean> {
  const code = errorCode(err);
  if (code === undefined || !PRE_SPEND_CODES.has(code)) return false;
  if ((err as { mayHaveCertified?: unknown }).mayHaveCertified === true || !before) return false;
  const after = await pendingTransferIds(payments);
  return after !== null && [...after].every((id) => before.has(id));
}

/** What a failed send/pay call left of its own payment: the remainder's outcome (remainderOutcome) and base-unit amount. */
export type CallRemainder = { outcome: "not_sent" | "unknown"; amount: string };

/**
 * Labels for the shortfall rows (partial sends) of pendingTransfers(). sphere-sdk 0.18.1 removes a shortfall row only
 * when the send that wrote it finishes, so the row of a send that threw stays listed for good, also once the remainder
 * was paid separately: no row is ever called owed. Only rows the call itself wrote (not in `before`; none when that
 * snapshot is null) are tied to its payment: the newest with the remainder's amount is that remainder, and older ones
 * were superseded by a later attempt of the same send. Rows from before the call older than the duplicate window are
 * left out (they carry no news).
 */
function shortfallLines(rows: PendingTransfer[], before: Set<string> | null, remainder: CallRemainder | undefined): string[] {
  const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
  const listed = rows
    .filter((t) => !(before?.has(t.transferId) && t.createdAt < cutoff))
    .sort((a, b) => b.createdAt - a.createdAt);
  const own = (t: PendingTransfer) => before !== null && !before.has(t.transferId);
  const current = remainder && listed.find((t) => own(t) && t.amount === remainder.amount);
  const sameRun = (t: PendingTransfer) =>
    !!current && own(t) && t.recipient === current.recipient && t.coinId === current.coinId && t.createdAt <= current.createdAt;
  return listed.slice(0, 5).map((t) => {
    const label = t === current
      ? remainder?.outcome === "not_sent" ? "this payment's unsent remainder" : "remainder attempted again, outcome unknown"
      : sameRun(t)
        ? "superseded by a later attempt of this payment"
        : "may have been paid separately since";
    return `- ${t.transferId}: ${formatAmount(t.amount, t.coinId)} to ${t.recipient}, shortfall of a partial send at ${isoTime(t.createdAt)} (${label})`;
  });
}

/**
 * The wallet's pendingTransfers() for a result that may have moved money, with a bounded wait; "" when none or
 * unreadable. Never throws. Open transfers are listed as still settling, shortfalls of partial sends apart (see
 * shortfallLines). `before`: transfer ids snapshotted before the call (null when unreadable). `remainder`: the call
 * was a partial send.
 */
export async function pendingTransfersNote(
  payments: PaymentsApi,
  opts?: { timeoutMs?: number; before?: Set<string> | null; remainder?: CallRemainder },
): Promise<string> {
  const pending = await readPendingTransfers(payments, opts?.timeoutMs ?? PENDING_READ_TIMEOUT_MS);
  if (!pending?.length) return "";
  try {
    const settling = settlingTransferLines(pending, 5);
    const shortfalls = shortfallLines(pending.filter((t) => t.kind === "shortfall"), opts?.before ?? null, opts?.remainder);
    const blocks: string[] = [];
    if (settling.length) blocks.push(`Transfers still settling:\n${settling.join("\n")}`);
    if (shortfalls.length) {
      blocks.push(
        "Partial sends the wallet still lists. It keeps listing a partial send after that send ended, also once its remainder " +
          `was paid separately, so these are NOT proof that anything remains unpaid. ${HISTORY_IS_NOT_PROOF} ` +
          `Ask the owner before paying any of it:\n${shortfalls.join("\n")}`,
      );
    }
    return blocks.length ? `\n${blocks.join("\n\n")}` : "";
  } catch {
    return "";
  }
}

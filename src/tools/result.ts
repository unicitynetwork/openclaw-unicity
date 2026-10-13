/** Shared tool-result helpers: success/error/possibly-committed shapes, SDK error reading, wallet access and sender labels. */

import type { GroupChatModule, Sphere } from "@unicitylabs/sphere-sdk";
import { getAvailableSymbols } from "../assets.js";
import { API_KEY_HINT } from "../config.js";
import { claimedNameSuffix, sanitizeNametagClaim, type NameVerifier } from "../identity.js";
import type { LedgerEntry } from "../ledger.js";
import { withTimeout } from "../util.js";

export { errorMessage } from "../util.js";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

export type PaymentsApi = Sphere["payments"];

/** Keys OpenClaw reads to grade a tool result as failed; never allowed in success or possibly-committed details. */
const GRADING_KEYS = ["status", "success", "error", "ok", "timedOut", "exitCode"];

function withoutGradingKeys(details: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...details };
  for (const key of GRADING_KEYS) delete out[key];
  return out;
}

export function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details: withoutGradingKeys(details) };
}

/** Clean failure (nothing happened); graded as a failed tool call. */
export function errorResult(text: string, code: string, extra?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details: { ...withoutGradingKeys(extra), status: "error", code } };
}

/** Possibly-committed money op: details {outcome:"possibly_committed", transferId?} — NO status/error keys; text says DO NOT RETRY. */
export function possiblyCommittedResult(text: string, extra?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details: { ...withoutGradingKeys(extra), outcome: "possibly_committed" } };
}

/**
 * What the transaction history can and cannot show about an earlier payment. sphere-sdk 0.18.1 writes a SENT row only
 * after a transfer completes, best effort and never retried, so a transfer still settling, or one whose completion
 * failed after it was delivered, has none.
 */
export const HISTORY_IS_NOT_PROOF =
  "A SENT row in unicity_get_transaction_history, or a transfer it lists as still settling, shows a payment that went out " +
  "or is in progress; their absence does NOT show that nothing went out (the wallet records a transfer only after it " +
  "completes, and only best effort).";

/**
 * Refusal of a money operation identical to one the ledger recorded. `settling`: its transfer is still pending;
 * `pendingUnreadable`: the pending transfers could not be read to check that; `settlingToPayee`: ids of transfers to
 * the same payee that are still settling (see settlingTo in money.ts); `identical: false`: the recorded one is another
 * operation that paid the same payee the same amount (a send, or the payment of a request).
 */
export function duplicateResult(
  prior: LedgerEntry,
  what: string,
  opts?: { settling?: boolean; pendingUnreadable?: boolean; settlingToPayee?: readonly string[]; identical?: boolean },
): ToolResult {
  const state = prior.state === "done"
    ? "completed"
    : prior.state === "possibly_committed" ? "attempted and may have gone through" : "started (outcome unknown)";
  // A partial send's transfer stays listed (as its shortfall) after the delivered part settled: promise nothing more.
  const ref = !prior.transferId
    ? ""
    : opts?.settling
      ? prior.note === "SEND_PARTIALLY_COMPLETED"
        ? ` (transfer ${prior.transferId} was only partly delivered; the delivered part is final)`
        : ` (transfer ${prior.transferId} is still settling and will complete automatically)`
      : prior.deliveryPending && opts?.pendingUnreadable
        ? ` (transfer ${prior.transferId}; its delivery to the recipient was still pending, and the wallet's pending transfers ` +
          "could not be read to check whether it still is)"
        : ` (transfer ${prior.transferId})`;
  const others = (opts?.settlingToPayee ?? []).filter((id) => id !== prior.transferId);
  const inProgress = others.length
    ? ` Transfer${others.length > 1 ? "s" : ""} ${others.join(", ")} to the same recipient ${others.length > 1 ? "are" : "is"} ` +
      "still settling (a payment in progress)."
    : "";
  const identical = opts?.identical !== false;
  // The SDK reverts a request to pending after a pay() error it considers clean, also when the plugin does not.
  const reverted = prior.op === "pay" && prior.state !== "done";
  const unresolved = prior.state !== "done";
  const why = !identical
    ? " Paying a request sends its amount to the requester, so this would pay the same payee the same amount again." +
      (unresolved
        ? ` ${HISTORY_IS_NOT_PROOF} Tell the owner that the wallet cannot rule out that the payee already has this amount ` +
          "and that only the payee can confirm what arrived."
        : "")
    : reverted
      ? " The wallet may list the request as pending again only because it reverted the request after that error; the earlier " +
        `attempt may still have paid it. ${HISTORY_IS_NOT_PROOF} Tell the owner that the wallet cannot rule out an earlier ` +
        "payment and that only the requester can confirm what arrived."
      : "";
  const confirm = reverted || !identical
    ? "Only if the owner explicitly confirms paying again, knowing this, call again with allowDuplicate: true."
    : "Only if the owner explicitly confirms they want it again, call again with allowDuplicate: true.";
  const earlier = prior.op === "pay" ? `the payment of request ${prior.key}` : "a send of the same coin and amount to the same payee";
  const head = identical
    ? `an identical operation (${what}) was already ${state}`
    : `${what} would repeat ${earlier}, which was already ${state}`;
  return errorResult(`NOT DONE: ${head} at ${isoTime(prior.at)}${ref}.${inProgress}${why} Do not retry. ${confirm}`, "duplicate", {
    previous: {
      state: prior.state,
      at: prior.at,
      transferId: prior.transferId,
      ...(prior.op === "pay" ? { requestId: prior.key } : {}),
      ...(opts?.settling ? { settling: true } : {}),
    },
    ...(others.length ? { settlingToRecipient: others } : {}),
  });
}

/** SDK error code read structurally: provider bundles throw their own SphereError class copies. */
export function errorCode(err: unknown): string | undefined {
  const code = err !== null && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

export function registryNotReadyResult(): ToolResult {
  return errorResult("The token registry has not loaded yet, so coins cannot be resolved. Try again shortly.", "registry_not_ready");
}

export function unknownCoinResult(coin: string, opts?: { excludeClaimed?: boolean }): ToolResult {
  const available = getAvailableSymbols(opts).join(", ") || "(none loaded)";
  return errorResult(`Unknown coin "${coin}". Available coins: ${available}.`, "unknown_coin");
}

/** The error an SDK error wraps (SphereError.cause), read structurally; undefined when there is none. */
export function errorCause(err: unknown): unknown {
  return err !== null && typeof err === "object" ? (err as { cause?: unknown }).cause : undefined;
}

/** The possibly-committed error's transfer id (SphereError.transferId, PartialSendConflictError.transferId). */
export function errorTransferId(err: unknown): string | undefined {
  const id = err !== null && typeof err === "object" ? (err as { transferId?: unknown }).transferId : undefined;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** PartialSendConflictError.remainingAmount (base-unit digit string), read structurally. */
export function errorRemainingAmount(err: unknown): string | undefined {
  if (errorCode(err) !== "SEND_PARTIALLY_COMPLETED") return undefined;
  const amount = (err as { remainingAmount?: unknown }).remainingAmount;
  return typeof amount === "string" && /^\d+$/.test(amount) ? amount : undefined;
}

/** Tool result for a call that arrives while the wallet is still starting. */
export function walletNotReadyResult(): ToolResult {
  return errorResult("The Unicity wallet is not ready yet (still starting). Try again shortly.", "wallet_not_ready");
}

/** What a payment tool says on a messaging-only wallet: why, and how to enable payments. */
export const PAYMENTS_DISABLED_TEXT =
  `Payments are disabled: no Unicity API key is configured, so the wallet runs messaging-only. To enable them, ${API_KEY_HINT}.`;

/** The wallet and its payments API, or the tool result explaining why they are unavailable (never throws). */
export function walletPayments(sphere: Sphere | null): { sphere: Sphere; payments: PaymentsApi } | { unavailable: ToolResult } {
  if (!sphere) return { unavailable: walletNotReadyResult() };
  const messagingOnly = errorResult(PAYMENTS_DISABLED_TEXT, "payments_unavailable");
  if (!sphere.hasPayments) return { unavailable: messagingOnly };
  try {
    return { sphere, payments: sphere.payments };
  } catch (err) {
    return { unavailable: errorCode(err) === "PAYMENTS_NOT_COMPOSED" ? messagingOnly : walletNotReadyResult() };
  }
}

/** The wallet and its group-chat module, or the tool result explaining why they are unavailable (never throws). */
export function walletGroupChat(
  sphere: Sphere | null,
): { sphere: Sphere; groupChat: GroupChatModule } | { unavailable: ToolResult } {
  if (!sphere) return { unavailable: walletNotReadyResult() };
  const groupChat = sphere.groupChat;
  if (!groupChat) {
    return { unavailable: errorResult("Group chat is disabled (plugin config groupChat: false).", "group_chat_disabled") };
  }
  return { sphere, groupChat };
}

/** ISO time for a millisecond timestamp from wallet data; a missing or invalid one does not break the listing. */
export function isoTime(ms: unknown): string {
  const date = new Date(typeof ms === "number" ? ms : Number.NaN);
  return Number.isNaN(date.getTime()) ? "unknown time" : date.toISOString();
}

/** Text written by another party, capped at `max` characters and JSON-quoted (escapes quotes and control characters). */
export function quoteJson(text: string, max: number): string {
  return JSON.stringify(text.length > max ? `${text.slice(0, max)}…` : text);
}

/** How long a tool waits for a name lookup; a slower one reads as unverified. */
const NAME_VERIFY_TIMEOUT_MS = 5_000;

/**
 * A sender's authenticated key with the name it claims (text the sender chose): "@name (verified, <shown>)" only when
 * the name forward-resolves to that key within NAME_VERIFY_TIMEOUT_MS, else "<shown> (claims @name, unverified)", or
 * "<shown>" without a valid claim. A failed or slow lookup reads as unverified. `shown` is how the key is printed
 * (default: in full). Never throws.
 */
export async function senderLabel(names: NameVerifier, key: string, claimed: unknown, shown = key): Promise<string> {
  const claim = sanitizeNametagClaim(claimed);
  if (!claim) return shown;
  let verified = false;
  try {
    verified = (await withTimeout(names.verify(claim, key), NAME_VERIFY_TIMEOUT_MS, "nametag verification")).verified === claim;
  } catch {
    // unverified
  }
  return verified ? `@${claim} (verified, ${shown})` : `${shown}${claimedNameSuffix(claim)}`;
}

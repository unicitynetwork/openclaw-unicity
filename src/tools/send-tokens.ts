/** Agent tool: unicity_send_tokens — transfer tokens to a recipient. */

import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { getSphereOrNull } from "../sphere.js";
import { formatAmount, type CoinInfo } from "../assets.js";
import { paymentKey, recordPossiblyCommitted, settle } from "../ledger.js";
import { validateRecipient } from "../validation.js";
import {
  isCleanMoneyFailure,
  payeeKey,
  pendingTransfersNote,
  readPendingTransfers,
  remainderOutcome,
  reserveMoneyOp,
  resolveCoinAmount,
  settlingTo,
  transferIds,
} from "./money.js";
import {
  HISTORY_IS_NOT_PROOF,
  errorCause,
  errorCode,
  errorMessage,
  errorRemainingAmount,
  errorResult,
  errorTransferId,
  possiblyCommittedResult,
  textResult,
  walletPayments,
} from "./result.js";

type SendParams = { recipient?: unknown; amount?: unknown; coin?: unknown; memo?: unknown; allowDuplicate?: unknown };

/** Why a clean failure (one of the money.ts pre-spend codes) happened, in words the owner can act on. */
function cleanFailureText(err: unknown, coin: CoinInfo, recipient: string): string {
  switch (errorCode(err)) {
    case "SEND_INSUFFICIENT_BALANCE":
      return coin.claimed
        ? `insufficient spendable ${coin.symbol} (${coin.symbol} received by this wallet stays pending verification and cannot be spent)`
        : `insufficient ${coin.symbol} balance`;
    case "INVALID_RECIPIENT":
      return `recipient "${recipient}" could not be resolved on this network`;
    default:
      return `${errorCode(err)}: ${errorMessage(err)}`;
  }
}

export const sendTokensTool: AnyAgentTool = {
  name: "unicity_send_tokens",
  label: "Send Tokens",
  description:
    "Send tokens from the agent wallet to a recipient (@nametag, 64/66-hex public key, or DIRECT:// address). Irreversible. " +
    "Owner only (enforced by the plugin): send only when the wallet owner explicitly asks. " +
    "If a result says the payment MAY have been sent, never call this tool again for that payment. " +
    "An identical payment (same coin, amount and payee; paying a payment request counts as a payment to its requester) " +
    "within 15 minutes, or while an identical earlier one is still settling, is refused unless allowDuplicate is true; " +
    "set it only when the owner explicitly confirms a second identical payment.",
  parameters: Type.Object({
    recipient: Type.String({ description: "@nametag, 64/66-hex public key, or DIRECT:// address" }),
    amount: Type.String({ description: "Amount in whole coins as a decimal string, e.g. \"1.5\"" }),
    coin: Type.String({ description: "Coin symbol or name, e.g. UCT, BTC, USDU" }),
    memo: Type.Optional(Type.String({ description: "Optional memo delivered with the transfer" })),
    allowDuplicate: Type.Optional(Type.Boolean({ description: "The owner explicitly confirmed a second identical payment" })),
  }),
  executionMode: "sequential",
  async execute(_toolCallId, rawParams, signal) {
    const p = (rawParams ?? {}) as SendParams;
    const recipient = typeof p.recipient === "string" ? p.recipient.trim() : "";
    try {
      validateRecipient(recipient);
    } catch (err) {
      return errorResult(errorMessage(err), "invalid_recipient");
    }
    const wallet = walletPayments(getSphereOrNull());
    if ("unavailable" in wallet) return wallet.unavailable;
    const params = await resolveCoinAmount(p.coin, p.amount);
    if ("refused" in params) return params.refused;
    const { coin, amount, human } = params;
    // Duplicate-guard keys: the payee's key, so every spelling of the same payee matches, and the recipient as typed.
    // A payee that cannot be looked up is refused: keyed only as typed, the guard would miss an earlier send of this
    // payment under another spelling, while the SDK's own lookup a moment later may succeed and pay it again.
    const payee = await payeeKey(wallet.sphere, recipient);
    if (payee === null && p.allowDuplicate !== true) {
      return errorResult(
        `Payment NOT sent: could not look up ${recipient} (not found on this network, or the lookup failed or timed out), ` +
          "so it cannot be checked against earlier payments. Nothing left the wallet. Check the recipient and try again shortly.",
        "payee_lookup_failed",
      );
    }
    const keysFor = (value: bigint) => ({
      key: paymentKey(payee ?? recipient, coin.coinId, value),
      aliases: [paymentKey(recipient, coin.coinId, value)],
    });
    const pendingBefore = await readPendingTransfers(wallet.payments);
    const before = transferIds(pendingBefore);

    const current = walletPayments(getSphereOrNull());
    if ("unavailable" in current) return current.unavailable;
    const reserved = reserveMoneyOp({
      op: "send",
      ...keysFor(amount),
      what: `send ${human} to ${recipient}`,
      nothingDone: "nothing was sent",
      allowDuplicate: p.allowDuplicate,
      signal,
      settling: { pendingIds: before },
      settlingToPayee: settlingTo(pendingBefore, payee),
    });
    if ("refused" in reserved) return reserved.refused;
    const { intent } = reserved;

    // Commit phase: never throw, and never hand the abort signal to the SDK (an abort cannot cancel a send in flight).
    try {
      const result = await current.payments.send({
        recipient,
        amount: amount.toString(),
        coinId: coin.coinId,
        ...(typeof p.memo === "string" && p.memo ? { memo: p.memo } : {}),
      });
      settle(intent.id, "done", { transferId: result.id, ...(result.deliveryPending ? { deliveryPending: true } : {}) });
      const delivery = result.deliveryPending
        ? " It is certified on-chain; delivery to the recipient is still pending and completes automatically — do not send it again."
        : "";
      return textResult(`Sent ${human} to ${recipient}. Transfer ${result.id} (status: ${result.status}).${delivery}`, {
        outcome: "sent",
        transferId: result.id,
        transferStatus: result.status,
        deliveryPending: result.deliveryPending === true,
        recipient,
        coinId: coin.coinId,
        amount: amount.toString(),
      });
    } catch (err) {
      const code = errorCode(err) ?? "UNKNOWN";
      if (await isCleanMoneyFailure(err, current.payments, before)) {
        settle(intent.id, "failed", { note: code });
        return errorResult(`Payment NOT sent: ${cleanFailureText(err, coin, recipient)}. Nothing left the wallet.`, code);
      }
      const transferId = errorTransferId(err);
      settle(intent.id, "possibly_committed", { transferId, note: code });
      const ref = `Transfer ${transferId ?? "(id unknown)"}`;
      const details = { transferId, code, recipient, coinId: coin.coinId, amount: amount.toString() };
      const remaining = errorRemainingAmount(err);
      if (remaining === undefined) {
        const text =
          `PAYMENT MAY HAVE BEEN SENT — DO NOT RETRY. Sending ${human} to ${recipient} did not finish cleanly (${code}: ${errorMessage(err)}) ` +
          `and the funds may already have left the wallet. ${ref} settles automatically. ` +
          "Do NOT call unicity_send_tokens again for this payment. Tell the owner it is pending; a missing SENT row in " +
          "unicity_get_transaction_history later does NOT show that it failed.";
        return possiblyCommittedResult(text + (await pendingTransfersNote(current.payments, { before })), details);
      }

      const outcome = remainderOutcome(err);
      const cause = errorCause(err);
      const causeCode = errorCode(cause);
      const why = cause === undefined ? errorMessage(err) : `${causeCode ?? "UNKNOWN"}: ${errorMessage(cause)}`;
      const left = formatAmount(remaining, coin.coinId, coin.decimals, coin.symbol);
      let text: string;
      if (outcome === "not_sent") {
        text =
          `PAYMENT PARTIALLY SENT — DO NOT RETRY THE FULL AMOUNT. Part of the ${human} payment to ${recipient} was sent and is final; ` +
          `${left} could not be sent (${why}). ${ref}. ` +
          "Do NOT call unicity_send_tokens again for the full amount. Tell the owner; only if they explicitly ask, send the remainder as a new payment.";
      } else {
        // The SDK attempted the remainder too, and that attempt may still deliver it: guard a re-send of it as well.
        const { key, aliases } = keysFor(BigInt(remaining));
        recordPossiblyCommitted("send", key, {
          aliases,
          transferId: errorTransferId(cause),
          note: `remainder of ${transferId ?? "a partial send"}`,
        });
        text =
          `PAYMENT PARTIALLY SENT — DO NOT RETRY. Part of the ${human} payment to ${recipient} was sent and is final. ` +
          `The remaining ${left} was also attempted and its outcome is UNKNOWN (${why}): ` +
          `a transfer that is still settling may deliver it. ${ref}. ` +
          "Do NOT send the remainder or the full amount again. Tell the owner that the remainder may already have been paid " +
          `and the wallet cannot rule that out. ${HISTORY_IS_NOT_PROOF} Only the recipient can confirm what arrived; ` +
          "send the remainder again only if the owner explicitly confirms that, knowing this.";
      }
      const note = await pendingTransfersNote(current.payments, { before, remainder: { outcome, amount: remaining } });
      return possiblyCommittedResult(text + note, {
        ...details,
        remainingAmount: remaining,
        remainderOutcome: outcome,
        ...(causeCode !== undefined ? { causeCode } : {}),
      });
    }
  },
};

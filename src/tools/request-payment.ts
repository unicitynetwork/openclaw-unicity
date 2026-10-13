/** Agent tool: unicity_request_payment — ask someone to pay this wallet. */

import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { PeerInfo, Sphere } from "@unicitylabs/sphere-sdk";
import { getSphereOrNull } from "../sphere.js";
import { bindingKey } from "../identity.js";
import { paymentKey, recordOutgoingRequest, settle } from "../ledger.js";
import { SENDER_SCOPED_FLAG_PARAM } from "../owner-gate.js";
import { withTimeout } from "../util.js";
import { validateRecipient } from "../validation.js";
import { reserveMoneyOp, resolveCoinAmount } from "./money.js";
import { errorCode, errorMessage, errorResult, possiblyCommittedResult, textResult, walletPayments } from "./result.js";

type RequestParams = { recipient?: unknown; amount?: unknown; coin?: unknown; message?: unknown; allowDuplicate?: unknown };

const CHAIN_KEY = /^0[23][0-9a-fA-F]{64}$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const RESOLVE_TIMEOUT_MS = 15_000;

/**
 * The 66-hex chain key to address the request to, or null when the recipient has no self-consistent binding.
 * The SDK takes a 66-hex key verbatim but resolves anything else through a binding whose chain key the author only
 * asserts, which would let any sender redirect "a request to me" to a third party. So the key is pinned here: the
 * binding's chain key must belong to the key that signed it (and to the 64-hex key asked for, when one was given).
 */
async function requestTargetKey(sphere: Sphere, recipient: string): Promise<string | null> {
  if (CHAIN_KEY.test(recipient)) return recipient.toLowerCase();
  const xOnly = HEX64.test(recipient) ? recipient.toLowerCase() : null;
  let peer: PeerInfo | null;
  try {
    peer = await withTimeout(sphere.resolve(xOnly ?? recipient), RESOLVE_TIMEOUT_MS, `resolving ${recipient}`);
  } catch {
    return null;
  }
  const key = bindingKey(peer);
  if (!peer || !key || !CHAIN_KEY.test(peer.chainPubkey) || (xOnly !== null && key !== xOnly)) return null;
  return peer.chainPubkey.toLowerCase();
}

export const requestPaymentTool: AnyAgentTool = {
  name: "unicity_request_payment",
  label: "Request Payment",
  description:
    "Send a payment request asking a recipient (@nametag, 64/66-hex public key, or DIRECT:// address) to pay this wallet. " +
    "When someone other than the owner is talking, the plugin always addresses the request to that sender. " +
    "An identical request within 15 minutes is refused unless allowDuplicate is true.",
  parameters: Type.Object({
    recipient: Type.String({ description: "Who should pay: @nametag, 64/66-hex public key, or DIRECT:// address" }),
    amount: Type.String({ description: "Amount in whole coins as a decimal string, e.g. \"1.5\"" }),
    coin: Type.String({ description: "Coin symbol or name, e.g. UCT, BTC, USDU" }),
    message: Type.Optional(Type.String({ description: "Optional message shown to the payer" })),
    allowDuplicate: Type.Optional(Type.Boolean({ description: "Send a second identical request on purpose" })),
  }),
  executionMode: "sequential",
  async execute(_toolCallId, rawParams, signal) {
    const p = (rawParams ?? {}) as RequestParams;
    // Set by the owner gate (never by the model): true when a non-owner asks for a request to themselves.
    const senderScoped = (rawParams as Record<string, unknown> | undefined)?.[SENDER_SCOPED_FLAG_PARAM] === true;
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
    const memo = typeof p.message === "string" && p.message ? p.message : undefined;
    const toKey = await requestTargetKey(wallet.sphere, recipient);
    if (!toKey) {
      return errorResult(
        `Payment request NOT sent: ${recipient} has no self-consistent published Unicity key (its binding is missing, ` +
          "could not be looked up, or names a key that does not belong to it).",
        "invalid_recipient",
      );
    }

    const current = walletPayments(getSphereOrNull());
    if ("unavailable" in current) return current.unavailable;
    const reserved = reserveMoneyOp({
      op: "request",
      key: paymentKey(toKey, coin.coinId, amount),
      what: `request ${human} from ${recipient}`,
      nothingDone: "nothing was sent",
      allowDuplicate: p.allowDuplicate,
      signal,
    });
    if ("refused" in reserved) return reserved.refused;
    const { intent } = reserved;

    let created: { success: boolean; requestId?: string; error?: string };
    try {
      created = await current.payments.requests.create(toKey, {
        coinId: coin.coinId,
        amount: amount.toString(),
        ...(memo ? { memo } : {}),
      });
    } catch (err) {
      created = { success: false, error: `${errorCode(err) ?? "error"}: ${errorMessage(err)}` };
    }
    if (!created.success || !created.requestId) {
      // Every check create() makes before its POST (pinned key, positive amount) already passed, and it flattens the
      // HTTP status into the message: a refused POST looks the same as one that timed out after the server stored it.
      settle(intent.id, "possibly_committed", { note: created.error });
      return possiblyCommittedResult(
        `PAYMENT REQUEST OUTCOME UNKNOWN — DO NOT RE-SEND. Requesting ${human} from ${recipient} failed after it may have ` +
          `reached the server (${created.error ?? "unknown error"}), so the payer may already have it. It is not in the local ` +
          "list of sent requests. Only if the owner explicitly confirms, call again with allowDuplicate: true.",
        { recipient, coinId: coin.coinId, amount: amount.toString() },
      );
    }
    const requestId = created.requestId;
    settle(intent.id, "done", { note: requestId });
    let saved = "";
    try {
      recordOutgoingRequest({
        requestId,
        to: recipient,
        toKey,
        coinId: coin.coinId,
        amount: amount.toString(),
        memo,
        createdAt: Date.now(),
        origin: senderScoped ? "sender" : "owner",
      });
    } catch (err) {
      saved = ` (It could not be saved to the local list of sent requests: ${errorMessage(err)}.)`;
    }
    return textResult(`Payment request sent to ${recipient} for ${human}. Request id: ${requestId}.${saved}`, {
      outcome: "requested",
      requestId,
      recipient,
      recipientKey: toKey,
      coinId: coin.coinId,
      amount: amount.toString(),
    });
  },
};

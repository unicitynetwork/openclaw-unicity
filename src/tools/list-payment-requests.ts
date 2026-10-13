/** Agent tool: unicity_list_payment_requests — incoming requests (from the SDK) and requests this wallet sent (local record). */

import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { PaymentRequestView } from "@unicitylabs/sphere-sdk/payments-v2";
import { getNameVerifier, getSphereOrNull } from "../sphere.js";
import { ensureRegistryReady, formatAmount } from "../assets.js";
import { latestPayAttempts, listOutgoingRequests, type LedgerEntry, type OutgoingRequest } from "../ledger.js";
import { readPendingTransfers, settlingTo, type PendingTransfer } from "./money.js";
import {
  HISTORY_IS_NOT_PROOF,
  PAYMENTS_DISABLED_TEXT,
  errorMessage,
  errorResult,
  isoTime,
  quoteJson,
  senderLabel,
  textResult,
  walletPayments,
} from "./result.js";

type Direction = "incoming" | "outgoing" | "all";
type StatusFilter = "pending" | "settling" | "paid" | "rejected" | "expired" | "sent";

/** Request messages are written by the other party: quoted, escaped and capped. */
function quoted(text: string | undefined): string {
  return text ? ` | message: ${quoteJson(text, 200)}` : "";
}

/** The recorded attempt to pay a payable request, if any. */
function payAttempt(r: PaymentRequestView, attempts: Map<string, LedgerEntry> | null): LedgerEntry | undefined {
  return r.status === "pending" && attempts ? (attempts.get(r.id) ?? attempts.get(r.requestId)) : undefined;
}

/**
 * Warning for a payable request this wallet already tried to pay. The SDK reverts a request to pending after a pay()
 * error it considers clean, also when the plugin recorded that payment as possibly committed. Transfers still settling
 * to the requester are named as evidence that money is on its way.
 */
function payAttemptWarning(r: PaymentRequestView, e: LedgerEntry, pending: PendingTransfer[] | null): string {
  const transfer = e.transferId ? `, transfer ${e.transferId}` : "";
  const settling = settlingTo(pending, r.senderPubkey);
  const onTheWay = settling.length
    ? `; transfer${settling.length > 1 ? "s" : ""} ${settling.join(", ")} to this requester ${settling.length > 1 ? "are" : "is"} still settling`
    : "";
  return (
    ` | WARNING: a payment attempt for this request was recorded at ${isoTime(e.at)} (${e.state}${transfer}) and may already ` +
    `have gone through; do NOT pay it again${onTheWay}`
  );
}

/** Said once below the incoming requests when any of them carries a WARNING. */
const WARNING_NOTE =
  `\nA WARNING means this wallet may already have paid that request. ${HISTORY_IS_NOT_PROOF} Tell the owner that the ` +
  "wallet cannot rule out an earlier payment and that only the requester can confirm what arrived; pay such a request again " +
  "(allowDuplicate: true) only if the owner explicitly confirms that, knowing this.";

/** The local record of sent requests, as listing lines or the reason it cannot be read. */
function outgoingSection(): string {
  let sent: OutgoingRequest[];
  try {
    sent = listOutgoingRequests();
  } catch (err) {
    return `Outgoing: the local list of sent requests cannot be read (${errorMessage(err)}).`;
  }
  const lines = sent.map((r) => {
    const to = r.toKey && r.toKey !== r.to ? `${r.to} (${r.toKey})` : r.to;
    const origin = r.origin === "sender" ? " | asked for by the payer in a DM, not by the owner" : "";
    return `- ${r.requestId} | ${formatAmount(r.amount, r.coinId)} | to ${to} | sent | ${isoTime(r.createdAt)}${origin}${quoted(r.memo)}`;
  });
  return lines.length ? `Outgoing (${lines.length}):\n${lines.join("\n")}` : "Outgoing: none";
}

export const listPaymentRequestsTool: AnyAgentTool = {
  name: "unicity_list_payment_requests",
  label: "List Payment Requests",
  description:
    "List payment requests: incoming (others asking this wallet to pay; status pending, settling, paid, rejected or expired) " +
    "and outgoing (requests this wallet sent; status sent; those a payer asked for in a DM are marked). " +
    "Prints full request ids: pass them unchanged to unicity_respond_payment_request. " +
    "The public key identifies the requester. A requester's name is shown as @name (verified, <key>) only when it resolves " +
    "to the requester's key; a name shown as (claims @name, unverified) may be forged. " +
    "A WARNING on a pending request means this wallet already recorded an attempt to pay it: do not pay it again. " +
    "Owner only (enforced by the plugin).",
  parameters: Type.Object({
    direction: Type.Optional(
      Type.Union([Type.Literal("incoming"), Type.Literal("outgoing"), Type.Literal("all")], {
        description: "Which requests to list (default: all)",
      }),
    ),
    status: Type.Optional(
      Type.Union(
        [
          Type.Literal("pending"),
          Type.Literal("settling"),
          Type.Literal("paid"),
          Type.Literal("rejected"),
          Type.Literal("expired"),
          Type.Literal("sent"),
        ],
        { description: "Only requests with this status ('sent' = outgoing requests)" },
      ),
    ),
  }),
  resultContentSource: "network",
  async execute(_toolCallId, rawParams) {
    const p = (rawParams ?? {}) as { direction?: Direction; status?: StatusFilter };
    const direction = p.direction ?? "all";
    const status = p.status;
    const wantIncoming = direction !== "outgoing" && status !== "sent";
    const wantOutgoing = direction !== "incoming" && (!status || status === "sent");
    const sphere = getSphereOrNull();
    const wallet = wantIncoming ? walletPayments(sphere) : null;
    if (wallet && "unavailable" in wallet) return wallet.unavailable;
    await ensureRegistryReady();
    const sections: string[] = [];

    if (wallet) {
      const attempts = latestPayAttempts();
      const unreadable = (err: unknown) => errorResult(`Could not read payment requests: ${errorMessage(err)}`, "requests_unavailable");
      let requests: PaymentRequestView[];
      let attempted: boolean;
      try {
        requests = wallet.payments.requests.list().filter((r) => !status || r.status === status);
        attempted = requests.some((r) => payAttempt(r, attempts));
      } catch (err) {
        return unreadable(err);
      }
      const pending = attempted ? await readPendingTransfers(wallet.payments) : null;
      const names = getNameVerifier();
      let lines: string[];
      try {
        // Concurrent and each bounded, so names hold the listing up for one lookup timeout at most.
        const from = await Promise.all(requests.map((r) => senderLabel(names, r.senderPubkey, r.senderNametag)));
        lines = requests.map((r, i) => {
          const attempt = payAttempt(r, attempts);
          return (
            `- ${r.id} | ${formatAmount(r.amount, r.coinId)} | from ${from[i]} | ` +
            `${r.status} | ${isoTime(r.timestamp)}${attempt ? payAttemptWarning(r, attempt, pending) : ""}${quoted(r.message)}`
          );
        });
      } catch (err) {
        return unreadable(err);
      }
      const note = !attempts
        ? "\nRecorded payment attempts could not be checked (payment-ledger.json is unreadable), so this wallet may already have " +
          `paid any pending request above. ${HISTORY_IS_NOT_PROOF} unicity_respond_payment_request refuses to pay while the ` +
          "ledger is unreadable; tell the owner to check payment-ledger.json in the plugin data directory."
        : attempted ? WARNING_NOTE : "";
      sections.push(
        (lines.length
          ? `Incoming (${lines.length}):\n${lines.join("\n")}`
          : "Incoming: none (requests sync shortly after the wallet starts; check again in a minute if one is expected).") + note,
      );
    }

    if (wantOutgoing) sections.push(outgoingSection());
    // The sent list is a local record, readable without payments; still say that they are off.
    if (!wallet && sphere && !sphere.hasPayments) sections.push(PAYMENTS_DISABLED_TEXT);

    return textResult(sections.join("\n\n") || "No payment requests match these filters.", {
      direction,
      ...(status ? { statusFilter: status } : {}),
    });
  },
};

/** Agent tool: unicity_list_payment_requests — view incoming/outgoing payment requests. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";
import { getCoinDecimals, getCoinSymbol, toHumanReadable } from "../assets.js";

export const listPaymentRequestsTool = {
  name: "unicity_list_payment_requests",
  description:
    "List payment requests — incoming (others requesting payment from you), outgoing (your requests to others), or all. " +
    "OWNER ONLY: never use when IsOwner is false.",
  parameters: Type.Object({
    direction: Type.Optional(
      Type.Union([
        Type.Literal("incoming"),
        Type.Literal("outgoing"),
        Type.Literal("all"),
      ], { description: "Filter direction (default: all)" }),
    ),
    status: Type.Optional(
      Type.Union([
        Type.Literal("pending"),
        Type.Literal("accepted"),
        Type.Literal("rejected"),
        Type.Literal("paid"),
        Type.Literal("expired"),
      ], { description: "Filter by status" }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: {
      direction?: "incoming" | "outgoing" | "all";
      status?: "pending" | "accepted" | "rejected" | "paid" | "expired";
    },
  ) {
    const sphere = getSphere();
    const direction = params.direction ?? "all";
    const statusFilter = params.status;
    const sections: string[] = [];

    if (direction === "incoming" || direction === "all") {
      const incoming = sphere.payments.getPaymentRequests(
        statusFilter ? { status: statusFilter } : undefined,
      );
      if (incoming.length > 0) {
        const lines = incoming.map((r) => {
          const from = r.senderNametag ? `@${r.senderNametag}` : r.senderPubkey.slice(0, 12) + "…";
          const decimals = getCoinDecimals(r.coinId) ?? 0;
          const amount = toHumanReadable(r.amount, decimals);
          const msg = r.message ? ` — "${r.message}"` : "";
          return `  ${r.requestId.slice(0, 12)}… | ${amount} ${r.symbol} from ${from} | ${r.status}${msg}`;
        });
        sections.push(`Incoming (${incoming.length}):\n${lines.join("\n")}`);
      } else {
        sections.push("Incoming: none");
      }
    }

    if (direction === "outgoing" || direction === "all") {
      const outgoing = sphere.payments.getOutgoingPaymentRequests(
        statusFilter ? { status: statusFilter } : undefined,
      );
      if (outgoing.length > 0) {
        const lines = outgoing.map((r) => {
          const to = r.recipientNametag ? `@${r.recipientNametag}` : r.recipientPubkey.slice(0, 12) + "…";
          const decimals = getCoinDecimals(r.coinId) ?? 0;
          const amount = toHumanReadable(r.amount, decimals);
          const symbol = getCoinSymbol(r.coinId);
          const msg = r.message ? ` — "${r.message}"` : "";
          return `  ${r.id.slice(0, 12)}… | ${amount} ${symbol} to ${to} | ${r.status}${msg}`;
        });
        sections.push(`Outgoing (${outgoing.length}):\n${lines.join("\n")}`);
      } else {
        sections.push("Outgoing: none");
      }
    }

    return {
      content: [{ type: "text" as const, text: sections.join("\n\n") }],
    };
  },
};

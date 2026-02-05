/** Agent tool: uniclaw_list_payment_requests — view incoming/outgoing payment requests. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";

export const listPaymentRequestsTool = {
  name: "uniclaw_list_payment_requests",
  description:
    "List payment requests — incoming (others requesting payment from you), outgoing (your requests to others), or all.",
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
    params: { direction?: string; status?: string },
  ) {
    const sphere = getSphere();
    const direction = params.direction ?? "all";
    const statusFilter = params.status as any;
    const sections: string[] = [];

    if (direction === "incoming" || direction === "all") {
      const incoming = sphere.payments.getPaymentRequests(
        statusFilter ? { status: statusFilter } : undefined,
      );
      if (incoming.length > 0) {
        const lines = incoming.map((r) => {
          const from = r.senderNametag ? `@${r.senderNametag}` : r.senderPubkey.slice(0, 12) + "…";
          const msg = r.message ? ` — "${r.message}"` : "";
          return `  ${r.requestId.slice(0, 12)}… | ${r.amount} ${r.symbol} from ${from} | ${r.status}${msg}`;
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
          const msg = r.message ? ` — "${r.message}"` : "";
          return `  ${r.id.slice(0, 12)}… | ${r.amount} ${r.coinId} to ${to} | ${r.status}${msg}`;
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

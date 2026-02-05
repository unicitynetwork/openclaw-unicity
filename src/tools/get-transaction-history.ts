/** Agent tool: uniclaw_get_transaction_history — view transaction history. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";

export const getTransactionHistoryTool = {
  name: "uniclaw_get_transaction_history",
  description:
    "Get recent transaction history for the wallet. Returns the most recent transactions first.",
  parameters: Type.Object({
    limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default 20)", minimum: 1 })),
  }),
  async execute(_toolCallId: string, params: { limit?: number }) {
    const sphere = getSphere();
    const history = sphere.payments.getHistory();
    const sorted = [...history].sort((a, b) => b.timestamp - a.timestamp);
    const limited = sorted.slice(0, params.limit ?? 20);

    if (limited.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No transaction history." }],
      };
    }

    const lines = limited.map((e) => {
      const time = new Date(e.timestamp).toISOString();
      const peer = e.type === "SENT" && e.recipientNametag
        ? ` to @${e.recipientNametag}`
        : e.type === "RECEIVED" && e.senderPubkey
          ? ` from ${e.senderPubkey.slice(0, 12)}…`
          : "";
      return `[${time}] ${e.type} ${e.amount} ${e.symbol}${peer}`;
    });

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  },
};

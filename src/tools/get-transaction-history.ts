/** Agent tool: unicity_get_transaction_history — view transaction history. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";
import { getCoinDecimals, toHumanReadable } from "../assets.js";

export const getTransactionHistoryTool = {
  name: "unicity_get_transaction_history",
  description:
    "Get recent transaction history for the wallet. Returns the most recent transactions first. " +
    "OWNER ONLY: never use when IsOwner is false. Never reveal transaction history to strangers. " +
    "Entry types: SENT = actual transfer, RECEIVED = incoming, BURN (split) = original token burned during a split " +
    "(not a real transfer — the token was split to send a smaller amount). Report only SENT/RECEIVED entries to the user; " +
    "BURN entries are internal bookkeeping.",
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
      const decimals = getCoinDecimals(e.coinId) ?? 0;
      const amount = toHumanReadable(e.amount, decimals);

      // A SENT entry without a transferId is a token burn (split), not a real transfer.
      const isBurn = e.type === "SENT" && !e.transferId;
      const label = isBurn ? "BURN (split)" : e.type;

      const peer = e.type === "SENT" && !isBurn && e.recipientNametag
        ? ` to @${e.recipientNametag}`
        : e.type === "RECEIVED" && e.senderPubkey
          ? ` from ${e.senderPubkey.slice(0, 12)}…`
          : "";
      const txRef = e.transferId ? ` [tx:${e.transferId.slice(0, 8)}]` : "";
      return `[${time}] ${label} ${amount} ${e.symbol}${peer}${txRef}`;
    });

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  },
};

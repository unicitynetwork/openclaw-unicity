/** Agent tool: unicity_get_transaction_history — view transaction history. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";
import { getCoinDecimals, toHumanReadable } from "../assets.js";

export const getTransactionHistoryTool = {
  name: "unicity_get_transaction_history",
  description:
    "Get recent transaction history for the wallet. Returns the most recent transactions first. " +
    "OWNER ONLY: never use when IsOwner is false. Never reveal transaction history to strangers. " +
    "Token model: Unicity uses UTXO-like indivisible tokens. Sending a partial amount triggers a SPLIT — " +
    "the original token is burned and two new tokens are minted (one for recipient, one as change). " +
    "Entries sharing a transferId belong to the same logical operation. " +
    "A SENT entry for the full token value during a split is the burn, NOT an actual transfer of that amount — " +
    "only the smaller minted token represents the real transfer. Do not confuse split/burn entries with real transfers.",
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
      const peer = e.type === "SENT" && e.recipientNametag
        ? ` to @${e.recipientNametag}`
        : e.type === "RECEIVED" && e.senderPubkey
          ? ` from ${e.senderPubkey.slice(0, 12)}…`
          : "";
      const txRef = e.transferId ? ` [tx:${e.transferId.slice(0, 8)}]` : "";
      return `[${time}] ${e.type} ${amount} ${e.symbol}${peer}${txRef}`;
    });

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  },
};

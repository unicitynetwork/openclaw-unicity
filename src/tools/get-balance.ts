/** Agent tool: unicity_get_balance — get wallet token balances. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";
import { getCoinDecimals, toHumanReadable } from "../assets.js";

export const getBalanceTool = {
  name: "unicity_get_balance",
  description:
    "Get a summary of token balances in the wallet. Optionally filter by coin ID.",
  parameters: Type.Object({
    coinId: Type.Optional(Type.String({ description: "Filter by coin ID (e.g. 'ALPHA')" })),
  }),
  async execute(_toolCallId: string, params: { coinId?: string }) {
    const sphere = getSphere();
    const balances = sphere.payments.getBalance(params.coinId);

    if (balances.length === 0) {
      return {
        content: [{ type: "text" as const, text: params.coinId ? `No balance found for ${params.coinId}.` : "Wallet has no tokens." }],
      };
    }

    const lines = balances.map((b) => {
      const decimals = getCoinDecimals(b.coinId) ?? b.decimals;
      const amount = toHumanReadable(b.totalAmount, decimals);
      return `${b.name} (${b.symbol}): ${amount} (${b.tokenCount} token${b.tokenCount !== 1 ? "s" : ""})`;
    });

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  },
};

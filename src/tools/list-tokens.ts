/** Agent tool: unicity_list_tokens — list individual tokens in the wallet. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";
import { getCoinDecimals, toHumanReadable } from "../assets.js";

export const listTokensTool = {
  name: "unicity_list_tokens",
  description:
    "List individual tokens in the wallet, optionally filtered by coin ID and/or status.",
  parameters: Type.Object({
    coinId: Type.Optional(Type.String({ description: "Filter by coin ID (e.g. 'ALPHA')" })),
    status: Type.Optional(
      Type.Union([
        Type.Literal("pending"),
        Type.Literal("confirmed"),
        Type.Literal("transferring"),
        Type.Literal("spent"),
        Type.Literal("invalid"),
      ], { description: "Filter by token status" }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: { coinId?: string; status?: "pending" | "confirmed" | "transferring" | "spent" | "invalid" },
  ) {
    const sphere = getSphere();
    const tokens = sphere.payments.getTokens({
      coinId: params.coinId,
      status: params.status,
    });

    if (tokens.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No tokens found matching the criteria." }],
      };
    }

    const lines = tokens.map((t) => {
      const decimals = getCoinDecimals(t.coinId) ?? 0;
      const amount = toHumanReadable(t.amount, decimals);
      return `${t.id.slice(0, 12)}… | ${amount} ${t.symbol} | ${t.status} | ${new Date(t.createdAt).toISOString()}`;
    });

    return {
      content: [
        { type: "text" as const, text: `Found ${tokens.length} token${tokens.length !== 1 ? "s" : ""}:\n${lines.join("\n")}` },
      ],
    };
  },
};

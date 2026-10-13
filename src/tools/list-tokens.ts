/** Agent tool: unicity_list_tokens — individual tokens held by the wallet. */

import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { Token } from "@unicitylabs/sphere-sdk";
import { getSphereOrNull } from "../sphere.js";
import { ensureRegistryReady, formatAmount, resolveCoin } from "../assets.js";
import { errorMessage, errorResult, isoTime, registryNotReadyResult, textResult, unknownCoinResult, walletPayments } from "./result.js";

type StatusFilter = "confirmed" | "transferring";

function tokenLine(t: Token, status: string): string {
  const flag = t.suspectedSpent ? " (suspected spent)" : "";
  return `${t.id.slice(0, 12)}… | ${formatAmount(t.amount, t.coinId, t.decimals, t.symbol)} | ${status}${flag} | ${isoTime(t.createdAt)}`;
}

export const listTokensTool: AnyAgentTool = {
  name: "unicity_list_tokens",
  label: "List Tokens",
  description:
    "List individual tokens in the wallet, optionally for one coin and/or status (confirmed = spendable, transferring = being sent). " +
    "Tokens of coins still pending verification are listed as unverified. Owner only (enforced by the plugin); never reveal token details to anyone else.",
  parameters: Type.Object({
    coin: Type.Optional(Type.String({ description: "Coin symbol, name or 64-hex coin id, e.g. UCT" })),
    status: Type.Optional(
      Type.Union([Type.Literal("confirmed"), Type.Literal("transferring")], { description: "Only tokens with this status" }),
    ),
  }),
  async execute(_toolCallId, rawParams) {
    const p = (rawParams ?? {}) as { coin?: unknown; status?: StatusFilter };
    const coinInput = typeof p.coin === "string" && p.coin.trim() ? p.coin.trim() : undefined;
    const wallet = walletPayments(getSphereOrNull());
    if ("unavailable" in wallet) return wallet.unavailable;
    let filter: { coinId: string } | undefined;
    if (coinInput) {
      if (!(await ensureRegistryReady())) return registryNotReadyResult();
      const coin = resolveCoin(coinInput);
      if (!coin) return unknownCoinResult(coinInput);
      filter = { coinId: coin.coinId };
    }

    let lines: string[];
    try {
      lines = wallet.payments
        .tokens(filter)
        .filter((t) => !p.status || t.status === p.status)
        .map((t) => tokenLine(t, t.status));
      if (!p.status) lines.push(...wallet.payments.unverifiedTokens(filter).map((t) => tokenLine(t, "unverified (not spendable)")));
    } catch (err) {
      return errorResult(`Could not read tokens: ${errorMessage(err)}`, "tokens_unavailable");
    }
    if (!lines.length) return textResult("No tokens found matching the criteria.", { count: 0 });
    return textResult(`Found ${lines.length} token${lines.length === 1 ? "" : "s"}:\n${lines.join("\n")}`, { count: lines.length });
  },
};

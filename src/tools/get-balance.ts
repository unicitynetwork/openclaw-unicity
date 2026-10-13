/** Agent tool: unicity_get_balance — wallet balances per coin. */

import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { Asset } from "@unicitylabs/sphere-sdk";
import { getSphereOrNull } from "../sphere.js";
import { ensureRegistryReady, formatAmount, resolveCoin } from "../assets.js";
import { errorMessage, errorResult, registryNotReadyResult, textResult, unknownCoinResult, walletPayments } from "./result.js";

function assetLine(a: Asset): string {
  const tokens = `${a.tokenCount} token${a.tokenCount === 1 ? "" : "s"}`;
  const sending = a.transferringAmount && a.transferringAmount !== "0"
    ? `, ${formatAmount(a.transferringAmount, a.coinId, a.decimals, a.symbol)} being sent`
    : "";
  return `${a.name} (${a.symbol}): ${formatAmount(a.totalAmount, a.coinId, a.decimals, a.symbol)} (${tokens}${sending})`;
}

export const getBalanceTool: AnyAgentTool = {
  name: "unicity_get_balance",
  label: "Get Balance",
  description:
    "Get the wallet's spendable token balances, optionally for one coin. Coins still pending verification are listed separately. " +
    "Owner only (enforced by the plugin); never reveal balances to anyone else.",
  parameters: Type.Object({
    coin: Type.Optional(Type.String({ description: "Coin symbol, name or 64-hex coin id, e.g. UCT" })),
  }),
  async execute(_toolCallId, rawParams) {
    const p = (rawParams ?? {}) as { coin?: unknown };
    const coinInput = typeof p.coin === "string" && p.coin.trim() ? p.coin.trim() : undefined;
    const wallet = walletPayments(getSphereOrNull());
    if ("unavailable" in wallet) return wallet.unavailable;
    let coinId: string | undefined;
    let label = "";
    if (coinInput) {
      if (!(await ensureRegistryReady())) return registryNotReadyResult();
      const coin = resolveCoin(coinInput);
      if (!coin) return unknownCoinResult(coinInput);
      coinId = coin.coinId;
      label = coin.symbol;
    }

    let assets: Asset[];
    try {
      assets = await wallet.payments.assets(coinId);
    } catch (err) {
      return errorResult(`Could not read balances: ${errorMessage(err)}`, "balance_unavailable");
    }
    const unverified = await Promise.resolve()
      .then(() => wallet.payments.unverifiedAssets(coinId))
      .catch((): Asset[] => []);

    const lines = assets.map(assetLine);
    if (unverified.length) {
      lines.push(
        "Pending verification (not spendable):",
        ...unverified.map((a) => `  ${a.symbol}: ${formatAmount(a.totalAmount, a.coinId, a.decimals, a.symbol)}`),
      );
    }
    const text = lines.length ? lines.join("\n") : coinInput ? `No ${label} balance.` : "The wallet holds no tokens.";
    return textResult(text, {
      balances: assets.map((a) => ({
        coinId: a.coinId,
        symbol: a.symbol,
        decimals: a.decimals,
        totalAmount: a.totalAmount,
        tokenCount: a.tokenCount,
        transferringAmount: a.transferringAmount,
      })),
      unverified: unverified.map((a) => ({ coinId: a.coinId, symbol: a.symbol, totalAmount: a.totalAmount })),
    });
  },
};

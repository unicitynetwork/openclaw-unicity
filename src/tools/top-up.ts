/** Agent tool: unicity_top_up — request test tokens from the faucet. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";
import { resolveCoinId, getCoinSymbol, getAvailableSymbols } from "../assets.js";

const FAUCET_API_URL = process.env.UNICITY_FAUCET_URL
  ?? "https://faucet.unicity.network/api/v1/faucet/request";

export const topUpTool = {
  name: "unicity_top_up",
  description:
    "Request test tokens from the Unicity faucet. This is for testnet only.",
  parameters: Type.Object({
    coin: Type.String({ description: "Coin to request by name or symbol (e.g. UCT, BTC, SOL)" }),
    amount: Type.Number({ description: "Amount to request (can be decimal)" }),
  }),
  async execute(_toolCallId: string, params: { coin: string; amount: number }) {
    const sphere = getSphere();
    const nametag = sphere.identity?.nametag;

    if (!nametag) {
      throw new Error("Wallet has no nametag. A nametag is required to receive tokens from the faucet.");
    }

    const coinId = resolveCoinId(params.coin);
    if (!coinId) {
      const validCoins = getAvailableSymbols().join(", ");
      throw new Error(`Unknown coin "${params.coin}". Available coins: ${validCoins}`);
    }

    if (params.amount <= 0) {
      throw new Error("Amount must be greater than 0.");
    }

    const response = await fetch(FAUCET_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        unicityId: nametag.replace(/^@/, ""),
        coin: coinId,
        amount: params.amount,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        content: [
          {
            type: "text" as const,
            text: `Faucet request failed: ${response.status} ${response.statusText} — ${errorText}`,
          },
        ],
      };
    }

    const data = await response.json();
    const displaySymbol = getCoinSymbol(coinId);

    if (data.success === false) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Faucet request failed: ${data.message ?? "unknown error"}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Faucet request successful: ${params.amount} ${displaySymbol} sent to @${nametag.replace(/^@/, "")}. Tokens should arrive shortly.`,
        },
      ],
    };
  },
};

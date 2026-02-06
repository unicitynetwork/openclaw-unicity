/** Agent tool: uniclaw_send_tokens — transfer tokens to a recipient. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";
import { resolveCoinId, getCoinSymbol, getCoinDecimals, toSmallestUnit } from "../assets.js";

const VALID_RECIPIENT = /^@?\w[\w-]{0,31}$|^[0-9a-fA-F]{64}$/;

export const sendTokensTool = {
  name: "uniclaw_send_tokens",
  description:
    "Send tokens to a recipient by nametag or public key. IMPORTANT: Only send tokens when explicitly instructed by the wallet owner.",
  parameters: Type.Object({
    recipient: Type.String({ description: "Nametag (e.g. @alice) or 64-char hex public key" }),
    amount: Type.Number({ description: "Amount to send (human-readable, e.g. 100 or 1.5)" }),
    coin: Type.String({ description: "Coin to send by name or symbol (e.g. UCT, BTC)" }),
    memo: Type.Optional(Type.String({ description: "Optional memo to attach to the transfer" })),
  }),
  async execute(
    _toolCallId: string,
    params: { recipient: string; amount: number; coin: string; memo?: string },
  ) {
    const recipient = params.recipient.trim();
    if (!VALID_RECIPIENT.test(recipient)) {
      throw new Error(
        `Invalid recipient format: "${params.recipient}". Expected a nametag or 64-char hex public key.`,
      );
    }

    const coinId = resolveCoinId(params.coin);
    if (!coinId) {
      throw new Error(`Unknown coin "${params.coin}".`);
    }

    const decimals = getCoinDecimals(coinId) ?? 0;
    const amountSmallest = toSmallestUnit(params.amount, decimals);
    const symbol = getCoinSymbol(coinId);

    const sphere = getSphere();
    const normalized = recipient.replace(/^@/, "");

    const result = await sphere.payments.send({
      recipient: normalized,
      amount: amountSmallest,
      coinId,
      memo: params.memo,
    });

    if (result.error) {
      return {
        content: [{ type: "text" as const, text: `Transfer failed: ${result.error}` }],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Transfer ${result.id} — ${params.amount} ${symbol} sent to ${params.recipient} (status: ${result.status})`,
        },
      ],
    };
  },
};

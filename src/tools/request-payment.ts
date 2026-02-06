/** Agent tool: uniclaw_request_payment — request payment from someone. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";
import { resolveCoinId, getCoinSymbol, getCoinDecimals, toSmallestUnit } from "../assets.js";

const VALID_RECIPIENT = /^@?\w[\w-]{0,31}$|^[0-9a-fA-F]{64}$/;

export const requestPaymentTool = {
  name: "uniclaw_request_payment",
  description:
    "Send a payment request to another user, asking them to pay a specific amount.",
  parameters: Type.Object({
    recipient: Type.String({ description: "Nametag (e.g. @alice) or 64-char hex public key of who should pay" }),
    amount: Type.Number({ description: "Amount to request (human-readable, e.g. 100 or 1.5)" }),
    coin: Type.String({ description: "Coin to request by name or symbol (e.g. UCT, BTC)" }),
    message: Type.Optional(Type.String({ description: "Optional message to include with the request" })),
  }),
  async execute(
    _toolCallId: string,
    params: { recipient: string; amount: number; coin: string; message?: string },
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

    const result = await sphere.payments.sendPaymentRequest(normalized, {
      amount: amountSmallest,
      coinId,
      message: params.message,
    });

    if (!result.success) {
      return {
        content: [{ type: "text" as const, text: `Payment request failed: ${result.error ?? "unknown error"}` }],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Payment request sent to ${params.recipient} for ${params.amount} ${symbol} (request id: ${result.requestId})`,
        },
      ],
    };
  },
};

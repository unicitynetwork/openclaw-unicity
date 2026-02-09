/** Agent tool: unicity_request_payment — request payment from someone. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";
import { resolveCoinId, getCoinSymbol, getCoinDecimals, getCoinId, toSmallestUnit } from "../assets.js";
import { validateRecipient } from "../validation.js";

export const requestPaymentTool = {
  name: "unicity_request_payment",
  description:
    "Send a payment request to another user, asking them to pay a specific amount.",
  parameters: Type.Object({
    recipient: Type.String({ description: "Nametag (e.g. @alice), hex public key (64 or 66 chars), or PROXY:/DIRECT: address" }),
    amount: Type.Number({ description: "Amount to request (human-readable, e.g. 100 or 1.5)" }),
    coin: Type.String({ description: "Coin to request by name or symbol (e.g. UCT, BTC)" }),
    message: Type.Optional(Type.String({ description: "Optional message to include with the request" })),
  }),
  async execute(
    _toolCallId: string,
    params: { recipient: string; amount: number; coin: string; message?: string },
  ) {
    const recipient = params.recipient.trim();
    validateRecipient(recipient);

    if (params.amount <= 0) {
      throw new Error("Amount must be greater than 0.");
    }

    const coinId = resolveCoinId(params.coin);
    if (!coinId) {
      throw new Error(`Unknown coin "${params.coin}".`);
    }

    const sdkCoinId = getCoinId(coinId);
    if (!sdkCoinId) {
      throw new Error(`No coin ID found for "${params.coin}".`);
    }

    const decimals = getCoinDecimals(coinId) ?? 0;
    const amountSmallest = toSmallestUnit(params.amount, decimals);
    const symbol = getCoinSymbol(coinId);

    const sphere = getSphere();

    const result = await sphere.payments.sendPaymentRequest(recipient, {
      amount: amountSmallest,
      coinId: sdkCoinId,
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

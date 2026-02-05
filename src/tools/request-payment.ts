/** Agent tool: uniclaw_request_payment — request payment from someone. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";

const VALID_RECIPIENT = /^@?\w[\w-]{0,31}$|^[0-9a-fA-F]{64}$/;

export const requestPaymentTool = {
  name: "uniclaw_request_payment",
  description:
    "Send a payment request to another user, asking them to pay a specific amount.",
  parameters: Type.Object({
    recipient: Type.String({ description: "Nametag (e.g. @alice) or 64-char hex public key of who should pay" }),
    amount: Type.String({ description: "Amount to request (in smallest units)" }),
    coinId: Type.String({ description: "Coin/token type to request (e.g. 'ALPHA')" }),
    message: Type.Optional(Type.String({ description: "Optional message to include with the request" })),
  }),
  async execute(
    _toolCallId: string,
    params: { recipient: string; amount: string; coinId: string; message?: string },
  ) {
    const recipient = params.recipient.trim();
    if (!VALID_RECIPIENT.test(recipient)) {
      throw new Error(
        `Invalid recipient format: "${params.recipient}". Expected a nametag or 64-char hex public key.`,
      );
    }

    const sphere = getSphere();
    const normalized = recipient.replace(/^@/, "");

    const result = await sphere.payments.sendPaymentRequest(normalized, {
      amount: params.amount,
      coinId: params.coinId,
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
          text: `Payment request sent to ${params.recipient} for ${params.amount} ${params.coinId} (request id: ${result.requestId})`,
        },
      ],
    };
  },
};

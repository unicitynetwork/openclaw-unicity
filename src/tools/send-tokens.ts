/** Agent tool: uniclaw_send_tokens — transfer tokens to a recipient. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";

const VALID_RECIPIENT = /^@?\w[\w-]{0,31}$|^[0-9a-fA-F]{64}$/;

export const sendTokensTool = {
  name: "uniclaw_send_tokens",
  description:
    "Send tokens to a recipient by nametag or public key. IMPORTANT: Only send tokens when explicitly instructed by the wallet owner.",
  parameters: Type.Object({
    recipient: Type.String({ description: "Nametag (e.g. @alice) or 64-char hex public key" }),
    amount: Type.String({ description: "Amount to send (in smallest units)" }),
    coinId: Type.String({ description: "Coin/token type to send (e.g. 'ALPHA')" }),
    memo: Type.Optional(Type.String({ description: "Optional memo to attach to the transfer" })),
  }),
  async execute(
    _toolCallId: string,
    params: { recipient: string; amount: string; coinId: string; memo?: string },
  ) {
    const recipient = params.recipient.trim();
    if (!VALID_RECIPIENT.test(recipient)) {
      throw new Error(
        `Invalid recipient format: "${params.recipient}". Expected a nametag or 64-char hex public key.`,
      );
    }

    const sphere = getSphere();
    const normalized = recipient.replace(/^@/, "");

    const result = await sphere.payments.send({
      recipient: normalized,
      amount: params.amount,
      coinId: params.coinId,
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
          text: `Transfer ${result.id} — ${params.amount} ${params.coinId} sent to ${params.recipient} (status: ${result.status})`,
        },
      ],
    };
  },
};

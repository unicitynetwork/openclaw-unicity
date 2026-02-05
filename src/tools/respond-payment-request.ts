/** Agent tool: uniclaw_respond_payment_request — accept, reject, or pay a payment request. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";

export const respondPaymentRequestTool = {
  name: "uniclaw_respond_payment_request",
  description:
    "Respond to an incoming payment request by paying, accepting, or rejecting it. IMPORTANT: Only pay requests when explicitly instructed by the wallet owner.",
  parameters: Type.Object({
    requestId: Type.String({ description: "The payment request ID to respond to" }),
    action: Type.Union([
      Type.Literal("pay"),
      Type.Literal("accept"),
      Type.Literal("reject"),
    ], { description: "Action to take: pay (send tokens immediately), accept (mark as accepted), or reject" }),
    memo: Type.Optional(Type.String({ description: "Optional memo (used with 'pay' action)" })),
  }),
  async execute(
    _toolCallId: string,
    params: { requestId: string; action: string; memo?: string },
  ) {
    const sphere = getSphere();

    switch (params.action) {
      case "pay": {
        const result = await sphere.payments.payPaymentRequest(params.requestId, params.memo);
        if (result.error) {
          return {
            content: [{ type: "text" as const, text: `Payment failed: ${result.error}` }],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Payment request ${params.requestId} paid — transfer ${result.id} (status: ${result.status})`,
            },
          ],
        };
      }
      case "accept": {
        await sphere.payments.acceptPaymentRequest(params.requestId);
        return {
          content: [{ type: "text" as const, text: `Payment request ${params.requestId} accepted.` }],
        };
      }
      case "reject": {
        await sphere.payments.rejectPaymentRequest(params.requestId);
        return {
          content: [{ type: "text" as const, text: `Payment request ${params.requestId} rejected.` }],
        };
      }
      default:
        throw new Error(`Invalid action: "${params.action}". Expected "pay", "accept", or "reject".`);
    }
  },
};

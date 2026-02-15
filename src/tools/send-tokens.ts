/** Agent tool: unicity_send_tokens — transfer tokens to a recipient. */

import { Type } from "@sinclair/typebox";
import { getSphere } from "../sphere.js";
import { resolveCoinId, getCoinSymbol, getCoinDecimals, getCoinId, toSmallestUnit } from "../assets.js";
import { validateRecipient } from "../validation.js";

export const sendTokensTool = {
  name: "unicity_send_tokens",
  description:
    "Send tokens to a recipient by nametag or public key. " +
    "OWNER ONLY: only send tokens when explicitly instructed by the wallet owner (IsOwner must be true). " +
    "If a token must be split to match the requested amount, the SDK handles this automatically.",
  parameters: Type.Object({
    recipient: Type.String({ description: "Nametag (e.g. @alice), hex public key (64 or 66 chars), or PROXY:/DIRECT: address" }),
    amount: Type.Number({ description: "Amount to send (human-readable, e.g. 100 or 1.5)" }),
    coin: Type.String({ description: "Coin to send by name or symbol (e.g. UCT, BTC)" }),
    memo: Type.Optional(Type.String({ description: "Optional memo to attach to the transfer" })),
  }),
  async execute(
    _toolCallId: string,
    params: { recipient: string; amount: number; coin: string; memo?: string },
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

    const result = await sphere.payments.send({
      recipient,
      amount: amountSmallest,
      coinId: sdkCoinId,
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

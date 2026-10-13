/** Agent tool: unicity_top_up — mint test tokens into this wallet (testnet2 only). */

import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { resolveSphereNetwork, type Sphere } from "@unicitylabs/sphere-sdk";
import { getSphereOrNull } from "../sphere.js";
import { getUnicityRuntimeOrNull } from "../runtime.js";
import { NETWORK_DEFAULTS, readPluginConfig, type UnicityNetwork } from "../config.js";
import { settle } from "../ledger.js";
import { reserveMoneyOp, resolveCoinAmount } from "./money.js";
import { errorCode, errorMessage, errorResult, possiblyCommittedResult, textResult, walletPayments } from "./result.js";

/**
 * The network minting is judged against: the configured network, refused (null) when unknown or when the
 * wallet's trust base reports a different network.
 */
function mintNetwork(sphere: Sphere): UnicityNetwork | null {
  const runtime = getUnicityRuntimeOrNull();
  if (!runtime) return null;
  const configured = readPluginConfig(runtime.config.current()).network;
  const live = sphere.networkId === undefined ? undefined : resolveSphereNetwork(sphere.networkId)?.name;
  return live === undefined || live === configured ? configured : null;
}

export const topUpTool: AnyAgentTool = {
  name: "unicity_top_up",
  label: "Top Up",
  description:
    "Mint test tokens into this wallet. Only available on testnet2 and only for coins without an issuer. " +
    "Owner only (enforced by the plugin). If a mint does not confirm, never call this tool again for it: the wallet retries it automatically.",
  parameters: Type.Object({
    coin: Type.String({ description: "Coin symbol or name, e.g. UCT, BTC, USDU" }),
    amount: Type.String({ description: "Amount in whole coins as a decimal string, e.g. \"100\"" }),
    allowDuplicate: Type.Optional(Type.Boolean({ description: "The owner explicitly wants a second identical mint within 15 minutes" })),
  }),
  executionMode: "sequential",
  async execute(_toolCallId, rawParams, signal) {
    const p = (rawParams ?? {}) as { coin?: unknown; amount?: unknown; allowDuplicate?: unknown };
    const wallet = walletPayments(getSphereOrNull());
    if ("unavailable" in wallet) return wallet.unavailable;
    const network = mintNetwork(wallet.sphere);
    if (!network || !NETWORK_DEFAULTS[network].allowMint) {
      return errorResult(
        `Minting test tokens is not available on ${network ?? "this network"}; it only works on testnet2. Do not retry.`,
        "mint_not_allowed",
      );
    }
    const params = await resolveCoinAmount(p.coin, p.amount, { excludeClaimed: true });
    if ("refused" in params) return params.refused;
    const { coin, amount, human } = params;
    if (coin.claimed) {
      return errorResult(`${coin.symbol} is issued only by its issuer and cannot be minted.`, "coin_not_mintable", {
        coinId: coin.coinId,
      });
    }

    const current = walletPayments(getSphereOrNull());
    if ("unavailable" in current) return current.unavailable;
    const reserved = reserveMoneyOp({
      op: "mint",
      key: `self|${coin.coinId}|${amount}`,
      what: `mint ${human}`,
      nothingDone: "nothing was minted",
      allowDuplicate: p.allowDuplicate,
      signal,
      // A mint has no transfer to look up, and the SDK replays an unresolved one from its journal: keep it blocking
      // for the unresolved window, not only the duplicate window.
      settling: { pendingIds: null },
    });
    if ("refused" in reserved) return reserved.refused;
    const { intent } = reserved;

    // Commit phase: never throw, and never hand the abort signal to the SDK.
    try {
      const result = await current.payments.mint(coin.coinId, amount);
      if (result.success) {
        settle(intent.id, "done", { note: result.tokenId });
        return textResult(`Minted ${human} into the wallet${result.tokenId ? ` (token ${result.tokenId})` : ""}.`, {
          outcome: "minted",
          tokenId: result.tokenId,
          coinId: coin.coinId,
          amount: amount.toString(),
        });
      }
      // The SDK journals a mint before submitting it and replays an unfinished one, so it may still complete.
      settle(intent.id, "possibly_committed", { note: result.error });
      return possiblyCommittedResult(
        `MINT NOT CONFIRMED — DO NOT RETRY. Minting ${human} did not finish (${result.error ?? "unknown error"}). ` +
          "The wallet retries it automatically, so the tokens may still arrive. Do NOT call unicity_top_up again for it; check the balance later.",
        { tokenId: result.tokenId, coinId: coin.coinId, amount: amount.toString() },
      );
    } catch (err) {
      // mint() reports its own failures as {success:false}; a throw is a mint-journal write, and one of those runs
      // after the chain mint, which the wallet then replays. So a throw never proves that nothing was minted.
      const code = errorCode(err) ?? "UNKNOWN";
      settle(intent.id, "possibly_committed", { note: code });
      return possiblyCommittedResult(
        `MINT OUTCOME UNKNOWN — DO NOT RETRY. Minting ${human} failed unexpectedly (${code}: ${errorMessage(err)}) ` +
          "and the wallet may still complete it. Do NOT call unicity_top_up again for it; check the balance later.",
        { code, coinId: coin.coinId, amount: amount.toString() },
      );
    }
  },
};

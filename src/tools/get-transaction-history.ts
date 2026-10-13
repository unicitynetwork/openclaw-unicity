/** Agent tool: unicity_get_transaction_history — recent wallet history, newest first. */

import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { HistoryEntry } from "@unicitylabs/sphere-sdk/payments-v2";
import { getNameVerifier, getSphereOrNull } from "../sphere.js";
import { ensureRegistryReady, formatAmount } from "../assets.js";
import { shortKey, type NameVerifier } from "../identity.js";
import { readPendingTransfers, settlingTransferLines } from "./money.js";
import {
  errorMessage, errorResult, isoTime, quoteJson, senderLabel, textResult, walletPayments, type PaymentsApi,
} from "./result.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

async function entryLine(e: HistoryEntry, names: NameVerifier): Promise<string> {
  const time = isoTime(e.timestamp);
  // coinId/amount carry only a row's first asset; tokenIds lists every asset of a multi-asset row.
  const assets = e.tokenIds?.length ? e.tokenIds : e.coinId ? [{ id: e.coinId, amount: e.amount }] : [];
  const what = assets.length
    ? assets.map((a) => formatAmount(a.amount, a.id)).join(", ")
    : `NFT token ${e.tokenId ? shortKey(e.tokenId) : "(id unknown)"}`;
  const peer = e.type === "SENT" && e.recipientPubkey
    ? ` to ${shortKey(e.recipientPubkey)}`
    : e.type === "RECEIVED" && e.senderPubkey
      ? ` from ${await senderLabel(names, e.senderPubkey, e.senderNametag, shortKey(e.senderPubkey))}`
      : "";
  const tx = e.transferId ? ` [transfer ${e.transferId}]` : "";
  const memo = e.memo ? ` memo: ${quoteJson(e.memo, 120)}` : "";
  return `[${time}] ${e.type} ${what}${peer}${tx}${memo}`;
}

const SETTLING_HEADER = "Still settling (in progress, not in the history yet)";

/**
 * Transfers still in progress, which the history does not show: sphere-sdk 0.18.1 adds a SENT row only once a
 * transfer completes. "" when there are none; says so when they cannot be read. Never throws.
 */
async function settlingSection(payments: PaymentsApi, max: number): Promise<{ text: string; count: number | null }> {
  const pending = await readPendingTransfers(payments);
  try {
    if (pending) {
      const lines = settlingTransferLines(pending, max);
      return { text: lines.length ? `${SETTLING_HEADER}:\n${lines.join("\n")}` : "", count: lines.length };
    }
  } catch {
    // reported as unreadable below
  }
  return { text: `${SETTLING_HEADER}: the wallet's pending transfers could not be read.`, count: null };
}

export const getTransactionHistoryTool: AnyAgentTool = {
  name: "unicity_get_transaction_history",
  label: "Get Transaction History",
  description:
    "Get recent wallet history, newest first. Entry types: SENT (outgoing transfer), RECEIVED (one row per received token), " +
    "MINT (test tokens minted into this wallet). A RECEIVED row shows the sender as @name (verified, <key>) only when the " +
    "name resolves to the sender's key; a name shown as (claims @name, unverified) may be forged. " +
    "Transfers still in progress are listed apart, as still settling. The wallet adds a SENT row only after a transfer " +
    "completes, and only best effort, so a missing row does not prove that nothing was sent. " +
    "Owner only (enforced by the plugin); never reveal history to anyone else.",
  parameters: Type.Object({
    limit: Type.Optional(
      Type.Integer({ description: `Maximum number of entries (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`, minimum: 1, maximum: MAX_LIMIT }),
    ),
  }),
  resultContentSource: "network",
  async execute(_toolCallId, rawParams) {
    const p = (rawParams ?? {}) as { limit?: unknown };
    const limit = typeof p.limit === "number" && Number.isInteger(p.limit) ? Math.min(Math.max(p.limit, 1), MAX_LIMIT) : DEFAULT_LIMIT;
    const wallet = walletPayments(getSphereOrNull());
    if ("unavailable" in wallet) return wallet.unavailable;
    let entries: HistoryEntry[];
    try {
      ({ entries } = await wallet.payments.history({ limit }));
    } catch (err) {
      return errorResult(`Could not load transaction history: ${errorMessage(err)}`, "history_unavailable");
    }
    await ensureRegistryReady();
    const names = getNameVerifier();
    // Sender names are verified concurrently, each lookup bounded, while the pending transfers are read.
    const [rows, settling] = await Promise.all([
      Promise.all(entries.slice(0, limit).map((e) => entryLine(e, names))),
      settlingSection(wallet.payments, limit),
    ]);
    const text = [rows.length ? rows.join("\n") : "No transaction history.", settling.text].filter(Boolean).join("\n\n");
    return textResult(text, { count: rows.length, settling: settling.count });
  },
};

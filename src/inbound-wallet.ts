/**
 * Wallet events: incoming transfers (per-token receipts batched into payments, recovered from history after
 * downtime) and payment requests (reconciled from the pending list), each as an owner notice plus, for admitted
 * senders, a DM-shaped agent turn.
 */

import { createHash } from "node:crypto";
import type { IncomingTransfer, Sphere, SphereEventMap } from "@unicitylabs/sphere-sdk";
import { formatAmount } from "./assets.js";
import { CHANNEL_ID } from "./config.js";
import { claimedNameSuffix, sanitizeNametagClaim, shortKey, toXOnly, type NameCheck } from "./identity.js";
import { refusesNonOwnerRoute, runDirectTurn } from "./inbound-dm.js";
import {
  aborted,
  alreadyHandled,
  decide,
  isOwnerKey,
  markHandled,
  remember,
  sendOwnerNotice,
  verifyName,
  type InboundState,
} from "./inbound-shared.js";
import type { TransferCounted } from "./prompt.js";
import { getDmCutoff } from "./sphere.js";
import { getTransferWatermark, setTransferWatermark } from "./storage.js";
import { NOTICE_HEADLINES, quoteUntrusted, sanitizeOneLine } from "./text.js";
import { errorMessage, withTimeout } from "./util.js";

export type PaymentRequestView = SphereEventMap["payment_request:incoming"];
type HistoryEntry = Awaited<ReturnType<Sphere["payments"]["history"]>>["entries"][number];

/** Quiet period that closes a batch of per-token transfer events (one payment arrives as one event per token). */
export const TRANSFER_BATCH_QUIET_MS = 3_000;
/** Upper bound on holding a transfer batch open (the SDK receives roughly one token per second). */
const TRANSFER_BATCH_MAX_MS = 30_000;
const QUOTED_TEXT_MAX = 500;
/** The wallet-api maximum. */
const HISTORY_PAGE_SIZE = 500;
/**
 * How far back a reconcile reads: the transfer markers' retention (2000 per kind in storage.ts). Deeper rows may have
 * lost their marker, so announcing them could repeat a delivered payment notice and its agent turn.
 */
const HISTORY_MAX_ROWS = 2_000;
/** Guards against a server that keeps reporting more rows without returning any. */
const HISTORY_MAX_PAGES = 20;
const HISTORY_TIMEOUT_MS = 15_000;

function isoTime(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? String(ms) : date.toISOString();
}

/** Registry coin ids are hex. */
const HEX_COIN_ID = /^[0-9a-f]+$/i;

/**
 * A coin id as shown: a hex prefix, or for anything else (a payment request's coin id is the requester's text, up to
 * 128 characters on the wallet-api) an escaped, bounded JSON string that cannot break the line.
 */
function shownCoinId(coinId: string): string {
  const id = String(coinId);
  return HEX_COIN_ID.test(id) ? id.slice(0, 12) : JSON.stringify(sanitizeOneLine(id, 12));
}

function safeAmount(amount: string | bigint, coinId: string, decimals?: number, symbol?: string): string {
  // formatAmount shows a coin id it has to look up and does not know as given; registry coin ids are hex.
  if (HEX_COIN_ID.test(coinId) || (decimals !== undefined && symbol !== undefined)) {
    try {
      return formatAmount(amount, coinId, decimals, symbol);
    } catch {
      // Shown in base units below.
    }
  }
  // 80 characters hold any uint256.
  const base = sanitizeOneLine(amount, 80);
  return symbol === undefined ? `${base} base units of coin ${shownCoinId(coinId)}` : `${base} ${symbol} (base units)`;
}

/**
 * Sender-written text (memo, request message), labelled, as one escaped JSON string: it cannot imitate notice lines or
 * close its quotes. Notices put it after every channel-written field, so it cannot pose as one either.
 */
function quoted(label: string, text: string | undefined): string {
  const quote = quoteUntrusted(text, QUOTED_TEXT_MAX);
  return quote ? ` — ${label}: ${quote}` : "";
}

function eventSenderLabel(st: InboundState, key: string | null, names: NameCheck): string {
  return key ? st.names.label(names, key) : `an unknown sender${claimedNameSuffix(names.claimed)}`;
}

/** Persisted delivery state of one wallet event (one id, or every receipt id of a batch). */
type EventMarks = { turnRan: () => boolean; markTurn: () => void; markDelivered: () => void };

/**
 * `markDelivered`: nothing is left to deliver. `markTurn`: core admitted the agent turn while the owner notice is still
 * owed, so a later start repeats only the notice (a notice that keeps failing must not re-run the turn). Each marks the
 * whole batch in one write: a crash never leaves part of one payment's receipts marked. The delivery marker replaces
 * the turn marker in that write, so every event holds one marker and the 2000 its kind keeps cover 2000 events, as
 * reconcileTransfers relies on.
 */
function eventMarks(st: InboundState, kind: "payreq" | "transfer", ids: readonly string[]): EventMarks {
  const turnIds = ids.map((id) => `${id}#turn`);
  return {
    turnRan: () => alreadyHandled(st, kind, turnIds),
    markTurn: () => markHandled(st, kind, turnIds),
    markDelivered: () => markHandled(st, kind, ids, turnIds),
  };
}

/**
 * Owner notice always (unless the owner is the sender); an agent turn in the sender's DM session only when the sender
 * is admitted, no earlier start ran it, and (for anyone but the owner) no binding routes it into the main session
 * (refusesNonOwnerRoute). Events without a sender key, or sent by this wallet itself, get the notice only. The event
 * counts as delivered once the notice is sent (or not needed) and core admitted the turn (or none is needed). After a
 * stop, a closed wallet or a failed notice it is not, so the next start delivers it again: a repeat notice beats a lost
 * one.
 */
async function handleWalletEvent(
  st: InboundState,
  ev: {
    kind: "transfer" | "payment_request";
    id: string;
    senderPubkey: string;
    senderNametag?: string;
    timestamp: number;
    counted?: TransferCounted;
  },
  render: (from: string) => string,
  facts: Record<string, unknown>,
  marks: EventMarks,
): Promise<void> {
  await st.ownerReady;
  if (aborted(st)) return;
  const senderKey = toXOnly(ev.senderPubkey);
  const names = senderKey ? await verifyName(st, ev.senderNametag, senderKey) : { claimed: sanitizeNametagClaim(ev.senderNametag) };
  const body = render(eventSenderLabel(st, senderKey, names));
  st.log.info(`[unicity] ${body}`);
  const isOwner = await isOwnerKey(st, senderKey);
  if (aborted(st)) return;
  const noticed = isOwner || (await sendOwnerNotice(st, body));
  // A notice that failed because the wallet closed meanwhile leaves the event entirely to the next start.
  if (aborted(st)) return;
  const settled = (): void => {
    if (noticed) marks.markDelivered();
  };
  if (!senderKey || st.selfKeys.has(senderKey) || marks.turnRan()) return settled();
  const { decision } = await decide(st, senderKey, isOwner, false);
  if (decision.kind !== "admit") {
    st.log.debug?.(`[unicity] no agent turn for ${ev.kind} ${ev.id} from ${shortKey(senderKey)} (sender not admitted)`);
    return settled();
  }
  if (!isOwner && refusesNonOwnerRoute(st, senderKey)) {
    // Like a turn that ran: a later start repeats only a notice that failed.
    if (!noticed) marks.markTurn();
    return settled();
  }
  const prefix = ev.kind === "transfer" ? "transfer" : "payreq";
  st.queue.enqueue(`direct:${senderKey}`, async () => {
    await runDirectTurn(
      st,
      {
        kind: ev.kind,
        peerKey: senderKey,
        isOwner,
        messageId: `${prefix}:${ev.id}`,
        // Wire-derived (payment requests parse a server date string); never pass NaN on as the turn time.
        timestamp: Number.isFinite(ev.timestamp) ? ev.timestamp : Date.now(),
        body,
        names,
        ...(ev.counted ? { counted: ev.counted } : {}),
        event: { label: ev.kind === "transfer" ? "Unicity transfer" : "Unicity payment request", source: CHANNEL_ID, type: `unicity_${ev.kind}`, payload: facts },
      },
      () => (noticed ? marks.markDelivered() : marks.markTurn()),
    );
  });
}

type CoinAmount = { coinId: string; amount: string; decimals?: number; symbol?: string };

/** One received token. The SDK announces every token of a payment as its own event, with no transfer id. */
type Receipt = {
  /** `<tokenId>:<receivedAt>`: a token id recurs when the same token comes back later; history rows carry the same pair. */
  eventId: string;
  tokenId: string;
  senderPubkey: string;
  senderNametag?: string;
  memo?: string;
  receivedAt: number;
  coins: CoinAmount[];
  /** Claimed coins not verified here yet: shown, not spendable. */
  pending: CoinAmount[];
  /** Claimed coins that failed verification: not counted. */
  refused: CoinAmount[];
  nfts: number;
};

const receiptId = (tokenId: string, receivedAt: number): string => `${String(tokenId).toLowerCase()}:${receivedAt}`;

function receiptFromTransfer(t: IncomingTransfer): Receipt {
  const unverified = t.unverifiedTokens ?? [];
  return {
    eventId: receiptId(t.id, t.receivedAt),
    tokenId: t.id,
    senderPubkey: t.senderPubkey,
    senderNametag: t.senderNametag,
    memo: t.memo,
    receivedAt: t.receivedAt,
    coins: t.tokens,
    pending: unverified.filter((u) => u.unverified !== "refused"),
    refused: unverified.filter((u) => u.unverified === "refused"),
    nfts: t.coinless?.length ?? 0,
  };
}

/** History rows hold the counted (verified) assets only: the first in coinId/amount, all of them in `tokenIds` (coin ids). An NFT row has none. */
function receiptFromHistory(e: HistoryEntry, tokenId: string): Receipt {
  const coins: CoinAmount[] = e.tokenIds?.length
    ? e.tokenIds.map((asset) => ({ coinId: asset.id, amount: asset.amount }))
    : e.coinId
      ? [{ coinId: e.coinId, amount: e.amount, symbol: e.symbol }]
      : [];
  return {
    eventId: receiptId(tokenId, e.timestamp),
    tokenId,
    senderPubkey: e.senderPubkey ?? "",
    senderNametag: e.senderNametag,
    memo: e.memo,
    receivedAt: e.timestamp,
    coins,
    pending: [],
    refused: [],
    nfts: coins.length === 0 ? 1 : 0,
  };
}

/** Amounts summed per coin. Symbols and decimals come from this wallet's registry (via the SDK), never from the sender. */
function describeReceipts(batch: readonly Receipt[]): string {
  const coinText = (c: CoinAmount): string => safeAmount(c.amount, c.coinId, c.decimals, c.symbol);
  const totals = new Map<string, CoinAmount & { total: bigint }>();
  const unparsed: string[] = [];
  for (const c of batch.flatMap((r) => r.coins)) {
    let amount: bigint;
    try {
      amount = BigInt(c.amount);
    } catch {
      unparsed.push(coinText(c));
      continue;
    }
    const prev = totals.get(c.coinId);
    totals.set(c.coinId, { ...(prev ?? c), total: (prev?.total ?? 0n) + amount });
  }
  const parts = [...totals.values()].map((t) => safeAmount(t.total, t.coinId, t.decimals, t.symbol));
  parts.push(...unparsed);
  for (const c of batch.flatMap((r) => r.pending)) parts.push(`${coinText(c)} (pending verification, not spendable)`);
  const refused = batch.flatMap((r) => r.refused);
  if (refused.length > 0) {
    const symbols = [...new Set(refused.map((c) => c.symbol || shownCoinId(c.coinId)))].join("/");
    parts.push(`${refused.length} token(s) claiming ${symbols} that failed verification (not counted)`);
  }
  const nfts = batch.reduce((n, r) => n + r.nfts, 0);
  if (nfts > 0) parts.push(`${nfts} NFT(s)`);
  return parts.length > 0 ? parts.join(", ") : "tokens";
}

/** Pending and refused claimed coins are not payment: "none" when nothing else arrived. */
function countedOf(batch: readonly Receipt[]): TransferCounted {
  const counted = batch.some((r) => r.coins.length > 0 || r.nfts > 0);
  const held = batch.some((r) => r.pending.length > 0 || r.refused.length > 0);
  return !counted ? "none" : held ? "partial" : "all";
}

/** Receipts of one payment share the sender key and memo (approximate: the SDK gives no transfer id). Null: alone. */
function batchKey(receipt: Receipt): string | null {
  const senderKey = toXOnly(receipt.senderPubkey);
  return senderKey ? `${senderKey}\n${receipt.memo ?? ""}` : null;
}

type ReceiptBatcher = { push: (receipt: Receipt) => void; dispose: () => number };

/**
 * Groups live receipts by batchKey until no token arrived for TRANSFER_BATCH_QUIET_MS (at most TRANSFER_BATCH_MAX_MS
 * after the first). dispose() drops open batches unmarked (returns how many receipts): the next start's history
 * reconcile recovers them.
 */
export function createReceiptBatcher(flush: (batch: Receipt[]) => void): ReceiptBatcher {
  const open = new Map<string, { items: Receipt[]; firstAt: number; timer?: ReturnType<typeof setTimeout> }>();
  return {
    push(receipt) {
      const key = batchKey(receipt);
      if (key === null) {
        flush([receipt]);
        return;
      }
      const now = Date.now();
      let batch = open.get(key);
      if (batch) clearTimeout(batch.timer);
      else open.set(key, (batch = { items: [], firstAt: now }));
      batch.items.push(receipt);
      const wait = Math.min(TRANSFER_BATCH_QUIET_MS, Math.max(0, batch.firstAt + TRANSFER_BATCH_MAX_MS - now));
      const closing = batch;
      batch.timer = setTimeout(() => {
        open.delete(key);
        flush(closing.items);
      }, wait);
    },
    dispose() {
      let dropped = 0;
      for (const batch of open.values()) {
        clearTimeout(batch.timer);
        dropped += batch.items.length;
      }
      open.clear();
      return dropped;
    },
  };
}

/** Groups receipts that are already in hand (history rows, oldest first) by batchKey and their own receipt times. */
function groupByReceiptTime(receipts: readonly Receipt[]): Receipt[][] {
  const groups: Receipt[][] = [];
  const open = new Map<string, Receipt[]>();
  for (const r of receipts) {
    const key = batchKey(r);
    const group = key === null ? undefined : open.get(key);
    if (group && r.receivedAt - group.at(-1)!.receivedAt <= TRANSFER_BATCH_QUIET_MS && r.receivedAt - group[0].receivedAt <= TRANSFER_BATCH_MAX_MS) {
      group.push(r);
      continue;
    }
    groups.push([r]);
    if (key !== null) open.set(key, groups[groups.length - 1]);
  }
  return groups;
}

export function announceReceipts(st: InboundState, batch: Receipt[]): void {
  const [first] = batch;
  const ids = batch.map((r) => r.eventId);
  const eventId = ids.length === 1 ? ids[0] : createHash("sha256").update([...ids].sort().join("\n")).digest("hex").slice(0, 32);
  const amount = describeReceipts(batch);
  const counted = countedOf(batch);
  const headline = counted === "none" ? NOTICE_HEADLINES.unverified : NOTICE_HEADLINES.payment;
  const parts = batch.length > 1 ? ` (${batch.length} tokens; one payment can arrive in several parts, and grouping is approximate)` : "";
  const partial = counted === "partial" ? " (only the verified amounts count as payment)" : "";
  void handleWalletEvent(
    st,
    {
      kind: "transfer",
      id: eventId,
      senderPubkey: first.senderPubkey,
      senderNametag: first.senderNametag,
      timestamp: Math.min(...batch.map((r) => r.receivedAt)),
      counted,
    },
    (from) => `${headline} ${amount} from ${from}${parts}${partial}${quoted("sender's memo", first.memo)}`,
    { tokenIds: batch.map((r) => r.tokenId), count: batch.length, amount, counted },
    eventMarks(st, "transfer", ids),
  ).catch((err: unknown) => st.log.error(`[unicity] transfer ${eventId} handling failed: ${errorMessage(err)}`));
}

export function onTransfer(st: InboundState, receipts: ReceiptBatcher, t: IncomingTransfer): void {
  st.touch();
  const receipt = receiptFromTransfer(t);
  if (st.receiptsSeen.has(receipt.eventId) || alreadyHandled(st, "transfer", receipt.eventId)) return;
  remember(st.receiptsSeen, receipt.eventId);
  receipts.push(receipt);
}

/** Wallets a start of this process has reconciled, i.e. whose watermark it found or set. */
const reconciledWallets = new WeakSet<Sphere>();

/**
 * The SDK announces each received token once. Receipts announced while no channel listened, or not delivered before
 * a stop, are recovered from payments.history(): RECEIVED rows newer than the persisted watermark without a handled
 * marker, at most HISTORY_MAX_ROWS rows back. History is a best-effort server record, so this recovers the common case
 * only. The first run starts the watermark just below the wallet's open: receipts announced before the channel
 * subscribed stay recoverable, and nothing from before the open is announced. A wallet this process already
 * reconciled that has no watermark lost its event state, delivery markers included: reading history back to the open
 * would announce every payment since again, so that run starts at now.
 */
export async function reconcileTransfers(st: InboundState): Promise<void> {
  if (!st.sphere.hasPayments) return;
  const stored = getTransferWatermark();
  const stateLost = stored === null && reconciledWallets.has(st.sphere);
  if (stateLost) {
    st.log.warn("[unicity] the handled-event state was lost while the wallet was open; payments received before now are not checked for missed notices");
  }
  const watermark = stored ?? (stateLost ? Date.now() : Math.min(getDmCutoff() ?? Date.now(), Date.now())) - 1;
  if (stored === null) setTransferWatermark(watermark);
  reconciledWallets.add(st.sphere);
  const rows: Receipt[] = [];
  let newest = watermark;
  let oldestRead = Infinity;
  let examined = 0;
  let capped = false;
  let before: string | undefined;
  for (let page = 1; ; page++) {
    const result = await withTimeout(
      st.sphere.payments.history({ limit: HISTORY_PAGE_SIZE, ...(before ? { before } : {}) }),
      HISTORY_TIMEOUT_MS,
      "payment history read",
    );
    if (aborted(st)) return;
    let reachedWatermark = false;
    for (const e of result.entries) {
      if (!(e.timestamp > watermark)) {
        reachedWatermark = true;
        continue;
      }
      examined++;
      newest = Math.max(newest, e.timestamp);
      oldestRead = Math.min(oldestRead, e.timestamp);
      if (e.type === "RECEIVED" && e.tokenId) rows.push(receiptFromHistory(e, e.tokenId));
    }
    // Pages are newest first.
    if (reachedWatermark || !result.more || !result.cursor) break;
    if (examined >= HISTORY_MAX_ROWS || page >= HISTORY_MAX_PAGES) {
      capped = true;
      break;
    }
    before = result.cursor;
  }
  if (capped) {
    st.log.warn(
      `[unicity] payment history reconcile stopped after ${examined} rows: received transfers between ` +
        `${isoTime(watermark)} and ${isoTime(Number.isFinite(oldestRead) ? oldestRead : Date.now())} are not checked for missed notices`,
    );
  }
  const unhandled = rows.filter((r) => !alreadyHandled(st, "transfer", r.eventId)).sort((a, b) => a.receivedAt - b.receivedAt);
  const fresh = unhandled.filter((r) => !st.receiptsSeen.has(r.eventId));
  for (const r of fresh) remember(st.receiptsSeen, r.eventId);
  for (const batch of groupByReceiptTime(fresh)) announceReceipts(st, batch);
  // Stay below everything not delivered yet, including receipts this start already holds, so a stop before they are
  // delivered cannot hide them from the next reconcile.
  const floor = unhandled.length > 0 ? unhandled[0].receivedAt - 1 : newest;
  if (floor > watermark) setTransferWatermark(floor);
}

export function onPaymentRequest(st: InboundState, r: PaymentRequestView): void {
  st.touch();
  // Re-listed on every start (reconcile) and re-emitted on hydration: this start's set plus the persisted marker.
  if (st.payreqsSeen.has(r.id) || alreadyHandled(st, "payreq", r.id)) return;
  remember(st.payreqsSeen, r.id);
  // Symbol and decimals come from the registry by coin id, never from the request.
  const amount = safeAmount(r.amount, r.coinId);
  void handleWalletEvent(
    st,
    { kind: "payment_request", id: r.id, senderPubkey: r.senderPubkey, senderNametag: r.senderNametag, timestamp: r.timestamp },
    (from) => `${NOTICE_HEADLINES.request} ${r.id}] ${from} is requesting ${amount}${quoted("requester's message", r.message)}`,
    { requestId: r.id, amount, status: r.status },
    eventMarks(st, "payreq", [r.id]),
  ).catch((err: unknown) => st.log.error(`[unicity] payment request ${r.id} handling failed: ${errorMessage(err)}`));
}

/** Pending requests that arrived while the gateway was down are not re-emitted by the SDK. */
export function reconcilePaymentRequests(st: InboundState): void {
  if (!st.sphere.hasPayments) return;
  let pending: PaymentRequestView[];
  try {
    pending = st.sphere.payments.requests.list().filter((r) => r.status === "pending");
  } catch (err) {
    st.log.debug?.(`[unicity] payment request reconcile skipped: ${errorMessage(err)}`);
    return;
  }
  for (const r of pending) onPaymentRequest(st, r);
}

/**
 * Direct messages: the subscribe-time replay filter, pairing requests, forwarding stranger DMs to the owner, and the
 * agent turn in the sender's DM session, which incoming transfers and payment requests use as well.
 */

import { createHash } from "node:crypto";
import type { DirectMessage, Sphere } from "@unicitylabs/sphere-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { hasConfiguredCommandOwner } from "./access.js";
import { CHANNEL_ID } from "./config.js";
import { shortKey, toXOnly, type NameCheck } from "./identity.js";
import { joinedGroupsEntry } from "./inbound-group.js";
import {
  aborted,
  alreadyHandled,
  belowDmFloor,
  decide,
  dispatchTurn,
  dropHostNotices,
  isOwnerKey,
  liveConfig,
  notifyOwner,
  ownerAllowFromCommand,
  ownerKeyKnown,
  remember,
  routeFacts,
  senderEntry,
  senderName,
  verifyName,
  unresolvedOwner,
  visibleText,
  type Delivery,
  type InboundState,
  type StructuredEntry,
} from "./inbound-shared.js";
import { buildUnicitySystemPrompt, type TransferCounted } from "./prompt.js";
import { getDmCutoff, getSphereOrNull } from "./sphere.js";
import { markEventsHandled } from "./storage.js";
import { dmText, markNoticeLookalikes, quoteLines } from "./text.js";
import { errorMessage } from "./util.js";

type DmScope = NonNullable<ResolvedAgentRoute["dmScope"]>;

/** At most one "pairing is paused" owner notice per window: unpaired senders can mint new keys freely. */
const PAIRING_PAUSED_NOTICE_MS = 10 * 60_000;
/**
 * DMs dated further ahead than this are dropped (see createDmFilter). Timestamps are the sender's clock, and a DM's
 * timestamp decides when its handled marker is evicted.
 */
const CLOCK_SKEW_MS = 5 * 60_000;
const FORWARD_TEXT_MAX = 2_000;
/** Sphere composing indicators expire after 30 s and have no stop event. */
const TYPING_KEEPALIVE_MS = 20_000;
const TYPING_MAX_MS = 180_000;
/**
 * Bounds of finishedDms: twice the SDK's DM cache caps (200 messages per conversation, 1000 in all), which hold every
 * DM a later start is replayed.
 */
const FINISHED_DMS_PER_SENDER_MAX = 400;
const FINISHED_DMS_MAX = 2_000;

/**
 * A DM's identity: sha256 of its authenticated sender key, its rumor timestamp and its text. The SDK's message id is
 * the outer gift wrap's event id, which nothing verifies: a relay can serve a DM it holds again under any id, and it
 * still decrypts to the same authenticated DM. Every replay guard (intake dedupe, finishedDms, the persisted markers,
 * core's MessageSid dedupe) uses this key instead. Rumor timestamps have whole-second resolution, so two DMs with the
 * same text from the same sender in the same second count as one.
 */
function dmKey(senderKey: string, timestamp: number, content: unknown): string {
  return createHash("sha256").update(JSON.stringify([senderKey, timestamp, dmText(content)])).digest("hex");
}

/** A DM the intake filter let through: its authenticated sender (x-only) and its identity (dmKey). */
export type AcceptedDm = { senderKey: string; key: string };

type FinishedDm = {
  ts: number;
  peer: string;
  /** Claimed by a start handing its turn to core: core refuses the turn if the DM's marker cannot be written. */
  taking?: boolean;
};

/**
 * Per wallet: DMs a start finished (dropped, pairing handled, turn run by core or being handed to it), by dmKey, with
 * the message time and sender key. Every start on the same wallet (a channel-only restart) is replayed the whole SDK
 * cache since the process-wide DM cutoff; this record keeps those DMs from being handled twice even when the persisted
 * marker is lost. Eviction follows the SDK's cache pruning (oldest message time first): per sender, so one sender's
 * flood cannot push out another's entries, then in all, where DMs the SDK cache no longer holds go first.
 *
 * The cache is not the only source of repeats: every relay subscription (each Sphere.init, each reconnect) re-delivers
 * the gift wraps of roughly the last 2-4 days, and the SDK emits a DM it has pruned from its cache as new. Such a DM
 * may have lost its entry here and its persisted marker, and a plugin reload opens a new Sphere with an empty record;
 * the persisted DM floor, raised whenever a marker is evicted, still marks it handled (handleDirectMessage).
 */
const finishedDms = new WeakMap<Sphere, Map<string, FinishedDm>>();

function finishedDmsOf(sphere: Sphere): Map<string, FinishedDm> {
  let finished = finishedDms.get(sphere);
  if (!finished) finishedDms.set(sphere, (finished = new Map()));
  return finished;
}

/** Evicts the oldest entries (by message time; earliest finished among equal ones) beyond `keep`. */
function evictOldest(finished: Map<string, FinishedDm>, entries: Array<[string, FinishedDm]>, keep: number): void {
  if (entries.length <= keep) return;
  const oldestFirst = [...entries].sort((a, b) => a[1].ts - b[1].ts);
  for (const [key] of oldestFirst.slice(0, entries.length - keep)) finished.delete(key);
}

function finishDm(st: InboundState, key: string, entry: FinishedDm): void {
  const finished = finishedDmsOf(st.sphere);
  finished.set(key, entry);
  evictOldest(finished, [...finished].filter(([, f]) => f.peer === entry.peer), FINISHED_DMS_PER_SENDER_MAX);
  if (finished.size <= FINISHED_DMS_MAX) return;
  try {
    const cached = new Set<string>();
    for (const conversation of st.sphere.communications.getConversations().values()) {
      for (const m of conversation) {
        const sender = toXOnly(m.senderPubkey);
        if (sender) cached.add(dmKey(sender, m.timestamp, m.content));
      }
    }
    for (const key of finished.keys()) if (!cached.has(key)) finished.delete(key);
  } catch (err) {
    st.log.debug?.(`[unicity] cannot read the DM cache: ${errorMessage(err)}`);
  }
  evictOldest(finished, [...finished], FINISHED_DMS_MAX);
}

/** A handled DM's marker: its timestamp (clamped) and sender, and for a DM dropped as dated ahead its own date. */
type DmMark = { ts: number; peer: string; aheadTs?: number };

/**
 * Persists a handled DM's marker, whose timestamp and sender decide its eviction and the DM floor it then leaves
 * (storage.ts); false when it was marked already. Throws when it cannot be written; the first failure in a start is
 * logged as an error, since no DM turn runs until the marker can be written (see handleDirectMessage).
 */
function writeDmMark(st: InboundState, key: string, mark: DmMark): boolean {
  try {
    return markEventsHandled("dm", [key], mark.ts, mark.peer, mark.aheadTs === undefined ? undefined : { aheadTs: mark.aheadTs }) > 0;
  } catch (err) {
    const text = `[unicity] cannot write the handled-DM state: ${errorMessage(err)}`;
    if (st.dmWriteFailed) {
      st.log.debug?.(text);
    } else {
      st.dmWriteFailed = true;
      st.log.error(
        `${text}. DMs are not being processed until it can be written (check free disk space and the data directory's ` +
          "permissions). Once it can, restart the unicity channel (channels.stop, then channels.start) or reload the " +
          "plugin to process each of them once; a relay delivering one again does not, and a gateway restart drops them",
      );
    }
    throw err;
  }
}

/**
 * Marks a DM that runs no turn (dropped, or a pairing request) handled: finishedDms for this wallet, and the persisted
 * marker as far as it can be written. A lost marker only lets a later start drop it, or ask for pairing, again.
 */
function markDmFinished(st: InboundState, key: string, mark: DmMark): void {
  finishDm(st, key, { ts: mark.ts, peer: mark.peer });
  try {
    writeDmMark(st, key, mark);
  } catch {
    // Logged by writeDmMark.
  }
}

/** Handled already: finished by a start on this Sphere, or marked on disk. */
function dmHandled(st: InboundState, key: string): boolean {
  return finishedDmsOf(st.sphere).has(key) || alreadyHandled(st, "dm", key);
}

/**
 * The DM cutoff this start applies now: its own, raised to the process-wide one once that rose after the start took
 * its own (ignoreDmsBefore: DMs a dmPolicy "disabled" start ignored). The start's own is lower than the process-wide
 * cutoff it started with when the channel started before the wallet opened (DMs from that gap are new), so only a
 * later raise counts. The process-wide cutoff is the open wallet's; once another wallet opens, this start is stopped.
 */
function liveDmCutoff(st: InboundState): number {
  const { own, processAtStart } = st.dmCutoff;
  const now = getDmCutoff();
  return now !== null && (processAtStart === null || now > processAtStart) ? Math.max(own, now) : own;
}

/** DM session scope: the operator's session.dmScope unless it is "main"; otherwise one session per sender key. */
export function resolveUnicityDmScope(cfg: OpenClawConfig): DmScope {
  const configured = cfg.session?.dmScope;
  return configured && configured !== "main" ? configured : "per-account-channel-peer";
}

/** The route of a DM-shaped turn from `peerKey`. A matching binding's session.dmScope wins over resolveUnicityDmScope. */
function resolveDirectRoute(st: InboundState, peerKey: string): ResolvedAgentRoute {
  return st.ch.routing.resolveAgentRoute({
    cfg: st.ctx.cfg,
    channel: CHANNEL_ID,
    accountId: st.ctx.accountId,
    peer: { kind: "direct", id: peerKey },
    dmScope: resolveUnicityDmScope(st.ctx.cfg),
  });
}

/** True, warned once per start, when `route` is the main session (see refusesNonOwnerRoute). */
function intoMainSession(st: InboundState, route: ResolvedAgentRoute): boolean {
  if (route.sessionKey !== route.mainSessionKey && route.lastRoutePolicy !== "main") return false;
  if (!st.dmRouteWarned) {
    st.dmRouteWarned = true;
    st.log.warn(
      `[unicity] DMs, transfers and payment requests from anyone but the owner are not answered: a binding ` +
        `(${route.matchedBy}) routes them into session ${route.sessionKey}, but they run only in the sender's own DM ` +
        "session (remove the binding's session.dmScope, or match the binding to the owner's key only)",
    );
  }
  return true;
}

/**
 * DM-shaped turns without owner authority (stranger DMs, everyone's transfers and payment requests but the owner's)
 * run only in the sender's own DM session, never in the main session, which holds the owner's conversations (other
 * channels, earlier wallet tool output) and which the owner's next turn reads. True when a binding's session.dmScope
 * routes `peerKey` there; a binding for the owner's key may still pin the owner's DMs to it.
 */
export function refusesNonOwnerRoute(st: InboundState, peerKey: string): boolean {
  return intoMainSession(st, resolveDirectRoute(st, peerKey));
}

function dmDelivery(st: InboundState, peerKey: string): Delivery {
  return {
    deliver: async (payload) => {
      const text = visibleText(payload);
      if (!text) return { visibleReplySent: false };
      const sphere = getSphereOrNull();
      if (!sphere) {
        throw new PlatformMessageNotDispatchedError("Unicity wallet is not open", { cause: new Error("sphere unavailable"), retryable: true });
      }
      // Always the authenticated transport key, never a claimed nametag.
      const sent = await sphere.communications.sendDM(peerKey, text);
      return { messageIds: [sent.id], visibleReplySent: true };
    },
    observeMessageSent: true,
    onError: (err, info) => st.log.error(`[unicity] ${info.kind} reply to ${shortKey(peerKey)} failed: ${errorMessage(err)}`),
  };
}

type DirectTurn = {
  kind: "dm" | "transfer" | "payment_request";
  peerKey: string;
  isOwner: boolean;
  messageId: string;
  timestamp: number;
  body: string;
  names: NameCheck;
  event?: StructuredEntry;
  /** Transfers: how much of it counts as payment. */
  counted?: TransferCounted;
};

/**
 * DM-shaped turn in the sender's DM session. Only the owner's own DMs carry owner authority; stranger DMs, transfers
 * and payment requests get the restricted tool allowlist and are not command-authorized. Transfers and payment
 * requests are channel notices and never interpreted as commands; a stranger's own DM text still is, so an operator
 * `commands.allowFrom` entry that matches the stranger can grant it the non-owner commands. The agent sees a
 * stranger's lines that hold a channel notice headline marked as the stranger's (markNoticeLookalikes). A non-owner
 * turn that a binding routes into the main session is not dispatched (refusesNonOwnerRoute; callers check it first).
 * `onAdmitted` runs before the agent does and may refuse the turn by throwing; resolves to whether core ran the turn
 * (see dispatchTurn).
 */
export async function runDirectTurn(st: InboundState, turn: DirectTurn, onAdmitted?: () => void): Promise<boolean> {
  const { ctx, ch, sphere } = st;
  const synthetic = turn.kind !== "dm";
  const restricted = synthetic || !turn.isOwner;
  const route = resolveDirectRoute(st, turn.peerKey);
  if (!turn.isOwner && intoMainSession(st, route)) return false;
  const name = senderName(turn.names, turn.peerKey);
  const ctxPayload = ch.inbound.buildContext({
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    messageId: turn.messageId,
    timestamp: turn.timestamp,
    from: `${CHANNEL_ID}:${turn.peerKey}`,
    sender: { id: turn.peerKey, name, ...(turn.names.verified ? { username: turn.names.verified } : {}) },
    conversation: { kind: "direct", id: turn.peerKey, label: name },
    route: routeFacts(route),
    reply: { to: turn.peerKey, originatingTo: turn.peerKey },
    message: { rawBody: turn.body, commandBody: turn.body, bodyForAgent: synthetic || turn.isOwner ? turn.body : markNoticeLookalikes(turn.body) },
    access: {
      commands: { authorized: !restricted },
      ...(restricted ? { toolPolicy: st.restrictedTools } : {}),
    },
    supplemental: {
      groupSystemPrompt: buildUnicitySystemPrompt({
        role: turn.isOwner ? "owner" : "stranger",
        kind: turn.kind,
        identity: sphere.identity ?? {},
        ownerKnown: ownerKeyKnown(),
        ...(turn.counted ? { counted: turn.counted } : {}),
      }),
      channelStructuredContext: [
        senderEntry(turn.peerKey, turn.isOwner, turn.names),
        ...(turn.event ? [turn.event] : []),
        ...(restricted ? [] : joinedGroupsEntry(st)),
      ],
    },
    ...(synthetic ? { extra: { CommandInterpretationSuppressed: true } } : {}),
  });
  return dispatchTurn(
    st,
    {
      cfg: ctx.cfg,
      channel: CHANNEL_ID,
      accountId: ctx.accountId,
      route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
      ctxPayload,
      messageId: turn.messageId,
      record: {
        onRecordError: (err) => st.log.warn(`[unicity] session record failed: ${errorMessage(err)}`),
        // Only the owner may move the main session's delivery route (operator bindings can pin DMs to main).
        ...(route.lastRoutePolicy === "main" && !restricted
          ? { updateLastRoute: { sessionKey: route.mainSessionKey, channel: CHANNEL_ID, to: turn.peerKey, accountId: route.accountId } }
          : {}),
      },
      delivery: dmDelivery(st, turn.peerKey),
      replyPipeline: {},
      replyOptions: { sourceReplyDeliveryMode: "automatic" },
      dispatcherOptions: {
        typingCallbacks: createTypingCallbacks({
          start: () => st.sphere.communications.sendComposingIndicator(turn.peerKey),
          onStartError: (err) => st.log.debug?.(`[unicity] composing indicator failed: ${errorMessage(err)}`),
          keepaliveIntervalMs: TYPING_KEEPALIVE_MS,
          maxDurationMs: TYPING_MAX_MS,
        }),
        ...(restricted ? { transformReplyPayload: dropHostNotices } : {}),
        onSkip: (_payload, info) => st.log.debug?.(`[unicity] reply skipped (${info.kind}/${info.reason})`),
      },
    },
    onAdmitted,
  );
}

/**
 * Self, duplicate, history and future-date filter. Must exist before onDirectMessage, which replays the cache
 * synchronously. History is everything before the live DM cutoff (liveDmCutoff). Timestamps are the sender's clock: DMs
 * dated more than CLOCK_SKEW_MS ahead are dropped, live ones too; otherwise a flood dated ahead would keep the newest
 * handled-DM markers, so every later DM's marker would be evicted first. A dropped one is marked handled, dated
 * CLOCK_SKEW_MS ahead like any marker, with its own date kept beside it: once that marker is evicted, the sender's DM
 * floor rises to that date (up to a horizon, see storage.ts). So it does not run later instead, once the clock has
 * caught up with it (a restart's cache replay, a relay re-delivery); the sender's own DMs dated before it are then
 * skipped too.
 */
export function createDmFilter(st: InboundState): (msg: DirectMessage) => AcceptedDm | null {
  let warnedAhead = false;
  return (msg) => {
    const senderKey = toXOnly(msg.senderPubkey);
    // Replayed own messages carry the 66-hex chain key; toXOnly maps it onto the self set.
    if (!senderKey || st.selfKeys.has(senderKey)) return null;
    const key = dmKey(senderKey, msg.timestamp, msg.content);
    if (st.dmsSeen.has(key)) return null;
    remember(st.dmsSeen, key);
    if (!(msg.timestamp >= liveDmCutoff(st))) return null;
    const latest = Date.now() + CLOCK_SKEW_MS;
    if (msg.timestamp > latest) {
      if (dmHandled(st, key)) return null;
      const text = `[unicity] DM from ${shortKey(senderKey)} dropped: dated more than ${CLOCK_SKEW_MS / 60_000} minutes ahead of this clock`;
      if (warnedAhead) st.log.debug?.(text);
      else st.log.warn(`${text} (if every DM is dropped, check this host's clock)`);
      warnedAhead = true;
      markDmFinished(st, key, { ts: latest, peer: senderKey, aheadTs: msg.timestamp });
      return null;
    }
    return { senderKey, key };
  };
}

/** Stranger DM text as a quoted block: every line starts with "> ", so it cannot imitate a notice line. */
function forwardedBody(text: string): string {
  return quoteLines(text.length > FORWARD_TEXT_MAX ? `${text.slice(0, FORWARD_TEXT_MAX - 1)}…` : text);
}

/**
 * A DM counts as handled (finishedDms and the persisted "dm" marker, both by dmKey) once its outcome is final: dropped,
 * pairing handled, or its turn run. A DM turn runs only once its marker is written: core recorded the turn and is about
 * to run it (dispatchTurn's onAdmitted), and a marker that cannot be written, or that was written meanwhile, then
 * refuses the turn. Nothing else would keep a turn that ran from running again after a plugin reload, which opens a new
 * Sphere (an empty finishedDms record) and keeps the DM cutoff, so the cache replay or a relay re-delivery would
 * present it again. A DM refused for an unwritable marker stays unhandled: once the marker can be written it runs at a
 * later start (a channel restart or plugin reload), which is replayed the cache. A relay delivering the same gift wrap
 * again does not reach this start (the SDK drops a repeated event id); only a copy under a new event id does, and this
 * start takes that in again, as does a newer start that met the DM while it was being handed to core. So does a DM
 * still gated or queued when the channel stops, or whose turn core did not take, and one whose drop or pairing request
 * may rest on a failed lookup (leaveUndecided). A stranger's DM is forwarded to the owner only along with its turn, so
 * a refused one is not forwarded twice either. A DM dated at or below the persisted DM floor counts as handled without
 * a marker: a marker as new as it was evicted, so it may have been handled.
 */
export async function handleDirectMessage(st: InboundState, msg: DirectMessage, dm: AcceptedDm): Promise<void> {
  const { senderKey, key } = dm;
  const content = dmText(msg.content);
  // A raised cutoff applies to DMs this start already took in.
  if (!(msg.timestamp >= liveDmCutoff(st))) {
    st.log.debug?.(`[unicity] DM from ${shortKey(senderKey)} skipped: dated before the DM cutoff`);
    return;
  }
  if (finishedDmsOf(st.sphere).get(key)?.taking) {
    // An earlier start (a channel restart raced it) is still handing it to core, which refuses it if its marker cannot
    // be written: a later copy (under a new event id) is looked at again.
    st.dmsSeen.delete(key);
    return;
  }
  if (dmHandled(st, key)) return;
  if (belowDmFloor(st, msg.timestamp, senderKey)) {
    st.log.info(`[unicity] DM from ${shortKey(senderKey)} skipped: it is not newer than handled DMs whose markers were evicted`);
    return;
  }
  // createDmFilter let it through within CLOCK_SKEW_MS of now; clamped again should the clock have gone back since.
  const mark: DmMark = { ts: Math.min(msg.timestamp, Date.now() + CLOCK_SKEW_MS), peer: senderKey };
  await st.ownerReady;
  const isOwner = await isOwnerKey(st, senderKey);
  const { decision, undecided } = await decide(st, senderKey, isOwner, true, msg.senderNametag);
  if (aborted(st)) return;
  if (decision.kind !== "admit" && undecided) {
    leaveUndecided(st, key, senderKey, undecided);
    return;
  }
  if (decision.kind === "drop") {
    markDmFinished(st, key, mark);
    st.log.debug?.(`[unicity] DM from ${shortKey(senderKey)} dropped (${decision.reason})`);
    return;
  }
  const names = await verifyName(st, msg.senderNametag, senderKey);
  if (aborted(st)) return;
  const label = st.names.label(names, senderKey);
  if (decision.kind === "pair") {
    markDmFinished(st, key, mark);
    await requestPairing(st, senderKey, names, label);
    return;
  }
  // Handled like a drop: no turn, and nothing forwarded. While a nametag owner is unresolved the sender may be the
  // owner, whose DMs may run in the main session: left undecided instead, so a later start decides it again.
  if (!isOwner && refusesNonOwnerRoute(st, senderKey)) {
    const maybeOwner = unresolvedOwner(st, msg.senderNametag);
    if (maybeOwner) leaveUndecided(st, key, senderKey, maybeOwner);
    else markDmFinished(st, key, mark);
    return;
  }
  st.log.info(`[unicity] DM from ${label}${isOwner ? " (owner)" : ""}`);
  const turn: DirectTurn = { kind: "dm", peerKey: senderKey, isOwner, messageId: key, timestamp: msg.timestamp, body: content, names };
  const forward = isOwner ? null : `[Forwarded DM from ${label}]:\n${forwardedBody(content)}`;
  // Claimed while core takes it: a restart racing the dispatch must not hand the same DM to core again.
  const claim: FinishedDm = { ts: mark.ts, peer: senderKey, taking: true };
  finishDm(st, key, claim);
  let ran = false;
  let marked = false;
  let unwritable = false;
  try {
    ran = await runDirectTurn(st, turn, () => {
      try {
        marked = writeDmMark(st, key, mark);
      } catch (err) {
        unwritable = true;
        throw err;
      }
      // Marked since the check above (by another gateway process that took the wallet over): it never runs twice.
      if (!marked) throw new Error("[unicity] the DM was marked handled meanwhile");
      delete claim.taking;
      // Nothing after the marker may throw: that would refuse a turn already marked handled.
      if (forward) notifyOwner(st, forward);
    });
  } finally {
    delete claim.taking;
    // A turn marked handled stays finished, also when core failed after the marker was written.
    if (!ran && !marked) {
      const finished = finishedDmsOf(st.sphere);
      if (finished.get(key) === claim) finished.delete(key);
      // Taken in again should a copy arrive under a new event id, as writes may work by then.
      if (unwritable) st.dmsSeen.delete(key);
    }
  }
}

/**
 * A DM whose drop or pairing request may rest on a lookup that failed for now (see decide) is not final: nothing is
 * marked, no pairing request is made (the sender may be approved, or the owner), and the next start (a channel restart
 * or plugin reload, which is replayed the cache) decides it again. No turn ran, so nothing runs twice. Warned once per
 * start and reason.
 */
function leaveUndecided(st: InboundState, key: string, senderKey: string, reason: string): void {
  // A copy under a new event id is looked at again in this start.
  st.dmsSeen.delete(key);
  const text = `[unicity] DM from ${shortKey(senderKey)} left undecided: ${reason}`;
  if (st.undecidedWarned.has(reason)) {
    st.log.debug?.(text);
    return;
  }
  st.undecidedWarned.add(reason);
  st.log.warn(`${text}. Such DMs are decided again when the unicity channel restarts or the plugin reloads (not after a gateway restart)`);
}

/**
 * Pairing fails closed while core has no command owner: `openclaw pairing approve` would then make the approved
 * stranger the command owner (owners never pair, so the first request is always a stranger's).
 */
async function requestPairing(st: InboundState, senderKey: string, names: NameCheck, label: string): Promise<void> {
  if (!hasConfiguredCommandOwner(liveConfig(st.ctx))) {
    if (!st.pairing.claim(senderKey)) return;
    st.log.warn(`[unicity] pairing request from ${label} ignored: no command owner is configured. Run: ${ownerAllowFromCommand()}`);
    const now = Date.now();
    if (st.pairingPausedNoticeAt !== null && now - st.pairingPausedNoticeAt < PAIRING_PAUSED_NOTICE_MS) return;
    st.pairingPausedNoticeAt = now;
    notifyOwner(
      st,
      `[Access request] ${label} wants to message me, but pairing is paused: no command owner is configured, so approving ` +
        `would make this sender an OpenClaw command owner. First run: ${ownerAllowFromCommand()}`,
    );
    return;
  }
  const meta: Record<string, string> | undefined = names.verified
    ? { nametag: `@${names.verified}` }
    : names.claimed
      ? { claimedNametag: `@${names.claimed}` }
      : undefined;
  const challenge = await st.pairing.challenge(senderKey, meta, async (text) => {
    // The request exists now; the owner notice below still carries the code if this DM fails.
    await st.sphere.communications
      .sendDM(senderKey, text)
      .catch((err: unknown) => st.log.warn(`[unicity] pairing code DM to ${shortKey(senderKey)} failed: ${errorMessage(err)}`));
  });
  if (challenge?.created) {
    notifyOwner(st, `[Access request] ${label} wants to message me. Approve with: openclaw pairing approve unicity ${challenge.code}`);
  }
}

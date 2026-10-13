/**
 * Inbound pipeline state and helpers shared by the DM, group and wallet-event handlers: the per-start InboundState,
 * owner checks and notices, sender naming, DM access decisions, and turn dispatch.
 */

import type { GroupMessageData, Sphere } from "@unicitylabs/sphere-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { BuildChannelInboundEventContextParams, ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import type { ChannelRunQueue } from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { decideDmAccess, type AccessDecision, type AllowFromResolver, type PairingChallenger } from "./access.js";
import type { ResolvedUnicityAccount } from "./channel.js";
import { CHANNEL_ID, type DmPolicy } from "./config.js";
import { getOwnerAuthority, sanitizeNametagClaim, shortKey, type NameCheck, type NameVerifier } from "./identity.js";
import { getUnicityRuntime, type UnicityLogger } from "./runtime.js";
import { getSphereOrNull } from "./sphere.js";
import { areEventsHandled, isBelowDmFloor, replaceEventsHandled, type HandledEventKind } from "./storage.js";
import { errorMessage, withTimeout } from "./util.js";

type ChannelRuntime = PluginRuntime["channel"];
export type GatewayContext = ChannelGatewayContext<ResolvedUnicityAccount>;
type TurnPlan = ChannelInboundTurnPlan;
export type Delivery = TurnPlan["delivery"];
type BuildParams = BuildChannelInboundEventContextParams;
type ToolPolicy = NonNullable<NonNullable<BuildParams["access"]>["toolPolicy"]>;
export type StructuredEntry = NonNullable<NonNullable<BuildParams["supplemental"]>["channelStructuredContext"]>[number];

/** Upper bound on holding an event for a later owner-nametag lookup retry while no owner key is known. */
const OWNER_RETRY_WAIT_MS = 5_000;
/** Upper bound on forward-verifying a claimed nametag before labelling the sender as unverified. */
const NAME_VERIFY_TIMEOUT_MS = 5_000;
/** Bound of the per-start dedupe sets (DM ids, payment request ids, transfer receipts). */
const SEEN_MAX = 1_000;

/** Drops host-generated notices (model fallback, status, compaction, errors, reasoning) on turns not owned by the owner. */
export function dropHostNotices(payload: ReplyPayload): ReplyPayload | null {
  if (
    payload.isFallbackNotice ||
    payload.isStatusNotice ||
    payload.isCompactionNotice ||
    payload.isError ||
    payload.isReasoning ||
    payload.isCommentary
  ) {
    return null;
  }
  return payload;
}

export function visibleText(payload: ReplyPayload): string | undefined {
  const text = payload.text?.trim() ? payload.text : payload.fallbackText?.text;
  return text?.trim() ? text : undefined;
}

/** Adds to a bounded dedupe set, evicting the oldest entry. */
export function remember(set: Set<string>, id: string): void {
  set.add(id);
  if (set.size > SEEN_MAX) set.delete(set.values().next().value!);
}

export type InboundState = {
  ctx: GatewayContext;
  ch: ChannelRuntime;
  sphere: Sphere;
  log: UnicityLogger;
  queue: ChannelRunQueue;
  /** x-only keys of this wallet (DM transport key == group key == x-only chain key). */
  selfKeys: Set<string>;
  /** Key of the persisted approved-group set (the wallet's chain key); null fails group admission closed. */
  walletKey: string | null;
  /**
   * This start's DM cutoff, and the process-wide one (getDmCutoff) when the start took it: a later raise of the
   * process-wide one applies to this start too (inbound-dm.ts).
   */
  dmCutoff: { own: number; processAtStart: number | null };
  /** DMs (by dmKey) this start took in; one whose turn was refused for an unwritable marker leaves it again. */
  dmsSeen: Set<string>;
  /** A DM marker could not be written in this start (the error is logged once). */
  dmWriteFailed: boolean;
  names: NameVerifier;
  allow: AllowFromResolver;
  pairing: PairingChallenger;
  /** When the last "pairing is paused" owner notice went out. */
  pairingPausedNoticeAt: number | null;
  policy: DmPolicy;
  allowFrom: string[];
  /** The configured ownerPubkeys (x-only): beside a nametag owner, any other owner key is its pinned one. */
  ownerPubkeys: ReadonlySet<string>;
  /** Why DMs were left undecided in this start (see decide), each warned once. */
  undecidedWarned: Set<string>;
  /** A binding that routes non-owner DM-shaped turns into the main session was warned about (inbound-dm.ts). */
  dmRouteWarned: boolean;
  /** Tool policy of DM-shaped turns without owner authority (stranger DMs, transfers, payment requests). */
  restrictedTools: ToolPolicy;
  /** Tool policy of every group turn: narrower still, since a payment request to a group sender belongs in a DM. */
  groupTools: ToolPolicy;
  ownerReady: Promise<void>;
  /** When this start began, floored to the second like DM rumor and group event times. */
  startedAt: number;
  /** Group messages taken on by this start and not dispatched yet, by id: a stop hands them to the next start. */
  groupPending: Map<string, GroupMessageData>;
  /** Groups whose turns an operator binding routes outside their own group session (warned once). */
  groupRoutesRefused: Set<string>;
  /** Wallet events taken on by this start; the persisted marker is only written once an event is delivered. */
  payreqsSeen: Set<string>;
  receiptsSeen: Set<string>;
  /** Groups the unapproved-group check already looked at in this start; a revoked group is looked at again. */
  groupsChecked: Set<string>;
  groupStateWarned: boolean;
  /** Set by cleanup: a start replaced by a newer one (stopPreviousStart) stops working even if its signal never aborts. */
  stopped: boolean;
  touch: () => void;
};

/** The wallet this start is bound to was closed (service stop before the channel stop, lock loss) or replaced. */
export const walletGone = (st: InboundState): boolean => getSphereOrNull() !== st.sphere;

/** The start must not take anything further: it was stopped or replaced, or its wallet is gone (nothing could reply). */
export const aborted = (st: InboundState): boolean => st.stopped || st.ctx.abortSignal.aborted || walletGone(st);

/**
 * Persisted handled-event check: true when every id is marked (a batch is read once). An unreadable state file counts
 * as handled for DMs, whose replay could repeat an owner instruction, and as not handled for wallet events, where a
 * repeat is only a repeated notice or turn.
 */
export function alreadyHandled(st: InboundState, kind: HandledEventKind, ids: string | readonly string[]): boolean {
  try {
    return areEventsHandled(kind, typeof ids === "string" ? [ids] : ids);
  } catch (err) {
    st.log.warn(
      `[unicity] cannot read handled ${kind} events: ${errorMessage(err)}` +
        (kind === "dm" ? "; DMs are not answered until the event state file is repaired" : ""),
    );
    return kind === "dm";
  }
}

/**
 * DM floor check: true when a DM from `peer` dated `ts` is not newer than a handled DM whose marker was evicted (from
 * the sender's markers or from all), so it may have been handled. An unreadable state file counts as below the floor,
 * as it counts as handled for alreadyHandled.
 */
export function belowDmFloor(st: InboundState, ts: number, peer: string): boolean {
  try {
    return isBelowDmFloor(ts, peer);
  } catch (err) {
    st.log.warn(`[unicity] cannot read the handled-DM floor: ${errorMessage(err)}; DMs are not answered until the event state file is repaired`);
    return true;
  }
}

/**
 * Marks wallet events handled, removing `replaced` (their earlier markers) in the same write; a batch in one atomic
 * write, so it is never left half marked. A failed write only repeats a notice or turn later. DMs are marked by
 * inbound-dm.ts: a DM turn runs only once its marker is written.
 */
export function markHandled(st: InboundState, kind: "payreq" | "transfer", ids: readonly string[], replaced: readonly string[] = []): void {
  try {
    replaceEventsHandled(kind, ids, replaced);
  } catch (err) {
    st.log.warn(`[unicity] cannot persist handled ${kind} ${ids.join(", ")}: ${errorMessage(err)}`);
  }
}

/** The gateway's current config; ctx.cfg is the snapshot this start was launched with. */
export function liveConfig(ctx: GatewayContext): unknown {
  try {
    return getUnicityRuntime().config.current();
  } catch {
    return ctx.cfg;
  }
}

/**
 * Owner check by authenticated key. A nametag owner whose lookup failed at startup (relay down, timeout) is looked up
 * again here instead of staying a stranger until restart. OwnerAuthority throttles the retries (and stops once
 * settled); the event waits for one, bounded, only while no owner key is known at all.
 */
export async function isOwnerKey(st: InboundState, key: string | null): Promise<boolean> {
  const owner = getOwnerAuthority();
  if (!owner) return false;
  const retry = owner.resolve(st.sphere, { timeoutMs: OWNER_RETRY_WAIT_MS }).catch(() => undefined);
  if (owner.notifyTarget() === null) await retry;
  return !!key && owner.isOwnerKey(key);
}

/** An owner key is trusted, so owner notices and DM forwards have a recipient. */
export function ownerKeyKnown(): boolean {
  return (getOwnerAuthority()?.notifyTarget() ?? null) !== null;
}

/** True when the notice was sent, or when there is nobody to send it to (no owner configured, or the owner is this wallet). */
export async function sendOwnerNotice(st: InboundState, text: string): Promise<boolean> {
  const owner = getOwnerAuthority();
  const target = owner?.notifyTarget() ?? null;
  if (!target) return !owner?.hasOwnerConfigured();
  if (st.selfKeys.has(target)) return true;
  try {
    await st.sphere.communications.sendDM(target, text);
    return true;
  } catch (err) {
    st.log.error(`[unicity] owner notice failed: ${errorMessage(err)}`);
    return false;
  }
}

export function notifyOwner(st: InboundState, text: string): void {
  void sendOwnerNotice(st, text);
}

/** The command that stops `openclaw pairing approve` from making the approved sender a command owner. */
export function ownerAllowFromCommand(): string {
  const key = getOwnerAuthority()?.ownerKeys()[0] ?? "<owner-pubkey>";
  return `openclaw config set commands.ownerAllowFrom '["unicity:${key}"]'`;
}

export async function verifyName(st: InboundState, rawClaim: string | undefined, key: string): Promise<NameCheck> {
  const claimed = sanitizeNametagClaim(rawClaim);
  if (!claimed) return {};
  try {
    return await withTimeout(st.names.verify(claimed, key), NAME_VERIFY_TIMEOUT_MS, "nametag verification");
  } catch {
    return { claimed };
  }
}

export function senderName(names: NameCheck, key: string): string {
  return names.verified ? `@${names.verified}` : shortKey(key);
}

/** `viaRelay`: the key is only the group relay's word, so the role is informational, never authority. */
export function senderEntry(key: string, isOwner: boolean, names: NameCheck, viaRelay = false): StructuredEntry {
  return {
    label: "Unicity sender",
    source: CHANNEL_ID,
    type: "unicity_sender",
    payload: {
      pubkey: key,
      role: isOwner ? "owner" : "stranger",
      ...(viaRelay ? { authenticatedBy: "group relay (event signature not verified)" } : {}),
      ...(names.verified ? { nametag: `@${names.verified}` } : {}),
      ...(!names.verified && names.claimed ? { claimedNametag: `@${names.claimed}`, nametagVerified: false } : {}),
    },
  };
}

/**
 * Why a sender that is not a trusted owner key may still turn out to be a nametag owner whose lookup has not succeeded
 * yet; null when it cannot. While no owner key is trusted at all, that is any sender. Beside configured ownerPubkeys it
 * is only a sender claiming the owner's nametag (`rawClaim`, unverified): OwnerAuthority shows the trusted keys only,
 * so a pinned key that ownerPubkeys lists too looks like no pin at all, and every other sender must still be decided.
 * The claim only ever holds a decision back, never admits.
 */
export function unresolvedOwner(st: InboundState, rawClaim: string | undefined): string | null {
  const owner = getOwnerAuthority();
  if (!owner?.nametag) return null;
  const keys = owner.ownerKeys();
  if (!keys.every((k) => st.ownerPubkeys.has(k))) return null;
  if (keys.length === 0) return `the owner @${owner.nametag} is not resolved yet`;
  if (sanitizeNametagClaim(rawClaim) !== owner.nametag) return null;
  return `it claims to be the owner @${owner.nametag}, who may not be resolved yet`;
}

/** An access decision; `undecided` says why one that is not an admission may be wrong (see decide). */
export type DmDecision = { decision: AccessDecision; undecided?: string };

/**
 * DM admission. A decision other than admit is undecided when it may rest on a lookup that failed for now: an
 * allowFrom @nametag that could not be looked up (and has no recent key), an unreadable pairing store, or a nametag
 * owner whose key is not known yet while the sender may be the owner (unresolvedOwner; `rawClaim` is the DM's claimed
 * nametag). Wallet events use the decision as it is.
 */
export async function decide(
  st: InboundState,
  senderKey: string,
  isOwner: boolean,
  mayPair: boolean,
  rawClaim?: string,
): Promise<DmDecision> {
  const none = new Set<string>();
  if (st.policy === "disabled" || st.policy === "open" || isOwner) {
    return { decision: decideDmAccess({ policy: st.policy, senderKey, isOwner, allowKeys: none, allowAll: false, pairedKeys: none, mayPair }) };
  }
  const { keys, allowAll, unresolved } = await st.allow.resolve(st.allowFrom);
  let storeFailed = false;
  const pairedKeys =
    st.policy === "pairing"
      ? await st.pairing.readPairedKeys().catch((err: unknown) => {
          st.log.warn(`[unicity] pairing store read failed: ${errorMessage(err)}`);
          storeFailed = true;
          return none;
        })
      : none;
  const decision = decideDmAccess({ policy: st.policy, senderKey, isOwner, allowKeys: keys, allowAll, pairedKeys, mayPair });
  if (decision.kind === "admit") return { decision };
  const owner = unresolvedOwner(st, rawClaim);
  const reasons = [
    ...(unresolved.length > 0 ? [`allowFrom ${unresolved.join(", ")} could not be looked up`] : []),
    ...(storeFailed ? ["the pairing store could not be read"] : []),
    ...(owner ? [owner] : []),
  ];
  return reasons.length > 0 ? { decision, undecided: reasons.join("; ") } : { decision };
}

// ---------------------------------------------------------------------------
// Turn dispatch
// ---------------------------------------------------------------------------

export function routeFacts(route: ResolvedAgentRoute): BuildParams["route"] {
  return {
    agentId: route.agentId,
    dmScope: route.dmScope,
    accountId: route.accountId,
    routeSessionKey: route.sessionKey,
    dispatchSessionKey: route.sessionKey,
    mainSessionKey: route.mainSessionKey,
  };
}

/**
 * Hands the turn to core and returns whether core ran it. `onAdmitted` runs once core has recorded the turn in its
 * session (afterRecord) and before the agent runs: only then does the event count as handled. It throws to refuse the
 * turn (inbound-dm.ts does when a DM's handled marker cannot be written), and a wallet closed by then (plugin reload,
 * lock loss) refuses it too: core ends the dispatch with afterRecord's error, so the agent never runs. A turn run but
 * left unmarked would run again after a plugin reload, which keeps the DM cutoff. A refused turn, and one core throws
 * on or declines before afterRecord, stays unhandled for a later start.
 */
export async function dispatchTurn(st: InboundState, plan: TurnPlan, onAdmitted?: () => void): Promise<boolean> {
  // Gating awaits (owner settle, lookups) can span a stop; never start a turn for a stopped channel or a closed wallet.
  if (aborted(st)) return false;
  const id = plan.messageId ?? "";
  let admitted = false;
  // Set inside core's dispatch when afterRecord refuses the turn.
  const refused: { by?: "wallet" | "admission" } = {};
  const afterRecord = (): void => {
    if (admitted) return;
    if (walletGone(st)) {
      refused.by = "wallet";
      throw new Error("[unicity] the wallet closed while core recorded the turn");
    }
    try {
      onAdmitted?.();
    } catch (err) {
      refused.by = "admission";
      throw err;
    }
    admitted = true;
  };
  let result: Awaited<ReturnType<ChannelRuntime["inbound"]["dispatch"]>>;
  try {
    result = await st.ch.inbound.dispatch({ ...plan, afterRecord });
  } catch (err) {
    if (refused.by === "wallet") st.log.info(`[unicity] turn ${id} left to the next start: the wallet closed while core recorded it`);
    else if (refused.by === "admission") st.log.debug?.(`[unicity] turn ${id} not run: ${errorMessage(err)}`);
    else throw err;
    return false;
  }
  if (result.dispatched) {
    // Core reports a turn dispatched only after afterRecord; should it ever skip that call, the turn still ran.
    if (!admitted) {
      admitted = true;
      try {
        onAdmitted?.();
      } catch (err) {
        st.log.error(`[unicity] turn ${id} ran but could not be recorded as handled: ${errorMessage(err)}`);
      }
    }
  } else {
    const reason = "reason" in result.admission && result.admission.reason ? `: ${result.admission.reason}` : "";
    st.log.warn(`[unicity] turn ${id} not dispatched (${result.admission.kind}${reason})`);
  }
  return admitted;
}

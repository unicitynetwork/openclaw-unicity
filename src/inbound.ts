/**
 * Inbound pipeline of the Unicity channel (gateway.startAccount).
 *
 * DMs, group messages, incoming transfers and payment requests become agent turns through the routed channel-turn API
 * (routing.resolveAgentRoute + inbound.buildContext + inbound.dispatch). Authority comes only from keys that
 * authenticate their sender: the DM seal key and the transfer/request chain key (as x-only). A group event key is only
 * vouched for by the group relay (the SDK does not verify group event signatures), so group turns never carry owner
 * authority. Claimed nametags are forward-verified against the authenticated key when one exists; an unverified claim
 * is only ever shown as "(claims @x, unverified)" beside the key, and never selects a session, a reply target or a role.
 *
 * This module starts and stops the account and wires the subscriptions; the handlers live in inbound-dm.ts,
 * inbound-group.ts and inbound-wallet.ts, their shared state and helpers in inbound-shared.ts.
 */

import type { GroupMessageData, IncomingTransfer, Sphere } from "@unicitylabs/sphere-sdk";
import { createAccountStatusSink, createChannelRunQueue, waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { AllowFromResolver, PairingChallenger, effectiveDmPolicy, hasConfiguredCommandOwner } from "./access.js";
import { readPluginConfig } from "./config.js";
import { getOwnerAuthority, shortKey, toXOnly } from "./identity.js";
import { createDmFilter, handleDirectMessage } from "./inbound-dm.js";
import {
  attachGroupIntake,
  createGroupBackfill,
  enqueueGroupTurn,
  groupApproved,
  groupReplay,
  replayConnected,
  reportUnapprovedGroups,
  shownGroupId,
} from "./inbound-group.js";
import { liveConfig, ownerAllowFromCommand, type GatewayContext, type InboundState } from "./inbound-shared.js";
import {
  announceReceipts,
  createReceiptBatcher,
  onPaymentRequest,
  onTransfer,
  reconcilePaymentRequests,
  reconcileTransfers,
  type PaymentRequestView,
} from "./inbound-wallet.js";
import { groupToolPolicy, nonOwnerToolPolicy } from "./owner-gate.js";
import { getUnicityRuntime, type UnicityLogger } from "./runtime.js";
import { getDmCutoff, getNameVerifier, getSphereOrNull, ignoreDmsBefore, subscribeWalletEvents, waitForSphere } from "./sphere.js";
import { errorMessage } from "./util.js";

export { resolveUnicityDmScope } from "./inbound-dm.js";

/** Upper bound on holding the first DMs while the owner key is being resolved. */
const OWNER_SETTLE_MS = 25_000;

let previousGatewayCleanup: (() => void) | null = null;

/**
 * One allowFrom resolver per wallet, shared by its starts: its last good keys stand in for a failed lookup after a
 * channel restart too, and the restart looks failed names up again (DMs left undecided on them are decided then). A
 * plugin reload opens a new wallet (possibly on another network) and starts afresh.
 */
const allowResolvers = new WeakMap<Sphere, AllowFromResolver>();

function allowResolverFor(sphere: Sphere, log: UnicityLogger): AllowFromResolver {
  let resolver = allowResolvers.get(sphere);
  if (!resolver) allowResolvers.set(sphere, (resolver = new AllowFromResolver(getSphereOrNull, log)));
  resolver.log = log;
  resolver.retryFailed();
  return resolver;
}

/** Tears down the subscriptions of an earlier start of this account, if any are still live. */
function stopPreviousStart(): void {
  const previous = previousGatewayCleanup;
  previousGatewayCleanup = null;
  previous?.();
}

/** DM rumor timestamps have whole-second resolution: cutoffs are floored so a DM from this very second is not history. */
function nowSecond(): number {
  return Math.floor(Date.now() / 1000) * 1000;
}

function channelLogger(ctx: GatewayContext): UnicityLogger {
  return {
    info: (m) => ctx.log?.info(m),
    warn: (m) => ctx.log?.warn(m),
    error: (m) => ctx.log?.error(m),
    debug: (m) => ctx.log?.debug?.(m),
  };
}

/** gateway.startAccount: waits for the wallet (channels start before plugin services), subscribes, and stays pending until abort. */
export async function startUnicityAccount(ctx: GatewayContext): Promise<void> {
  const { accountId, abortSignal } = ctx;
  const startedAt = nowSecond();
  const log = channelLogger(ctx);
  const status = createAccountStatusSink({ accountId, setStatus: ctx.setStatus });
  stopPreviousStart();
  status({ running: true, lifecycle: "starting" });

  const sphere = getSphereOrNull() ?? (await waitForSphere({ signal: abortSignal }));
  if (abortSignal.aborted) return;
  if (!sphere) throw new Error("[unicity] wallet is not available");
  // Cached DMs older than the cutoff are history; later ones are new, including DMs that arrived while the wallet opened,
  // the channel restarted or the plugin reloaded (the cutoff lasts for the process while the same wallet reopens), but
  // not DMs a "disabled" start ignored (it raised the cutoff, also for a start already running). Handled ones are
  // skipped by their identity (dmKey), and those whose marker was evicted by the persisted DM floor
  // (handleDirectMessage): relays re-deliver days of DMs on every new subscription.
  const processCutoff = getDmCutoff();
  const dmCutoff = { own: Math.min(processCutoff ?? startedAt, startedAt), processAtStart: processCutoff };

  const ch = getUnicityRuntime().channel;
  const queue = createChannelRunQueue({
    setStatus: status,
    abortSignal,
    onError: (err) => log.error(`[unicity] inbound turn failed: ${errorMessage(err)}`),
  });

  const owner = getOwnerAuthority();
  if (owner) owner.resolve(sphere).catch(() => undefined);
  else log.warn("[unicity] owner authority is not initialized; every sender is treated as a stranger");
  const ownerReady = owner ? owner.whenSettled(OWNER_SETTLE_MS).catch(() => undefined) : Promise.resolve();

  const policy = effectiveDmPolicy(ctx.account.config.dmPolicy, ctx.account.config.allowFrom);
  if (policy !== (ctx.account.config.dmPolicy ?? "open")) {
    log.warn('[unicity] dmPolicy "open" with allowFrom entries and no "*": only the listed senders are admitted');
  }
  if (policy === "pairing") {
    void ownerReady.then(() => {
      if (abortSignal.aborted || hasConfiguredCommandOwner(liveConfig(ctx))) return;
      log.warn(
        "[unicity] pairing is paused: commands.ownerAllowFrom names no command owner, and approving a pairing request " +
          `would make that sender one. Run: ${ownerAllowFromCommand()}`,
      );
    });
  }
  const { strangerToolsAllow, ownerPubkeys } = readPluginConfig(ctx.cfg);
  const selfKeys = new Set<string>();
  for (const k of [sphere.identity?.chainPubkey, sphere.groupChat?.getMyPublicKey()]) {
    const x = toXOnly(k);
    if (x) selfKeys.add(x);
  }

  const st: InboundState = {
    ctx,
    ch,
    sphere,
    log,
    queue,
    selfKeys,
    walletKey: sphere.identity?.chainPubkey ?? null,
    dmCutoff,
    dmsSeen: new Set(),
    dmWriteFailed: false,
    names: getNameVerifier(),
    allow: allowResolverFor(sphere, log),
    pairing: new PairingChallenger(ch.pairing, accountId),
    pairingPausedNoticeAt: null,
    policy,
    allowFrom: ctx.account.config.allowFrom ?? [],
    ownerPubkeys: new Set(ownerPubkeys),
    undecidedWarned: new Set(),
    dmRouteWarned: false,
    restrictedTools: nonOwnerToolPolicy(strangerToolsAllow),
    groupTools: groupToolPolicy(strangerToolsAllow),
    ownerReady,
    startedAt,
    groupPending: new Map(),
    groupRoutesRefused: new Set(),
    payreqsSeen: new Set(),
    receiptsSeen: new Set(),
    groupsChecked: new Set(),
    groupStateWarned: false,
    stopped: false,
    touch: () => status({ lastEventAt: Date.now() }),
  };

  const unsubs: Array<() => void> = [];
  const replay = groupReplay(st);
  const backfill = createGroupBackfill((msg) => enqueueGroupTurn(st, msg), log, replay);
  let detachGroups: ((undispatched: readonly GroupMessageData[]) => void) | null = null;
  const receipts = createReceiptBatcher((batch) => announceReceipts(st, batch));
  const cleanup = (): void => {
    const firstStop = !st.stopped;
    st.stopped = true;
    for (const unsub of unsubs.splice(0)) {
      try {
        unsub();
      } catch (err) {
        log.debug?.(`[unicity] unsubscribe failed: ${errorMessage(err)}`);
      }
    }
    const undispatched = [...backfill.dispose(), ...st.groupPending.values()];
    st.groupPending.clear();
    detachGroups?.(undispatched);
    const dropped = receipts.dispose();
    if (dropped > 0) log.info(`[unicity] ${dropped} received token(s) not announced yet; the next start recovers them from history`);
    queue.deactivate();
    // Only when this start stops: a later call (its abort, after a newer start replaced it) would cut off the newer
    // start's DMs, which the raised cutoff applies to as well.
    if (policy === "disabled" && firstStop) ignoreDmsBefore(sphere, nowSecond());
    if (previousGatewayCleanup === cleanup) previousGatewayCleanup = null;
  };
  // Registered before subscribing so a failure part-way through cannot leak handlers into the next start. Another
  // start that waited for the wallet alongside this one may have subscribed meanwhile: only the newest stays live.
  stopPreviousStart();
  previousGatewayCleanup = cleanup;

  try {
    const acceptDm = createDmFilter(st);
    unsubs.push(
      sphere.communications.onDirectMessage((msg) => {
        const dm = acceptDm(msg);
        if (!dm) return;
        st.touch();
        if (policy === "disabled") {
          log.debug?.(`[unicity] DM from ${shortKey(dm.senderKey)} dropped (dmPolicy disabled)`);
          return;
        }
        queue.enqueue(`direct:${dm.senderKey}`, () => handleDirectMessage(st, msg, dm));
      }),
    );
    unsubs.push(
      subscribeWalletEvents({
        onTransfer: (t: IncomingTransfer) => onTransfer(st, receipts, t),
        onPaymentRequest: (r: PaymentRequestView) => onPaymentRequest(st, r),
      }),
    );
    // The SDK emits it for every group change, a newly listed group included.
    unsubs.push(sphere.on("groupchat:updated", () => reportUnapprovedGroups(st)));
    reconcilePaymentRequests(st);
    reconcileTransfers(st).catch((err: unknown) => log.warn(`[unicity] transfer reconcile failed: ${errorMessage(err)}`));
    const groupChat = sphere.groupChat;
    if (groupChat) {
      detachGroups = attachGroupIntake(st, groupChat, (msg) => {
        const senderKey = toXOnly(msg.senderPubkey);
        if (!senderKey || selfKeys.has(senderKey)) return;
        if (!groupApproved(st, msg.groupId)) {
          log.debug?.(`[unicity] message in unapproved group ${shownGroupId(msg.groupId)} ignored`);
          return;
        }
        st.touch();
        backfill.push(msg);
      });
      groupChat.connect().then(
        () => {
          replayConnected(replay);
          reportUnapprovedGroups(st);
        },
        (err: unknown) => log.error(`[unicity] group chat connect failed: ${errorMessage(err)}`),
      );
    }
  } catch (err) {
    cleanup();
    throw err;
  }

  ctx.setStatus(channelReadyPatch({ accountId, publicKey: sphere.identity?.chainPubkey ?? null }));
  log.info(
    `[unicity] channel ready as ${sphere.identity?.nametag ? `@${sphere.identity.nametag}` : shortKey(sphere.identity?.chainPubkey ?? "")} (dmPolicy ${policy})`,
  );
  await waitUntilAbort(abortSignal, cleanup);
}

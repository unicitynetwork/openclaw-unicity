/** Unicity channel plugin — Sphere SDK DMs over private Nostr relays. */

import type { Sphere } from "@unicitylabs/sphere-sdk";
import type { PluginRuntime, ChannelOnboardingAdapter } from "openclaw/plugin-sdk";
import { waitForSphere, walletExists } from "./sphere.js";
import { runInteractiveSetup } from "./setup.js";
import { getCoinDecimals, toHumanReadable } from "./assets.js";
import { VALID_RECIPIENT } from "./validation.js";
import type { UnicityConfig } from "./config.js";

const DEFAULT_ACCOUNT_ID = "default";

/** How long (ms) to wait after the last group message before declaring backfill complete. */
export const GROUP_BACKFILL_DEBOUNCE_MS = 3_000;


interface GroupBackfillState {
  phase: "buffering" | "live";
  latestMsg: {
    id?: string;
    groupId: string;
    senderPubkey: string;
    senderNametag?: string;
    content: string;
    timestamp: number;
    replyToId?: string;
  } | null;
  bufferedCount: number;
  timer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// Account config shape (read from openclaw config under channels.unicity)
// ---------------------------------------------------------------------------

export interface UnicityAccountConfig {
  enabled?: boolean;
  name?: string;
  nametag?: string;
  network?: string;
  additionalRelays?: string[];
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: string[];
}

export interface ResolvedUnicityAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  publicKey: string;
  nametag?: string;
  config: UnicityAccountConfig;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function readChannelConfig(cfg: Record<string, unknown>): UnicityAccountConfig {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const channelCfg = channels?.unicity as UnicityAccountConfig | undefined;
  // Merge: channel config wins, plugin config is fallback for dmPolicy/allowFrom
  return {
    ...channelCfg,
    dmPolicy: channelCfg?.dmPolicy ?? pluginConfig.dmPolicy,
    allowFrom: channelCfg?.allowFrom ?? pluginConfig.allowFrom,
  };
}

export function listUnicityAccountIds(_cfg: Record<string, unknown>): string[] {
  // We have an account once sphere has been initialized (pubkey present at runtime).
  // Config-time: we always report a default account so the gateway tries to start it.
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveUnicityAccount(opts: {
  cfg: Record<string, unknown>;
  accountId?: string | null;
  sphere?: Sphere | null;
}): ResolvedUnicityAccount {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const ucfg = readChannelConfig(opts.cfg);
  const enabled = ucfg.enabled !== false;
  const sphere = opts.sphere ?? null;

  return {
    accountId,
    name: ucfg?.name?.trim() || undefined,
    enabled,
    configured: sphere?.identity?.chainPubkey != null,
    publicKey: sphere?.identity?.chainPubkey ?? "",
    nametag: sphere?.identity?.nametag ?? ucfg?.nametag,
    config: ucfg,
  };
}

// ---------------------------------------------------------------------------
// Channel plugin (full ChannelPlugin shape)
// ---------------------------------------------------------------------------

let activeSphere: Sphere | null = null;
let pluginRuntime: PluginRuntime | null = null;
let ownerIdentity: string | null = null;
let pluginConfig: UnicityConfig = {};

export function setUnicityRuntime(rt: PluginRuntime): void {
  pluginRuntime = rt;
}
export function setOwnerIdentity(owner: string | undefined): void {
  ownerIdentity = owner ?? null;
}
export function setPluginConfig(cfg: UnicityConfig): void {
  pluginConfig = cfg;
}
export function getOwnerIdentity(): string | null {
  return ownerIdentity;
}
export function getUnicityRuntime(): PluginRuntime {
  if (!pluginRuntime) throw new Error("Unicity runtime not initialized");
  return pluginRuntime;
}
export function setActiveSphere(s: Sphere | null): void {
  activeSphere = s;
}
export function getActiveSphere(): Sphere | null {
  return activeSphere;
}

function isKnownGroupId(sphere: Sphere, target: string): boolean {
  try {
    const groups = sphere.groupChat?.getGroups?.() ?? [];
    return groups.some((g: { id: string }) => g.id === target);
  } catch {
    return false;
  }
}

function isSenderOwner(senderPubkey: string, senderNametag?: string): boolean {
  if (!ownerIdentity) return false;
  const normalized = ownerIdentity.replace(/^@/, "").toLowerCase();
  if (senderPubkey.toLowerCase() === normalized) return true;
  if (senderNametag) {
    const tag = senderNametag.replace(/^@/, "").toLowerCase();
    if (tag === normalized) return true;
  }
  return false;
}

export const unicityChannelPlugin = {
  id: "unicity" as const,

  meta: {
    id: "unicity" as const,
    label: "Unicity",
    selectionLabel: "Unicity (Sphere DMs)",
    docsPath: "/channels/unicity",
    docsLabel: "unicity",
    blurb: "Private Nostr DMs via Unicity Sphere SDK.",
    order: 110,
  },

  capabilities: {
    chatTypes: ["direct" as const, "group" as const],
    groupManagement: true,
    media: false,
  },

  reload: { configPrefixes: ["channels.unicity"] },

  // -- config adapter -------------------------------------------------------
  config: {
    listAccountIds: (cfg: Record<string, unknown>) => listUnicityAccountIds(cfg),
    resolveAccount: (cfg: Record<string, unknown>, accountId?: string | null) =>
      resolveUnicityAccount({ cfg, accountId, sphere: activeSphere }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (_account: ResolvedUnicityAccount) => true,
    describeAccount: (account: ResolvedUnicityAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey || undefined,
      nametag: account.nametag,
    }),
    resolveAllowFrom: (params: { cfg: Record<string, unknown>; accountId?: string | null }) => {
      const account = resolveUnicityAccount({ ...params, sphere: activeSphere });
      return account.config.allowFrom ?? [];
    },
  },

  // -- outbound adapter (send replies) --------------------------------------
  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4000,
    sendText: async (ctx: {
      cfg: Record<string, unknown>;
      to: string;
      text: string;
      accountId?: string | null;
    }) => {
      const sphere = activeSphere ?? await waitForSphere();
      if (!sphere) throw new Error("Unicity Sphere not initialized");

      // Check if target is a known group id
      if (isKnownGroupId(sphere, ctx.to)) {
        await sphere.groupChat.sendMessage(ctx.to, ctx.text ?? "");
      } else {
        await sphere.communications.sendDM(ctx.to, ctx.text ?? "");
      }
      return { channel: "unicity", to: ctx.to };
    },
  },

  // -- gateway adapter (inbound listener) -----------------------------------
  gateway: {
    startAccount: async (ctx: {
      cfg: Record<string, unknown>;
      accountId: string;
      account: ResolvedUnicityAccount;
      runtime: unknown;
      abortSignal: AbortSignal;
      log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void; debug: (m: string) => void };
      setStatus: (s: Record<string, unknown>) => void;
    }) => {
      const sphere = activeSphere ?? await waitForSphere();
      if (!sphere) throw new Error("Unicity Sphere not initialized — run `openclaw unicity init`");

      const runtime = getUnicityRuntime();

      ctx.setStatus({
        accountId: ctx.account.accountId,
        publicKey: sphere.identity?.chainPubkey,
        nametag: sphere.identity?.nametag,
        running: true,
        lastStartAt: Date.now(),
      });

      ctx.log?.info(
        `[${ctx.account.accountId}] Starting Unicity channel (nametag: ${sphere.identity?.nametag ?? "none"}, pubkey: ${sphere.identity?.chainPubkey?.slice(0, 16)}...)`,
      );

      ctx.log?.info(`[${ctx.account.accountId}] Subscribing to DMs (pubkey: ${sphere.identity?.chainPubkey?.slice(0, 16)}...)`);

      const unsub = sphere.communications.onDirectMessage((msg) => {
        // Use @nametag if available, otherwise raw pubkey
        const peerId = msg.senderNametag ? `@${msg.senderNametag}` : msg.senderPubkey;
        ctx.log?.info(`[${ctx.account.accountId}] DM received from ${peerId}: ${msg.content.slice(0, 80)}`);

        const isOwner = isSenderOwner(msg.senderPubkey, msg.senderNametag);
        ctx.log?.debug(`[${ctx.account.accountId}] Owner check: senderPubkey=${msg.senderPubkey.slice(0, 16)}… senderNametag=${msg.senderNametag ?? "undefined"} ownerIdentity=${ownerIdentity ?? "unset"} → isOwner=${isOwner}`);

        // Auto-forward stranger DMs to owner (handled in code, not by the LLM)
        if (!isOwner && ownerIdentity) {
          const senderLabel = msg.senderNametag ? `@${msg.senderNametag}` : msg.senderPubkey.slice(0, 16);
          const forwardBody = `[Forwarded DM from ${senderLabel}]: ${msg.content}`;
          sphere.communications.sendDM(`@${ownerIdentity}`, forwardBody).catch((err) => {
            ctx.log?.error(`[${ctx.account.accountId}] Failed to forward DM to owner: ${err}`);
          });
        }

        const senderName = msg.senderNametag ?? msg.senderPubkey.slice(0, 12);
        const metadataHeader = `[SenderName: ${senderName} | SenderId: ${msg.senderPubkey} | IsOwner: ${isOwner} | CommandAuthorized: ${isOwner}]`;
        // Strip any fake metadata headers from user content to prevent spoofing
        const sanitizedContent = msg.content.replace(/\[(?:SenderName|SenderId|IsOwner|CommandAuthorized)\s*:/gi, "[BLOCKED:");

        const inboundCtx = runtime.channel.reply.finalizeInboundContext({
          Body: `${metadataHeader}\n${sanitizedContent}`,
          From: peerId,
          To: sphere.identity?.nametag ?? sphere.identity?.chainPubkey ?? "agent",
          SessionKey: `unicity:dm:${peerId}`,
          ChatType: "direct",
          Surface: "unicity",
          Provider: "unicity",
          OriginatingChannel: "unicity",
          OriginatingTo: peerId,
          AccountId: ctx.account.accountId,
          SenderName: senderName,
          SenderId: msg.senderPubkey,
          IsOwner: isOwner,
          CommandAuthorized: isOwner,
        });

        runtime.channel.reply
          .dispatchReplyWithBufferedBlockDispatcher({
            ctx: inboundCtx,
            cfg: ctx.cfg,
            dispatcherOptions: {
              deliver: async (payload: { text?: string }, info: { kind: string }) => {
                ctx.log?.info(`[${ctx.account.accountId}] deliver called: kind=${info.kind} textLen=${payload.text?.length ?? 0}`);
                const text = payload.text;
                if (!text) return;
                try {
                  // Reply using raw Nostr pubkey from the unwrapped seal, NOT the
                  // nametag.  The nametag resolution on the relay may return a
                  // different Nostr pubkey (e.g. registered with the SDK's direct
                  // key derivation) than the one the sender's browser extension
                  // actually uses (SPHERE_NOSTR_V1 derivation).  Sending to the
                  // raw pubkey guarantees the reply reaches the correct recipient.
                  await sphere.communications.sendDM(msg.senderPubkey, text);
                  ctx.log?.info(`[${ctx.account.accountId}] DM sent to ${peerId}: ${text.slice(0, 80)}`);
                } catch (err) {
                  ctx.log?.error(`[${ctx.account.accountId}] Failed to send DM to ${peerId}: ${err}`);
                }
              },
              onSkip: (payload: { text?: string }, info: { kind: string; reason: string }) => {
                ctx.log?.warn(`[${ctx.account.accountId}] Reply SKIPPED: kind=${info.kind} reason=${info.reason} text="${payload.text?.slice(0, 60) ?? ""}"`);
              },
              onError: (err: unknown, info: { kind: string }) => {
                ctx.log?.error(`[${ctx.account.accountId}] Reply delivery ERROR: kind=${info.kind} err=${err}`);
              },
            },
          })
          .then((result: unknown) => {
            ctx.log?.info(`[${ctx.account.accountId}] Dispatch result: ${JSON.stringify(result)}`);
          })
          .catch((err: unknown) => {
            ctx.log?.error(`[${ctx.account.accountId}] Reply dispatch error: ${err}`);
          });
      });

      ctx.log?.info(`[${ctx.account.accountId}] Unicity DM listener active`);

      // Subscribe to incoming token transfers
      const unsubTransfer = sphere.on("transfer:incoming", (transfer) => {
        // Full address for DM replies; short form for display/logging only
        const replyTo = transfer.senderNametag ? `@${transfer.senderNametag}` : transfer.senderPubkey;
        const displayName = transfer.senderNametag ? `@${transfer.senderNametag}` : transfer.senderPubkey.slice(0, 12) + "…";
        const totalAmount = transfer.tokens.map((t) => {
          const decimals = getCoinDecimals(t.coinId) ?? 0;
          const amount = toHumanReadable(t.amount, decimals);
          return `${amount} ${t.symbol}`;
        }).join(", ");
        const memo = transfer.memo ? ` — "${transfer.memo}"` : "";
        const body = `[Payment received] ${totalAmount} from ${displayName}${memo}`;

        ctx.log?.info(`[${ctx.account.accountId}] ${body}`);

        // Notify owner about the incoming transfer
        const owner = getOwnerIdentity();
        if (owner) {
          sphere.communications.sendDM(`@${owner}`, body).catch((err) => {
            ctx.log?.error(`[${ctx.account.accountId}] Failed to notify owner about transfer: ${err}`);
          });
        }

        const inboundCtx = runtime.channel.reply.finalizeInboundContext({
          Body: body,
          RawBody: body,
          From: replyTo,
          To: sphere.identity?.nametag ?? sphere.identity?.chainPubkey ?? "agent",
          SessionKey: `unicity:transfer:${transfer.id}`,
          ChatType: "direct",
          Surface: "unicity",
          Provider: "unicity",
          OriginatingChannel: "unicity",
          OriginatingTo: replyTo,
          AccountId: ctx.account.accountId,
          SenderName: displayName,
          SenderId: transfer.senderPubkey,
          IsOwner: false,
          CommandAuthorized: false,
        });

        runtime.channel.reply
          .dispatchReplyWithBufferedBlockDispatcher({
            ctx: inboundCtx,
            cfg: ctx.cfg,
            dispatcherOptions: {
              deliver: async (payload: { text?: string }) => {
                const text = payload.text;
                if (!text) return;
                try {
                  await sphere.communications.sendDM(replyTo, text);
                } catch (err) {
                  ctx.log?.error(`[${ctx.account.accountId}] Failed to send DM to ${displayName}: ${err}`);
                }
              },
            },
          })
          .catch((err: unknown) => {
            ctx.log?.error(`[${ctx.account.accountId}] Transfer notification dispatch error: ${err}`);
          });
      });

      // Subscribe to incoming payment requests
      const unsubPaymentRequest = sphere.on("payment_request:incoming", (request) => {
        const replyTo = request.senderNametag ? `@${request.senderNametag}` : request.senderPubkey;
        const displayName = request.senderNametag ? `@${request.senderNametag}` : request.senderPubkey.slice(0, 12) + "…";
        const decimals = getCoinDecimals(request.coinId) ?? 0;
        const amount = toHumanReadable(request.amount, decimals);
        const msg = request.message ? ` — "${request.message}"` : "";
        const body = `[Payment request] ${displayName} is requesting ${amount} ${request.symbol}${msg} (request id: ${request.requestId})`;

        ctx.log?.info(`[${ctx.account.accountId}] ${body}`);

        // Notify owner about the incoming payment request
        const owner = getOwnerIdentity();
        if (owner) {
          sphere.communications.sendDM(`@${owner}`, body).catch((err) => {
            ctx.log?.error(`[${ctx.account.accountId}] Failed to notify owner about payment request: ${err}`);
          });
        }

        const inboundCtx = runtime.channel.reply.finalizeInboundContext({
          Body: body,
          RawBody: body,
          From: replyTo,
          To: sphere.identity?.nametag ?? sphere.identity?.chainPubkey ?? "agent",
          SessionKey: `unicity:payreq:${request.requestId}`,
          ChatType: "direct",
          Surface: "unicity",
          Provider: "unicity",
          OriginatingChannel: "unicity",
          OriginatingTo: replyTo,
          AccountId: ctx.account.accountId,
          SenderName: displayName,
          SenderId: request.senderPubkey,
          IsOwner: false,
          CommandAuthorized: false,
        });

        runtime.channel.reply
          .dispatchReplyWithBufferedBlockDispatcher({
            ctx: inboundCtx,
            cfg: ctx.cfg,
            dispatcherOptions: {
              deliver: async (payload: { text?: string }) => {
                const text = payload.text;
                if (!text) return;
                try {
                  await sphere.communications.sendDM(replyTo, text);
                } catch (err) {
                  ctx.log?.error(`[${ctx.account.accountId}] Failed to send DM to ${displayName}: ${err}`);
                }
              },
            },
          })
          .catch((err: unknown) => {
            ctx.log?.error(`[${ctx.account.accountId}] Payment request dispatch error: ${err}`);
          });
      });

      // -- Group message dispatch helper & backfill debounce --------------------

      type GroupMsg = {
        id?: string;
        groupId: string;
        senderPubkey: string;
        senderNametag?: string;
        content: string;
        timestamp: number;
        replyToId?: string;
      };

      // Nostr pubkey for self-message detection and reply-to-self detection.
      // Group messages use the 32-byte x-only Nostr pubkey (event.pubkey),
      // NOT the 33-byte compressed chainPubkey.
      const myNostrPubkey = sphere.groupChat?.getMyPublicKey?.() ?? null;

      // Detect if a group message is a reply to one of the agent's own messages.
      // Used to set WasMentioned so the mention gate treats replies-to-self as
      // implicit mentions (same pattern Discord uses for thread replies).
      function isReplyToSelf(msg: GroupMsg): boolean {
        if (!msg.replyToId || !myNostrPubkey) return false;
        try {
          const messages = sphere.groupChat?.getMessages?.(msg.groupId) ?? [];
          const repliedTo = messages.find((m: { id: string }) => m.id === msg.replyToId);
          return repliedTo?.senderPubkey === myNostrPubkey;
        } catch {
          return false;
        }
      }

      function dispatchGroupMessage(msg: GroupMsg): void {
        const senderName = msg.senderNametag ?? msg.senderPubkey.slice(0, 12);
        const groupData = sphere.groupChat?.getGroup?.(msg.groupId);
        const groupName = groupData?.name ?? msg.groupId;
        const isOwner = isSenderOwner(msg.senderPubkey, msg.senderNametag);
        const metadataHeader = `[SenderName: ${senderName} | SenderId: ${msg.senderPubkey} | GroupId: ${msg.groupId} | GroupName: ${groupName} | IsOwner: ${isOwner} | CommandAuthorized: ${isOwner}]`;
        const sanitizedContent = msg.content.replace(/\[(?:SenderName|SenderId|IsOwner|CommandAuthorized|GroupId|GroupName)\s*:/gi, "[BLOCKED:");

        // Treat replies to the agent's own messages as implicit mentions,
        // so the mention gate doesn't skip them (mirrors Discord's behavior).
        const wasMentioned = isReplyToSelf(msg) || undefined;

        ctx.log?.info(`[${ctx.account.accountId}] Group message from ${senderName} in ${groupName}: ${msg.content.slice(0, 80)}`);

        const inboundCtx = runtime.channel.reply.finalizeInboundContext({
          Body: `${metadataHeader}\n${sanitizedContent}`,
          From: msg.senderNametag ? `@${msg.senderNametag}` : msg.senderPubkey,
          To: sphere.identity?.nametag ?? sphere.identity?.chainPubkey ?? "agent",
          SessionKey: `unicity:group:${msg.groupId}`,
          ChatType: "group",
          GroupSubject: groupName,
          Surface: "unicity",
          Provider: "unicity",
          OriginatingChannel: "unicity",
          OriginatingTo: msg.groupId,
          AccountId: ctx.account.accountId,
          SenderName: senderName,
          SenderId: msg.senderPubkey,
          IsOwner: isOwner,
          CommandAuthorized: isOwner,
          WasMentioned: wasMentioned,
        });

        runtime.channel.reply
          .dispatchReplyWithBufferedBlockDispatcher({
            ctx: inboundCtx,
            cfg: ctx.cfg,
            dispatcherOptions: {
              deliver: async (payload: { text?: string }) => {
                const text = payload.text;
                if (!text) return;
                try {
                  await sphere.groupChat.sendMessage(msg.groupId, text, msg.id);
                  ctx.log?.info(`[${ctx.account.accountId}] Group message sent to ${groupName}: ${text.slice(0, 80)}`);
                } catch (err) {
                  ctx.log?.error(`[${ctx.account.accountId}] Failed to send group message to ${groupName}: ${err}`);
                }
              },
              onSkip: (payload: { text?: string }, info: { kind: string; reason: string }) => {
                ctx.log?.warn(`[${ctx.account.accountId}] Group reply SKIPPED: kind=${info.kind} reason=${info.reason}`);
              },
              onError: (err: unknown, info: { kind: string }) => {
                ctx.log?.error(`[${ctx.account.accountId}] Group reply ERROR: kind=${info.kind} err=${err}`);
              },
            },
          })
          .catch((err: unknown) => {
            ctx.log?.error(`[${ctx.account.accountId}] Group message dispatch error: ${err}`);
          });
      }

      // Per-group backfill state: buffer messages during the initial burst, then
      // switch to live dispatch once the burst settles.
      const groupBackfillStates = new Map<string, GroupBackfillState>();

      // Subscribe to incoming group messages
      const unsubGroupMessage = sphere.groupChat?.onMessage?.((msg: GroupMsg) => {
        // Skip messages from self (echoed back by the relay).
        // Compare against the Nostr x-only pubkey, not chainPubkey.
        if (myNostrPubkey && msg.senderPubkey === myNostrPubkey) return;

        // Lookup or create per-group backfill state
        let state = groupBackfillStates.get(msg.groupId);
        if (!state) {
          state = { phase: "buffering", latestMsg: null, bufferedCount: 0, timer: null };
          groupBackfillStates.set(msg.groupId, state);
        }

        // Already past backfill — dispatch immediately
        if (state.phase === "live") {
          dispatchGroupMessage(msg);
          return;
        }

        // BUFFERING: keep only the latest message, reset the debounce timer
        state.latestMsg = msg;
        state.bufferedCount++;
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          state!.phase = "live";
          state!.timer = null;
          ctx.log?.info(
            `[${ctx.account.accountId}] Group backfill settled for ${msg.groupId}, ${state!.bufferedCount} message(s) buffered`,
          );
          // Dispatch the most recent buffered message so the agent has context
          if (state!.latestMsg) {
            dispatchGroupMessage(state!.latestMsg);
            state!.latestMsg = null;
          }
        }, GROUP_BACKFILL_DEBOUNCE_MS);
      }) ?? (() => {});

      // Subscribe to group lifecycle events and notify owner
      const unsubGroupJoined = sphere.on?.("groupchat:joined", (event: { groupId: string; groupName: string }) => {
        const owner = getOwnerIdentity();
        if (owner) {
          const label = event.groupName ? `${event.groupName} (${event.groupId})` : event.groupId;
          sphere.communications.sendDM(`@${owner}`, `I joined group ${label}`).catch((err) => {
            ctx.log?.error(`[${ctx.account.accountId}] Failed to notify owner about group join: ${err}`);
          });
        }
      }) ?? (() => {});

      const unsubGroupLeft = sphere.on?.("groupchat:left", (event: { groupId: string }) => {
        const owner = getOwnerIdentity();
        if (owner) {
          const groupData = sphere.groupChat?.getGroup?.(event.groupId);
          const label = groupData?.name ?? event.groupId;
          sphere.communications.sendDM(`@${owner}`, `I left group ${label}`).catch((err) => {
            ctx.log?.error(`[${ctx.account.accountId}] Failed to notify owner about group leave: ${err}`);
          });
        }
      }) ?? (() => {});

      const unsubGroupKicked = sphere.on?.("groupchat:kicked", (event: { groupId: string; groupName: string }) => {
        const owner = getOwnerIdentity();
        if (owner) {
          const label = event.groupName ? `${event.groupName} (${event.groupId})` : event.groupId;
          sphere.communications.sendDM(`@${owner}`, `I was kicked from group ${label}`).catch((err) => {
            ctx.log?.error(`[${ctx.account.accountId}] Failed to notify owner about group kick: ${err}`);
          });
        }
      }) ?? (() => {});

      function clearBackfillTimers(): void {
        for (const state of groupBackfillStates.values()) {
          if (state.timer) clearTimeout(state.timer);
        }
        groupBackfillStates.clear();
      }

      ctx.abortSignal.addEventListener("abort", () => {
        clearBackfillTimers();
        unsub();
        unsubTransfer();
        unsubPaymentRequest();
        unsubGroupMessage();
        unsubGroupJoined();
        unsubGroupLeft();
        unsubGroupKicked();
      }, { once: true });

      return {
        stop: () => {
          clearBackfillTimers();
          unsub();
          unsubTransfer();
          unsubPaymentRequest();
          unsubGroupMessage();
          unsubGroupJoined();
          unsubGroupLeft();
          unsubGroupKicked();
          ctx.log?.info(`[${ctx.account.accountId}] Unicity channel stopped`);
        },
      };
    },
  },

  // -- status adapter -------------------------------------------------------
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: (params: { snapshot: Record<string, unknown> }) => ({
      configured: params.snapshot.configured ?? false,
      publicKey: params.snapshot.publicKey ?? null,
      nametag: params.snapshot.nametag ?? null,
      running: params.snapshot.running ?? false,
      lastStartAt: params.snapshot.lastStartAt ?? null,
      lastError: params.snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: (params: {
      account: ResolvedUnicityAccount;
      runtime?: Record<string, unknown>;
    }) => ({
      accountId: params.account.accountId,
      name: params.account.name,
      enabled: params.account.enabled,
      configured: params.account.configured,
      publicKey: params.account.publicKey || undefined,
      nametag: params.account.nametag,
      running: (params.runtime?.running as boolean) ?? false,
      lastStartAt: params.runtime?.lastStartAt ?? null,
      lastStopAt: params.runtime?.lastStopAt ?? null,
      lastError: params.runtime?.lastError ?? null,
    }),
  },

  // -- messaging adapter (target normalization) -----------------------------
  messaging: {
    normalizeTarget: (target: string) => target.replace(/^@/, "").trim(),
    targetResolver: {
      looksLikeId: (input: string) => VALID_RECIPIENT.test(input.trim()),
      hint: "<@nametag|hex pubkey>",
    },
  },

  // -- security adapter (DM access control) ---------------------------------
  security: {
    resolveDmPolicy: (params: { account: ResolvedUnicityAccount }) => ({
      policy: params.account.config.dmPolicy ?? "open",
      allowFrom: params.account.config.allowFrom ?? [],
      policyPath: "plugins.entries.openclaw-unicity.config.dmPolicy",
      allowFromPath: "plugins.entries.openclaw-unicity.config.allowFrom",
      approveHint: 'openclaw config set plugins.entries.openclaw-unicity.config.allowFrom \'["<pubkey-or-nametag>"]\'',
    }),
  },

  // -- onboarding adapter (interactive setup via `openclaw onboard`) ---------
  onboarding: {
    channel: "unicity",

    getStatus: async (_ctx) => ({
      channel: "unicity" as const,
      configured: walletExists(),
      statusLines: walletExists()
        ? [`Nametag: ${activeSphere?.identity?.nametag ?? "pending"}`]
        : ["Not configured — run setup to create wallet"],
      quickstartScore: 80,
    }),

    configure: async (ctx) => {
      const { prompter, cfg } = ctx;
      await runInteractiveSetup(prompter, {
        loadConfig: () => cfg as Record<string, unknown>,
        writeConfigFile: async (updatedCfg) => {
          Object.assign(cfg, updatedCfg);
        },
      });
      return { cfg };
    },
  } satisfies ChannelOnboardingAdapter,

  // -- groups adapter (group chat policy) -----------------------------------
  groups: {
    resolveRequireMention: () => true,
    resolveToolPolicy: () => ({
      deny: ["unicity_send_tokens", "unicity_respond_payment_request", "unicity_top_up"],
    }),
  },

  // -- directory adapter (group/member listing) -----------------------------
  directory: {
    listGroups: async () => {
      const sphere = activeSphere;
      if (!sphere) return [];
      try {
        const groups = sphere.groupChat?.getGroups?.() ?? [];
        return groups.map((g: { id: string; name: string }) => ({
          kind: "group" as const,
          id: g.id,
          name: g.name,
        }));
      } catch {
        return [];
      }
    },
    listGroupMembers: async ({ groupId }: { groupId: string }) => {
      const sphere = activeSphere;
      if (!sphere) return [];
      try {
        const members = sphere.groupChat?.getMembers?.(groupId) ?? [];
        return members.map((m: { pubkey: string; nametag?: string }) => ({
          kind: "user" as const,
          id: m.pubkey,
          name: m.nametag,
        }));
      } catch {
        return [];
      }
    },
  },
};

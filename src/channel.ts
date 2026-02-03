/** Unicity channel plugin — Sphere SDK DMs over private Nostr relays. */

import type { Sphere } from "@unicitylabs/sphere-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { waitForSphere } from "./sphere.js";

const DEFAULT_ACCOUNT_ID = "default";

// ---------------------------------------------------------------------------
// Account config shape (read from openclaw config under channels.uniclaw)
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

function readChannelConfig(cfg: Record<string, unknown>): UnicityAccountConfig | undefined {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return channels?.uniclaw as UnicityAccountConfig | undefined;
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
  const enabled = ucfg?.enabled !== false;
  const sphere = opts.sphere ?? null;

  return {
    accountId,
    name: ucfg?.name?.trim() || undefined,
    enabled,
    configured: sphere?.identity?.publicKey != null,
    publicKey: sphere?.identity?.publicKey ?? "",
    nametag: sphere?.identity?.nametag ?? ucfg?.nametag,
    config: ucfg ?? {},
  };
}

// ---------------------------------------------------------------------------
// Channel plugin (full ChannelPlugin shape)
// ---------------------------------------------------------------------------

let activeSphere: Sphere | null = null;
let pluginRuntime: PluginRuntime | null = null;
let ownerIdentity: string | null = null;

export function setUnicityRuntime(rt: PluginRuntime): void {
  pluginRuntime = rt;
}
export function setOwnerIdentity(owner: string | undefined): void {
  ownerIdentity = owner ?? null;
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

export const uniclawChannelPlugin = {
  id: "uniclaw" as const,

  meta: {
    id: "uniclaw" as const,
    label: "Unicity",
    selectionLabel: "Unicity (Sphere DMs)",
    docsPath: "/channels/uniclaw",
    docsLabel: "uniclaw",
    blurb: "Private Nostr DMs via Unicity Sphere SDK.",
    order: 110,
  },

  capabilities: {
    chatTypes: ["direct" as const],
    media: false,
  },

  reload: { configPrefixes: ["channels.uniclaw"] },

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
      await sphere.communications.sendDM(ctx.to, ctx.text ?? "");
      return { channel: "uniclaw", to: ctx.to };
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
      if (!sphere) throw new Error("Unicity Sphere not initialized — run `openclaw uniclaw init`");

      const runtime = getUnicityRuntime();

      ctx.setStatus({
        accountId: ctx.account.accountId,
        publicKey: sphere.identity?.publicKey,
        nametag: sphere.identity?.nametag,
        running: true,
        lastStartAt: Date.now(),
      });

      ctx.log?.info(
        `[${ctx.account.accountId}] Starting Unicity channel (nametag: ${sphere.identity?.nametag ?? "none"}, pubkey: ${sphere.identity?.publicKey?.slice(0, 16)}...)`,
      );

      ctx.log?.info(`[${ctx.account.accountId}] Subscribing to DMs (pubkey: ${sphere.identity?.publicKey?.slice(0, 16)}...)`);

      const unsub = sphere.communications.onDirectMessage((msg) => {
        // Use @nametag if available, otherwise raw pubkey
        const peerId = msg.senderNametag ? `@${msg.senderNametag}` : msg.senderPubkey;
        ctx.log?.info(`[${ctx.account.accountId}] DM received from ${peerId}: ${msg.content.slice(0, 80)}`);

        const isOwner = isSenderOwner(msg.senderPubkey, msg.senderNametag);

        const inboundCtx = runtime.channel.reply.finalizeInboundContext({
          Body: msg.content,
          RawBody: msg.content,
          From: peerId,
          To: sphere.identity?.nametag ?? sphere.identity?.publicKey ?? "agent",
          SessionKey: `uniclaw:dm:${peerId}`,
          ChatType: "direct",
          Surface: "uniclaw",
          Provider: "uniclaw",
          AccountId: ctx.account.accountId,
          SenderName: msg.senderNametag ?? msg.senderPubkey.slice(0, 12),
          SenderId: msg.senderPubkey,
          IsOwner: isOwner,
          CommandAuthorized: isOwner,
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
                  await sphere.communications.sendDM(peerId, text);
                } catch (err) {
                  ctx.log?.error(`[${ctx.account.accountId}] Failed to send DM to ${peerId}: ${err}`);
                }
              },
            },
          })
          .catch((err: unknown) => {
            ctx.log?.error(`[${ctx.account.accountId}] Reply dispatch error: ${err}`);
          });
      });

      ctx.log?.info(`[${ctx.account.accountId}] Unicity DM listener active`);

      ctx.abortSignal.addEventListener("abort", () => unsub(), { once: true });

      return {
        stop: () => {
          unsub();
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
      looksLikeId: (input: string) => {
        const trimmed = input.trim();
        // Nametag or hex pubkey
        return /^@?\w[\w-]{0,31}$/.test(trimmed) || /^[0-9a-fA-F]{64}$/.test(trimmed);
      },
      hint: "<@nametag|hex pubkey>",
    },
  },

  // -- security adapter (DM access control) ---------------------------------
  security: {
    resolveDmPolicy: (params: { account: ResolvedUnicityAccount }) => ({
      policy: params.account.config.dmPolicy ?? "open",
      allowFrom: params.account.config.allowFrom ?? [],
      policyPath: "channels.uniclaw.dmPolicy",
      allowFromPath: "channels.uniclaw.allowFrom",
      approveHint: 'openclaw config set channels.uniclaw.allowFrom \'["<pubkey-or-nametag>"]\'',
    }),
  },
} as const;

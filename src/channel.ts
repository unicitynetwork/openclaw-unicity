/** Unicity channel plugin: encrypted DMs, NIP-29 groups and wallet events via the Sphere SDK. */

import type { Sphere } from "@unicitylabs/sphere-sdk";
import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { ChannelSetupWizardAdapter } from "openclaw/plugin-sdk/setup";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { classifyAllowEntry, effectiveDmPolicy, formatAllowEntry, normalizeAllowEntry, stripChannelPrefix } from "./access.js";
import {
  API_KEY_URL, CHANNEL_ID, PLUGIN_ID, isDmPolicy, optionalString, readPluginConfig, stringList, type DmPolicy,
} from "./config.js";
import { claimedNameSuffix, shortKey, toXOnly } from "./identity.js";
import { resolveUnicityDmScope, startUnicityAccount } from "./inbound.js";
import { applySetupAnswers, collectSetupAnswers } from "./setup.js";
import { getSphereOrNull, waitForSphere } from "./sphere.js";
import { walletExists } from "./storage.js";
import { VALID_RECIPIENT, looksLikeTarget, normalizeNametag } from "./validation.js";

const DEFAULT_ACCOUNT_ID = "default";
const CHANNEL_CONFIG_PREFIX = `channels.${CHANNEL_ID}.`;
const PLUGIN_CONFIG_PREFIX = `plugins.entries.${PLUGIN_ID}.config.`;
/** Outbound sends may arrive while the wallet is still opening at gateway start. */
const OUTBOUND_WALLET_WAIT_MS = 30_000;

/** Account view of `channels.unicity`; dmPolicy/allowFrom fall back to the plugin config. */
export type UnicityAccountConfig = {
  enabled?: boolean;
  name?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: string[];
};

export type ResolvedUnicityAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  publicKey: string;
  nametag?: string;
  config: UnicityAccountConfig;
};

function channelSection(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  const section = (cfg as { channels?: Record<string, unknown> } | undefined)?.channels?.[CHANNEL_ID];
  return section && typeof section === "object" && !Array.isArray(section) ? (section as Record<string, unknown>) : undefined;
}

/** Resolves the single "default" account. `configured` reflects the wallet on disk (or an open wallet), never config alone. */
export function resolveUnicityAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedUnicityAccount {
  const section = channelSection(cfg);
  const plugin = readPluginConfig(cfg);
  const sectionPolicy = section?.dmPolicy;
  const dmPolicy = (isDmPolicy(sectionPolicy) ? sectionPolicy : undefined) ?? plugin.dmPolicy;
  const allowFrom = stringList(section?.allowFrom) ?? plugin.allowFrom;
  const name = optionalString(section?.name);
  const sphere = getSphereOrNull();
  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    name,
    enabled: section?.enabled !== false,
    configured: sphere !== null || walletExists(),
    publicKey: sphere?.identity?.chainPubkey ?? "",
    nametag: sphere?.identity?.nametag ?? plugin.nametag,
    config: {
      ...(typeof section?.enabled === "boolean" ? { enabled: section.enabled } : {}),
      ...(name ? { name } : {}),
      ...(dmPolicy ? { dmPolicy } : {}),
      ...(allowFrom ? { allowFrom } : {}),
    },
  };
}

function knownGroupId(sphere: Sphere, target: string): string | null {
  try {
    return sphere.groupChat?.getGroups().some((g) => g.id === target) ? target : null;
  } catch {
    return null;
  }
}

/** Canonical outbound target: x-only key for hex, "@name" for nametags, unchanged otherwise (group ids, DIRECT://). */
export function normalizeUnicityTarget(raw: string): string | undefined {
  const target = stripChannelPrefix(raw);
  if (!target) return undefined;
  const key = toXOnly(target);
  if (key) return key;
  if (target.startsWith("@")) {
    const tag = normalizeNametag(target);
    return tag ? `@${tag}` : target;
  }
  return target;
}

/**
 * Recipient forms that can never be a group id (after normalizeUnicityTarget): @nametag, x-only key, DIRECT:// address.
 * A bare name is resolved by the transport as a nametag, so it is never a DM fallback.
 */
function isDmRecipient(to: string): boolean {
  return VALID_RECIPIENT.test(to) && (to.startsWith("@") || to.startsWith("DIRECT://") || /^[0-9a-f]{64}$/.test(to));
}

function isInvalidRecipient(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "INVALID_RECIPIENT";
}

/**
 * "open" admits everyone here without a "*" entry, so `openclaw doctor --fix` must not add one. Core reads this
 * capability from the doctor adapter at runtime although ChannelDoctorAdapter does not declare it.
 */
const doctor: ChannelDoctorAdapter & { openDmRequiresAllowFromWildcard: false } = { openDmRequiresAllowFromWildcard: false };

const setupWizard = {
  channel: CHANNEL_ID,
  // Runs in setup-only mode: pure config transforms, no runtime and no wallet.
  getStatus: async ({ cfg }) => {
    const { nametag, apiKey } = readPluginConfig(cfg);
    const wallet = walletExists();
    return {
      channel: CHANNEL_ID,
      configured: Boolean(nametag) || wallet,
      statusLines: [
        nametag ? `Nametag: @${nametag}` : "Nametag: not configured",
        wallet ? "Wallet: present" : "Wallet: created on the first gateway start",
        apiKey ? "Payments: API key set" : `Payments: disabled (no API key; get one at ${API_KEY_URL})`,
      ],
      quickstartScore: 80,
    };
  },
  configure: async ({ cfg, prompter }) => {
    const answers = await collectSetupAnswers(prompter, readPluginConfig(cfg));
    return { cfg: applySetupAnswers(cfg, answers), accountId: DEFAULT_ACCOUNT_ID };
  },
} satisfies ChannelSetupWizardAdapter;

export const unicityChannelPlugin = {
  id: CHANNEL_ID,

  meta: {
    id: CHANNEL_ID,
    label: "Unicity",
    selectionLabel: "Unicity (Sphere DMs)",
    docsPath: "/channels/unicity",
    docsLabel: "unicity",
    blurb: "Private Nostr DMs, group chat and token payments via the Unicity Sphere SDK.",
    order: 110,
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    groupManagement: true,
    media: false,
  },

  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, accountId) => resolveUnicityAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    // The service creates the wallet on first start, after channels start: the account must start and wait for it.
    isConfigured: () => true,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey || null,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => (resolveUnicityAccount(cfg, accountId).config.allowFrom ?? []).map(normalizeAllowEntry),
    formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => formatAllowEntry(String(entry))).filter((entry) => entry.length > 0),
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    chunker: chunkTextForOutbound,
    sendText: async (ctx) => {
      ctx.signal?.throwIfAborted();
      const sphere = getSphereOrNull() ?? (await waitForSphere({ signal: ctx.signal, timeoutMs: OUTBOUND_WALLET_WAIT_MS }));
      if (!sphere) {
        throw new PlatformMessageNotDispatchedError("Unicity wallet is not open", { cause: new Error("sphere unavailable"), retryable: true });
      }
      const to = normalizeUnicityTarget(ctx.to) ?? "";
      const groupId = knownGroupId(sphere, to);
      // Text meant for an unjoined group must never become a DM to whoever owns that name.
      if (!groupId && !isDmRecipient(to)) {
        throw new PlatformMessageNotDispatchedError(
          `Unknown Unicity target "${ctx.to}": not a joined group. Use @name for a nametag or a 64-hex public key.`,
          { cause: new Error("invalid target"), retryable: false },
        );
      }
      ctx.signal?.throwIfAborted();
      await ctx.onPlatformSendDispatch?.();
      ctx.assertDirectAdapterHandoff?.();
      if (groupId) {
        const groupChat = sphere.groupChat;
        if (!groupChat) {
          throw new PlatformMessageNotDispatchedError("Unicity group chat is disabled", { cause: new Error("groupChat unavailable"), retryable: false });
        }
        const sent = await groupChat.sendMessage(groupId, ctx.text, ctx.replyToId ?? undefined);
        if (!sent?.id) throw new Error(`Unicity group ${groupId} rejected the message or is not joined`);
        return attachChannelToResult(CHANNEL_ID, { to: groupId, messageId: sent.id });
      }
      try {
        const sent = await sphere.communications.sendDM(to, ctx.text);
        return attachChannelToResult(CHANNEL_ID, { to, messageId: sent.id });
      } catch (err) {
        if (isInvalidRecipient(err)) {
          throw new PlatformMessageNotDispatchedError(`Unicity recipient "${ctx.to}" could not be resolved`, { cause: err, retryable: false });
        }
        throw err;
      }
    },
  },

  gateway: {
    startAccount: (ctx) => startUnicityAccount(ctx),
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ account, snapshot }) => ({
      configured: snapshot.configured ?? account.configured,
      publicKey: snapshot.publicKey ?? (account.publicKey || null),
      nametag: account.nametag ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      ...runtime,
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey || null,
    }),
  },

  messaging: {
    normalizeTarget: (raw) => normalizeUnicityTarget(raw),
    targetResolver: {
      looksLikeId: (raw, normalized) => looksLikeTarget((normalized ?? raw).trim()),
      hint: "<@nametag|pubkey|group id>",
    },
  },

  agentPrompt: {
    inboundFormattingHints: () => ({
      text_markup: "plain_text",
      rules: [
        "Unicity DMs and group messages are shown as plain text: no Markdown headings, tables or HTML.",
        "State coin symbols with amounts. Never include private keys, mnemonics or wallet file paths.",
      ],
    }),
    messageToolHints: () => [
      "- Unicity `target`: `@nametag`, a 64-hex public key, or a group id. The current sender already receives your normal reply; use the message tool only for other recipients.",
    ],
  },

  security: {
    // Read defensively: the security audit may pass partial account objects.
    resolveDmPolicy: ({ cfg, account }) => {
      const config = account?.config ?? resolveUnicityAccount(cfg).config;
      const allowFrom = config.allowFrom ?? [];
      const policy = effectiveDmPolicy(config.dmPolicy, allowFrom);
      const section = channelSection(cfg);
      return {
        policy,
        allowFrom: policy === "open" ? ["*"] : allowFrom,
        policyPath: section?.dmPolicy !== undefined ? `${CHANNEL_CONFIG_PREFIX}dmPolicy` : `${PLUGIN_CONFIG_PREFIX}dmPolicy`,
        // A prefix: core renders `${allowFromPath}allowFrom`.
        allowFromPath: section?.allowFrom !== undefined ? CHANNEL_CONFIG_PREFIX : PLUGIN_CONFIG_PREFIX,
        approveHint:
          policy === "pairing"
            ? "Approve via: openclaw pairing list unicity / openclaw pairing approve unicity <code>"
            : `openclaw config set ${CHANNEL_CONFIG_PREFIX}allowFrom '["<64-hex pubkey or @nametag>"]'`,
        normalizeEntry: normalizeAllowEntry,
        classifyEntryAuthentication: classifyAllowEntry,
      };
    },
    dmRouting: {
      resolveDmScope: ({ cfg }) => resolveUnicityDmScope(cfg),
    },
  },

  pairing: {
    idLabel: "Unicity pubkey",
    normalizeAllowEntry,
    // Runs where the approval happens; the CLI has no open wallet and cannot notify.
    notifyApproval: async ({ id }) => {
      const sphere = getSphereOrNull();
      if (!sphere) throw new Error("the Unicity wallet is not open in this process; the requester was not notified");
      const key = toXOnly(id);
      if (!key) return;
      await sphere.communications.sendDM(key, "Your access request was approved. You can message this agent now.");
    },
  },

  setupWizard,

  doctor,

  groups: {
    resolveRequireMention: () => false,
  },

  directory: {
    listGroups: async () => {
      const groupChat = getSphereOrNull()?.groupChat;
      if (!groupChat) return [];
      return groupChat.getGroups().map((g) => ({ kind: "group" as const, id: g.id, name: g.name }));
    },
    // Member nametags are self-asserted: expose them only as an unverified hint, never as a resolvable name.
    listGroupMembers: async ({ groupId }) => {
      const groupChat = getSphereOrNull()?.groupChat;
      if (!groupChat) return [];
      return groupChat.getMembers(groupId).flatMap((m) => {
        const key = toXOnly(m.pubkey);
        if (!key) return [];
        return [{ kind: "user" as const, id: key, name: `${shortKey(key)}${claimedNameSuffix(m.nametag)}` }];
      });
    },
  },
} satisfies ChannelPlugin<ResolvedUnicityAccount>;

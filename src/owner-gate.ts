/**
 * Code-level owner enforcement for the unicity_* agent tools and for core `message` sends through this channel.
 *
 * Two layers driven by one decision (isOwnerRequester), so they cannot disagree:
 * - tool factories: owner-only tools are not offered to non-owner runs at all;
 * - before_tool_call: per-call veto that fails closed when the host cannot prove the requester.
 * The unicity channel adds a third layer: every turn without owner authority gets an allowlist that also denies the
 * owner-only tools by name (nonOwnerToolPolicy for stranger DMs and wallet events, groupToolPolicy for every group turn).
 * Prompt text is advisory only.
 */

import type { TSchema } from "typebox";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { stripChannelPrefix } from "./access.js";
import { CHANNEL_ID, PLUGIN_ID } from "./config.js";
import { getOwnerAuthority, toXOnly } from "./identity.js";
import { getUnicityRuntimeOrNull } from "./runtime.js";
import { isGroupId } from "./validation.js";

/** Tools only the authenticated owner may use. */
export const OWNER_ONLY_TOOL_NAMES = [
  "unicity_send_message",
  "unicity_get_balance",
  "unicity_list_tokens",
  "unicity_get_transaction_history",
  "unicity_send_tokens",
  "unicity_list_payment_requests",
  "unicity_respond_payment_request",
  "unicity_top_up",
  "unicity_create_public_group",
  "unicity_create_private_group",
  "unicity_join_group",
  "unicity_leave_group",
  "unicity_send_group_message",
] as const;

/** Non-owners may use these only against themselves: unicity_request_payment requests payment FROM the requester. */
export const SENDER_SCOPED_TOOL_NAMES = ["unicity_request_payment"] as const;

/** Tools everyone may use (with NON_OWNER_PARAMS forced for non-owners). */
export const PUBLIC_TOOL_NAMES = ["unicity_list_groups"] as const;

/** Every tool the plugin registers; must equal openclaw.plugin.json contracts.tools. Each tool is in exactly one class. */
export const ALL_TOOL_NAMES = [...OWNER_ONLY_TOOL_NAMES, ...SENDER_SCOPED_TOOL_NAMES, ...PUBLIC_TOOL_NAMES] as const;

/** The only tools a non-owner turn is offered (before any operator additions). */
export const STRANGER_TOOL_ALLOWLIST: readonly string[] = [...SENDER_SCOPED_TOOL_NAMES, ...PUBLIC_TOOL_NAMES];

/** Core's message tool: it can send through this channel's outbound adapter from the agent's wallet identity. */
const MESSAGE_TOOL = "message";

/** Tool names the before_tool_call gate inspects (its hook matcher). */
export const TOOL_GATE_MATCHER = [...OWNER_ONLY_TOOL_NAMES, ...SENDER_SCOPED_TOOL_NAMES, MESSAGE_TOOL] as const;

const OWNER_ONLY: ReadonlySet<string> = new Set(OWNER_ONLY_TOOL_NAMES);
const SENDER_SCOPED: ReadonlySet<string> = new Set(SENDER_SCOPED_TOOL_NAMES);
const PUBLIC: ReadonlySet<string> = new Set(PUBLIC_TOOL_NAMES);

/** True when a tool-policy entry (core syntax: case-insensitive, `*` wildcard) selects `name`. */
function policyEntrySelects(entry: string, name: string): boolean {
  const pattern = entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${pattern}$`).test(name);
}

/** A per-turn ConversationToolPolicy (core: deny wins over allow). */
type ToolPolicy = { allow: string[]; deny: string[] };

/** Entries that would let one of `denied` through: its name, a glob over it, this plugin's id, every plugin tool. */
function selectsAny(entry: string, denied: readonly string[]): boolean {
  const e = entry.trim().toLowerCase();
  return e === "group:plugins" || [PLUGIN_ID, ...denied].some((name) => policyEntrySelects(e, name));
}

/**
 * Allowlist policy: `base` plus the operator's `extraAllow` entries that select none of `denied`. `denied` is also
 * denied by name: core checks deny before allow (src/agents/tool-policy-match.ts), so those tools stay out even if the
 * filtering ever lets one in.
 */
function allowlistPolicy(base: readonly string[], denied: readonly string[], extraAllow: readonly string[]): ToolPolicy {
  const extra = extraAllow.filter((entry) => !selectsAny(entry, denied));
  return { allow: [...new Set([...base, ...extra])], deny: [...denied] };
}

/**
 * Per-turn ConversationToolPolicy for stranger DMs and for every incoming transfer or payment request turn. An
 * allowlist, so core tools (exec, fs, sessions, message, ...) are unavailable too; `extraAllow` is the operator's
 * plugin-config `strangerToolsAllow`. Entries selecting an owner-only tool are dropped: the owner's own transfers and
 * payment requests carry the owner's key, so this policy is what keeps the wallet tools out of those turns.
 */
export function nonOwnerToolPolicy(extraAllow: readonly string[] = []): ToolPolicy {
  return allowlistPolicy(STRANGER_TOOL_ALLOWLIST, OWNER_ONLY_TOOL_NAMES, extraAllow);
}

/**
 * Per-turn ConversationToolPolicy for every Unicity group turn: nonOwnerToolPolicy without the sender-scoped tools.
 * A group sender key is only the relay's word, so it must not become the forced recipient of a payment request
 * (requesting payment from yourself needs a DM).
 */
export function groupToolPolicy(extraAllow: readonly string[] = []): ToolPolicy {
  return allowlistPolicy(PUBLIC_TOOL_NAMES, [...OWNER_ONLY_TOOL_NAMES, ...SENDER_SCOPED_TOOL_NAMES], extraAllow);
}

/** The sender-scoped parameter that is forced to the requester's key for non-owners. */
const SENDER_SCOPED_PARAM = "recipient";

/** Internal unicity_list_groups parameter (not in its schema), forced for non-owners: list public groups only. */
export const PUBLIC_GROUPS_ONLY_PARAM = "publicGroupsOnly";

/**
 * Internal unicity_request_payment parameter (not in its schema): true when a non-owner asked for a request to
 * themselves, false for the owner. Forced on every call, so the model can never set it.
 */
export const SENDER_SCOPED_FLAG_PARAM = "senderScoped";

/** Params forced on the public tools for non-owner requesters. Private groups are hidden with unguessable ids. */
const NON_OWNER_PARAMS: Readonly<Record<string, Record<string, unknown>>> = {
  unicity_list_groups: { [PUBLIC_GROUPS_ONLY_PARAM]: true },
};

/** Params forced on the owner's calls. */
const OWNER_PARAMS: Readonly<Record<string, Record<string, unknown>>> = {
  unicity_request_payment: { [SENDER_SCOPED_FLAG_PARAM]: false },
};

export type RequesterInfo = {
  channel?: string;
  senderId?: string;
  senderIsOwner?: boolean;
  sessionKey?: string;
  /** Where the run delivers when that is a Unicity conversation (the tool context's deliveryContext.to). */
  unicityTarget?: string;
};

type GateBlock = { block: true; blockReason: string };

const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

const isUnicityChannel = (channel: string | undefined) => lower(channel) === CHANNEL_ID;

/**
 * True for a Unicity group session (`agent:<id>:unicity:group:<groupId>`). Group senders are asserted by the relay (the
 * SDK does not verify NIP-29 event signatures) and share one transcript with strangers, so no run there is an owner
 * run. The channel routes every group turn into its per-group session (whatever session.groupScope says) and does not
 * dispatch a group turn that a binding routes elsewhere, so this check sees every group turn.
 */
function isUnicityGroupSession(sessionKey: string | undefined): boolean {
  return /(?:^|:)unicity:group:/.test(lower(sessionKey));
}

/** True when a Unicity delivery target is a group (`group:<id>` or a group id) rather than a DM key. */
function isUnicityGroupTarget(target: string | undefined): boolean {
  if (!target) return false;
  const t = stripChannelPrefix(target);
  return /^group:/i.test(t) || isGroupId(t);
}

/** A Unicity group run, by session key or (defense in depth) by its delivery target. */
function inUnicityGroup(r: RequesterInfo): boolean {
  return isUnicityGroupSession(r.sessionKey) || isUnicityGroupTarget(r.unicityTarget);
}

/**
 * Owner check shared by both layers. Never in a Unicity group. On the unicity channel only the authenticated sender key
 * decides (the host's senderIsOwner can come from a mistaken or pairing-bootstrapped commands.ownerAllowFrom entry); on
 * other channels the host's senderIsOwner decides.
 */
export function isOwnerRequester(r: RequesterInfo): boolean {
  if (inUnicityGroup(r)) return false;
  if (isUnicityChannel(r.channel)) return getOwnerAuthority()?.isOwnerKey(r.senderId) === true;
  return r.senderIsOwner === true;
}

/**
 * The requester's authenticated x-only Unicity key: null off the unicity channel, without a valid sender id, and in a
 * group, where the sender key is only the relay's word.
 */
function unicitySenderKey(r: RequesterInfo): string | null {
  return isUnicityChannel(r.channel) && !inUnicityGroup(r) ? toXOnly(r.senderId) : null;
}

function requesterFromToolContext(ctx: OpenClawPluginToolContext): RequesterInfo {
  const delivery = ctx.deliveryContext;
  return {
    channel: ctx.messageChannel,
    senderId: ctx.requesterSenderId,
    senderIsOwner: ctx.senderIsOwner,
    sessionKey: ctx.sessionKey,
    unicityTarget: isUnicityChannel(delivery?.channel) ? delivery?.to : undefined,
  };
}

type ToolOverrides = { description?: string; parameters?: TSchema; params: Record<string, unknown> };

/**
 * Same tool, but execute() first re-checks that this plugin generation's invocation authority is still live, and
 * applies `overrides.params` over whatever the model passed.
 */
function withInvocationGuard(tool: AnyAgentTool, ctx: OpenClawPluginToolContext, overrides?: ToolOverrides): AnyAgentTool {
  return {
    ...tool,
    ...(overrides?.description ? { description: overrides.description } : {}),
    ...(overrides?.parameters ? { parameters: overrides.parameters } : {}),
    execute: async (toolCallId, params, signal, onUpdate) => {
      ctx.assertInvocationCurrent?.();
      const effective = overrides ? { ...(params as Record<string, unknown>), ...overrides.params } : params;
      return tool.execute(toolCallId, effective, signal, onUpdate);
    },
  };
}

/** Copy of an object schema without property `name` (the plugin supplies it, so the model is not asked for it). */
function withoutProperty(schema: TSchema, name: string): TSchema {
  // Copy descriptors, not a spread: TypeBox keeps its kind marker in a non-enumerable property.
  const copy = Object.create(Object.getPrototypeOf(schema), Object.getOwnPropertyDescriptors(schema)) as Record<string, unknown>;
  const { properties, required } = copy;
  if (properties && typeof properties === "object") {
    copy.properties = Object.fromEntries(Object.entries(properties).filter(([k]) => k !== name));
  }
  if (Array.isArray(required)) copy.required = required.filter((k) => k !== name);
  return copy as TSchema;
}

/**
 * Wraps a tool for registration as a factory. For the owner: their OWNER_PARAMS are forced. For non-owners:
 * sender-scoped -> the recipient is forced to the requester's authenticated key and the call is flagged sender-scoped
 * (null when there is no key: other channels, groups); public -> their NON_OWNER_PARAMS are forced; everything else
 * (owner-only, or a tool missing from every class) -> null.
 */
export function gatedToolFactory(tool: AnyAgentTool): (ctx: OpenClawPluginToolContext) => AnyAgentTool | null {
  return (ctx) => {
    const requester = requesterFromToolContext(ctx);
    if (isOwnerRequester(requester)) {
      const forced = OWNER_PARAMS[tool.name];
      return withInvocationGuard(tool, ctx, forced ? { params: forced } : undefined);
    }
    if (SENDER_SCOPED.has(tool.name)) {
      const key = unicitySenderKey(requester);
      if (!key) return null;
      return withInvocationGuard(tool, ctx, {
        description: `${tool.description} In this conversation the request always goes to the current sender.`,
        parameters: withoutProperty(tool.parameters, SENDER_SCOPED_PARAM),
        params: { [SENDER_SCOPED_PARAM]: key, [SENDER_SCOPED_FLAG_PARAM]: true },
      });
    }
    if (!PUBLIC.has(tool.name)) return null;
    const forced = NON_OWNER_PARAMS[tool.name];
    return withInvocationGuard(tool, ctx, forced ? { params: forced } : undefined);
  };
}

function readRequester(ctx: unknown): RequesterInfo | null {
  const c = ctx !== null && typeof ctx === "object" ? (ctx as { requester?: unknown; sessionKey?: unknown }) : {};
  const r = c.requester;
  if (r === null || typeof r !== "object") return null;
  const { channel, senderId, senderIsOwner } = r as Record<string, unknown>;
  return {
    channel: typeof channel === "string" ? channel : undefined,
    senderId: typeof senderId === "string" ? senderId : undefined,
    senderIsOwner: senderIsOwner === true,
    sessionKey: typeof c.sessionKey === "string" ? c.sessionKey : undefined,
  };
}

const block = (blockReason: string): GateBlock => ({ block: true, blockReason });

/** Explicit destinations of a message-tool call (target, to, channelId, targets[]). */
function messageTargets(params: Record<string, unknown>): string[] {
  const list = [params.target, params.to, params.channelId, ...(Array.isArray(params.targets) ? params.targets : [])];
  return list.filter((t): t is string => typeof t === "string" && t.trim() !== "");
}

/** Core's internal run channel (Control UI, sessions_send) and channels that never deliver; core falls back from them. */
const NON_DELIVERY_CHANNELS: ReadonlySet<string> = new Set(["webchat", "heartbeat", "cron", "webhook", "voice", "sessions_send"]);

/** Keys of the `channels` config section that are not channels (lowercased). */
const CHANNEL_CONFIG_SETTINGS: ReadonlySet<string> = new Set(["defaults", "modelbychannel"]);

/** Sessions core infers a Unicity delivery route from (`agent:<id>:unicity:...`), e.g. for internal runs in them. */
function isUnicitySession(sessionKey: string | undefined): boolean {
  return /^agent:[^:]+:unicity:/.test(lower(sessionKey));
}

/** The gateway's live config (the hook context carries none); undefined makes every explicit channel count as unknown. */
function liveConfig(): unknown {
  try {
    return getUnicityRuntimeOrNull()?.config.current();
  } catch {
    return undefined;
  }
}

/**
 * Whether an explicit message-tool channel counts as another channel: one enabled under `channels` (core's
 * isConfiguredChannel). Core sends to any name it can resolve to a loaded channel and falls back to the run's channel
 * otherwise; treating every other name as unresolvable errs towards that fallback.
 */
function namesOtherChannel(explicit: string): boolean {
  if (!explicit || explicit === CHANNEL_ID || explicit === "all") return false;
  if (NON_DELIVERY_CHANNELS.has(explicit) || CHANNEL_CONFIG_SETTINGS.has(explicit)) return false;
  const config = liveConfig();
  const channels = config !== null && typeof config === "object" ? (config as { channels?: unknown }).channels : undefined;
  if (channels === null || typeof channels !== "object" || !Object.hasOwn(channels, explicit)) return false;
  const entry = (channels as Record<string, unknown>)[explicit];
  return entry !== null && typeof entry === "object" && !Array.isArray(entry) && (entry as { enabled?: unknown }).enabled !== false;
}

/**
 * Where core's message tool falls back to when no explicit channel resolves: the run's own channel, or for internal and
 * channel-less runs the channel of the session (or the only configured channel), which can be Unicity.
 */
function fallsBackToUnicity(r: RequesterInfo | null): boolean {
  const channel = lower(r?.channel);
  return !channel || channel === CHANNEL_ID || NON_DELIVERY_CHANNELS.has(channel) || isUnicitySession(r?.sessionKey);
}

/**
 * Non-owners may use core's message tool through this channel only towards themselves: their own DM conversation (no
 * explicit target) or their own key, and not at all from a group or without a Unicity sender key (internal runs such as
 * sessions_send into a Unicity session). Anything else would send from the agent's wallet identity on a stranger's
 * behalf, which unicity_send_message / unicity_send_group_message reserve for the owner.
 *
 * Fails closed on the channel core picks: an explicit `channel` counts only when it names another channel enabled
 * under `channels`; for anything else (unknown ids, "all" on a send, ...) core falls back to the run's channel. Calls
 * that really go to another channel are left to that channel's gates.
 */
function gateMessageCall(params: Record<string, unknown>, requester: RequesterInfo | null): GateBlock | void {
  if (requester && isOwnerRequester(requester)) return;
  const action = lower(params.action) || "send";
  const explicit = lower(params.channel);
  if (namesOtherChannel(explicit)) return;
  const reachesUnicity =
    explicit === CHANNEL_ID || (action === "broadcast" && (!explicit || explicit === "all")) || fallsBackToUnicity(requester);
  if (!reachesUnicity) return;
  const own = requester ? unicitySenderKey(requester) : null;
  if (own) {
    const targets = messageTargets(params);
    if (targets.length === 0 && action !== "broadcast") return;
    if (targets.length > 0 && targets.every((t) => toXOnly(stripChannelPrefix(t)) === own)) return;
  }
  return block("Sending Unicity messages to other recipients is restricted to the wallet owner; reply in this conversation instead.");
}

/**
 * before_tool_call handler: blocks owner-only tools (incl. pay/decline) for non-owner requesters and fails closed on a
 * missing requester; restricts core `message` sends through this channel (see gateMessageCall).
 */
export function beforeToolCallGate(event: unknown, ctx: unknown): GateBlock | void {
  try {
    const e = event !== null && typeof event === "object" ? (event as { toolName?: unknown; params?: unknown }) : {};
    const toolName = lower(e.toolName);
    const requester = readRequester(ctx);
    if (toolName === MESSAGE_TOOL) {
      const params = e.params !== null && typeof e.params === "object" ? (e.params as Record<string, unknown>) : {};
      return gateMessageCall(params, requester);
    }
    if (!OWNER_ONLY.has(toolName) && !SENDER_SCOPED.has(toolName)) return;
    if (!requester) return block("The requester of this Unicity wallet action could not be verified, so it is blocked.");
    if (isOwnerRequester(requester)) return;
    if (SENDER_SCOPED.has(toolName) && unicitySenderKey(requester)) return;
    return block("This Unicity wallet action is restricted to the wallet owner.");
  } catch {
    return block("The Unicity owner check failed, so the action is blocked.");
  }
}

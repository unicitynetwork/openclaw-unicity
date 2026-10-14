/** Unicity — wallet identity, encrypted DMs, NIP-29 groups and token payments for OpenClaw agents. */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig, OpenClawPluginApi, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { unicityChannelPlugin } from "./channel.js";
import { registerUnicityCli } from "./cli.js";
import { CHANNEL_ID, PLUGIN_ID, readPluginConfig, type UnicityConfig } from "./config.js";
import { OwnerAuthority, setOwnerAuthority } from "./identity.js";
import { OWNER_ONLY_TOOL_NAMES, TOOL_GATE_MATCHER, beforeToolCallGate, gatedToolFactory } from "./owner-gate.js";
import { buildIdentityBlock } from "./prompt.js";
import { setUnicityRuntime } from "./runtime.js";
import { closeGatewayWallet, getSphereOrNull, openGatewayWallet } from "./sphere.js";
import { MNEMONIC_PATH, walletExists } from "./storage.js";
import { createPrivateGroupTool } from "./tools/create-private-group.js";
import { createPublicGroupTool } from "./tools/create-public-group.js";
import { getBalanceTool } from "./tools/get-balance.js";
import { getTransactionHistoryTool } from "./tools/get-transaction-history.js";
import { joinGroupTool } from "./tools/join-group.js";
import { leaveGroupTool } from "./tools/leave-group.js";
import { listGroupsTool } from "./tools/list-groups.js";
import { listPaymentRequestsTool } from "./tools/list-payment-requests.js";
import { listTokensTool } from "./tools/list-tokens.js";
import { requestPaymentTool } from "./tools/request-payment.js";
import { respondPaymentRequestTool } from "./tools/respond-payment-request.js";
import { sendGroupMessageTool } from "./tools/send-group-message.js";
import { sendMessageTool } from "./tools/send-message.js";
import { sendTokensTool } from "./tools/send-tokens.js";
import { topUpTool } from "./tools/top-up.js";
import { errorMessage } from "./util.js";

const TOOLS = [
  sendMessageTool,
  getBalanceTool,
  listTokensTool,
  getTransactionHistoryTool,
  sendTokensTool,
  requestPaymentTool,
  listPaymentRequestsTool,
  respondPaymentRequestTool,
  topUpTool,
  createPublicGroupTool,
  createPrivateGroupTool,
  joinGroupTool,
  leaveGroupTool,
  listGroupsTool,
  sendGroupMessageTool,
];

/** Backoff between failed wallet opens (no network at boot, the wallet lock held by a CLI command, ...). */
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 300_000;

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/** Opens the gateway wallet, retrying with capped exponential backoff until it opens or `signal` aborts. */
async function openWalletWithRetry(cfg: UnicityConfig, ctx: OpenClawPluginServiceContext, signal: AbortSignal): Promise<void> {
  const log = ctx.logger;
  for (let delay = RETRY_MIN_MS; !signal.aborted; delay = Math.min(delay * 2, RETRY_MAX_MS)) {
    try {
      const { sphere, created } = await openGatewayWallet(cfg, log, { signal });
      // stop() already ran; closeGatewayWallet() owns this wallet now.
      if (signal.aborted) return;
      ctx.serviceHealth?.clearFailure();
      if (created) log.warn(`[unicity] New wallet created. Back up the mnemonic in ${MNEMONIC_PATH}.`);
      const id = sphere.identity;
      log.info(`[unicity] Identity: ${id?.nametag ? `@${id.nametag} ` : ""}${id?.chainPubkey ?? "unknown"} ${id?.directAddress ?? ""}`.trim());
      return;
    } catch (err) {
      if (signal.aborted) return;
      log.error(`[unicity] Wallet failed to start: ${errorMessage(err)}; retrying in ${delay / 1000}s`);
      ctx.serviceHealth?.reportFailure(err);
      await sleep(delay, signal);
    }
  }
}

/** Opens the gateway wallet in the background so service start never blocks gateway startup. */
function registerWalletService(api: OpenClawPluginApi): void {
  let starting: AbortController | null = null;
  api.registerService({
    id: "unicity",
    start(ctx) {
      const cfg = readPluginConfig(ctx.config);
      for (const w of cfg.warnings) ctx.logger.warn(`[unicity] ${w}`);
      setOwnerAuthority(new OwnerAuthority({ owner: cfg.owner, ownerPubkeys: cfg.ownerPubkeys, log: ctx.logger }));
      // A new wallet greets its owner once, when it is created: create none until there is an owner to greet. The
      // config reload that adds the owner restarts this service.
      if (!cfg.owner && cfg.ownerPubkeys.length === 0 && !walletExists()) {
        ctx.logger.warn("[unicity] No owner configured: the wallet is created once one is. Run 'openclaw unicity setup'.");
        return;
      }
      const abort = new AbortController();
      starting = abort;
      void openWalletWithRetry(cfg, ctx, abort.signal);
    },
    async stop() {
      starting?.abort();
      starting = null;
      await closeGatewayWallet();
    },
  });
}

function conversationAccessGranted(config: OpenClawConfig): boolean {
  return config.plugins?.entries?.[PLUGIN_ID]?.hooks?.allowConversationAccess === true;
}

/**
 * Optional (needs the operator's hooks.allowConversationAccess grant): wallet identity for owner turns on OTHER channels.
 * Unicity turns already carry it in the channel's system prompt. Runs in the post-policy phase so the finalized tool
 * surface proves the requester is the owner: owner-only tools are only offered to owners.
 */
function registerIdentityPromptHook(api: OpenClawPluginApi): void {
  api.on(
    "before_prompt_build",
    (_event, ctx) => {
      if (ctx.channel === CHANNEL_ID || ctx.messageProvider === CHANNEL_ID) return;
      const authority = ctx.toolAuthority;
      if (!authority || !OWNER_ONLY_TOOL_NAMES.some((name) => authority.allows(name))) return;
      const id = getSphereOrNull()?.identity;
      if (!id) return;
      return { appendContext: buildIdentityBlock(id) };
    },
    { requiresToolAuthority: true, timeoutMs: 2_000 },
  );
}

export default defineChannelPluginEntry({
  id: PLUGIN_ID,
  name: "Unicity",
  description: "Unicity wallet identity, encrypted DMs, NIP-29 group chat and token payments via the Sphere SDK",
  plugin: unicityChannelPlugin,
  setRuntime: setUnicityRuntime,
  registerCliMetadata(api) {
    registerUnicityCli(api);
  },
  registerFull(api) {
    for (const tool of TOOLS) api.registerTool(gatedToolFactory(tool), { name: tool.name });
    api.on("before_tool_call", beforeToolCallGate, { matcher: [...TOOL_GATE_MATCHER], priority: 100 });
    if (api.registrationMode !== "full") return;
    registerWalletService(api);
    if (conversationAccessGranted(api.config)) registerIdentityPromptHook(api);
    else api.logger.debug?.("[unicity] before_prompt_build not registered (hooks.allowConversationAccess not granted).");
  },
});

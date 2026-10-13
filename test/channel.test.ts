import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ sphere: null as unknown, walletExists: true }));

vi.mock("@unicitylabs/sphere-sdk", () => ({
  isValidNametag: (n: string) => /^[a-z0-9_-]{3,20}$/.test(n) || /^\+[1-9][0-9]{6,14}$/.test(n),
}));

vi.mock("openclaw/plugin-sdk/channel-send-result", () => ({
  attachChannelToResult: (channel: string, result: object) => ({ ...result, channel }),
}));

vi.mock("openclaw/plugin-sdk/text-chunking", () => ({
  chunkTextForOutbound: vi.fn((text: string) => [text]),
}));

vi.mock("../src/inbound.js", () => ({
  startUnicityAccount: vi.fn(async () => {}),
  resolveUnicityDmScope: vi.fn(() => "per-account-channel-peer"),
}));

vi.mock("../src/sphere.js", () => ({
  getSphereOrNull: () => h.sphere,
  waitForSphere: vi.fn(async () => h.sphere),
}));

vi.mock("../src/storage.js", () => ({
  OWNER_PIN_PATH: "/nonexistent/owner-pin.json",
  readJsonFile: (_path: string, fallback: unknown) => fallback,
  writeJsonFileAtomic: vi.fn(),
  walletExists: () => h.walletExists,
}));

vi.mock("../src/setup.js", () => ({
  collectSetupAnswers: vi.fn(async () => ({ nametag: "newbot", owner: "alice", network: "testnet2", apiKey: "sk_new" })),
  applySetupAnswers: vi.fn((cfg: Record<string, unknown>, answers: unknown) => ({ ...cfg, applied: answers })),
}));

import { readFileSync } from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { unicityChannelPlugin, normalizeUnicityTarget, resolveUnicityAccount, type ResolvedUnicityAccount } from "../src/channel.js";
import { resolveUnicityDmScope, startUnicityAccount } from "../src/inbound.js";
import { applySetupAnswers, collectSetupAnswers } from "../src/setup.js";
import { waitForSphere } from "../src/sphere.js";

type Any = any;

const AGENT_X = "a".repeat(64);
const AGENT_CHAIN = `02${AGENT_X}`;
const PEER_X = "c".repeat(64);
const PEER_CHAIN = `03${PEER_X}`;
const GROUP_ID = "devs-0123456789abcdef";

const plugin = unicityChannelPlugin;
const cfgOf = (c: Record<string, unknown>) => c as unknown as OpenClawConfig;
const pluginCfg = (config: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  cfgOf({ plugins: { entries: { "openclaw-unicity": { enabled: true, config } } }, ...extra });

function createSphere() {
  let seq = 0;
  const groupChat = {
    getGroups: vi.fn(() => [{ id: GROUP_ID, name: "Devs", visibility: "PUBLIC" }]),
    getMembers: vi.fn(() => [
      { pubkey: PEER_X, groupId: GROUP_ID, role: "MEMBER", nametag: "owner", joinedAt: 1 },
      { pubkey: AGENT_X, groupId: GROUP_ID, role: "ADMIN", joinedAt: 0 },
      { pubkey: "not-a-key", groupId: GROUP_ID, role: "MEMBER", joinedAt: 2 },
    ]),
    sendMessage: vi.fn(async (groupId: string, content: string) => ({ id: `gev-${++seq}`, groupId, content })),
  };
  return {
    identity: { chainPubkey: AGENT_CHAIN, nametag: "agentbot", directAddress: "DIRECT://00aa" },
    groupChat: groupChat as typeof groupChat | null,
    communications: {
      sendDM: vi.fn(async (to: string, content: string) => ({ id: `dm-${++seq}`, recipientPubkey: to, content })),
    },
  };
}

let sphere: ReturnType<typeof createSphere>;

beforeEach(() => {
  sphere = createSphere();
  h.sphere = sphere;
  h.walletExists = true;
  vi.mocked(waitForSphere).mockClear();
});

function sendCtx(over: Record<string, unknown> = {}) {
  return { cfg: cfgOf({}), to: "@alice", text: "hello", accountId: "default", ...over } as Any;
}

describe("plugin shape", () => {
  it("declares the unicity channel", () => {
    expect(plugin.id).toBe("unicity");
    expect(plugin.meta).toEqual(expect.objectContaining({ id: "unicity", label: "Unicity" }));
    expect(plugin.meta.selectionLabel).toBeTruthy();
    expect(plugin.meta.docsPath).toBeTruthy();
    expect(plugin.meta.blurb).toBeTruthy();
    expect(plugin.capabilities.chatTypes).toEqual(["direct", "group"]);
    expect(plugin.reload.configPrefixes).toEqual(["channels.unicity"]);
  });

  it("delegates gateway.startAccount to the inbound pipeline", async () => {
    const ctx = { accountId: "default" } as Any;
    await plugin.gateway.startAccount(ctx);
    expect(startUnicityAccount).toHaveBeenCalledWith(ctx);
  });

  it("does not require mentions in groups", () => {
    expect(plugin.groups.resolveRequireMention()).toBe(false);
  });

  it("tells doctor that open needs no '*' allowFrom entry, in the plugin and in the package metadata", () => {
    expect(plugin.doctor).toEqual({ openDmRequiresAllowFromWildcard: false });
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.openclaw.channel.doctorCapabilities).toEqual({ openDmRequiresAllowFromWildcard: false });
  });
});

describe("config adapter", () => {
  it("has a single default account that always starts", () => {
    expect(plugin.config.listAccountIds()).toEqual(["default"]);
    expect(plugin.config.defaultAccountId()).toBe("default");
    expect(plugin.config.isConfigured()).toBe(true);
  });

  it("derives configured from the wallet on disk, not from module state", () => {
    h.sphere = null;
    h.walletExists = false;
    expect(resolveUnicityAccount(cfgOf({})).configured).toBe(false);
    h.walletExists = true;
    const account = resolveUnicityAccount(cfgOf({}));
    expect(account.configured).toBe(true);
    expect(account.publicKey).toBe("");
  });

  it("reports the open wallet's identity", () => {
    const account = plugin.config.resolveAccount(cfgOf({}), null);
    expect(account).toEqual(expect.objectContaining({ accountId: "default", enabled: true, configured: true, publicKey: AGENT_CHAIN, nametag: "agentbot" }));
  });

  it("lets channels.unicity dmPolicy/allowFrom win over the plugin config", () => {
    const cfg = pluginCfg(
      { dmPolicy: "open", allowFrom: ["@plugin"], nametag: "fromplugin" },
      { channels: { unicity: { dmPolicy: "pairing", allowFrom: ["@channel"], name: " My bot ", enabled: false } } },
    );
    const account = resolveUnicityAccount(cfg, "default");
    expect(account.config.dmPolicy).toBe("pairing");
    expect(account.config.allowFrom).toEqual(["@channel"]);
    expect(account.name).toBe("My bot");
    expect(account.enabled).toBe(false);
  });

  it("takes the nametag from the plugin config and only the access keys from channels.unicity", () => {
    h.sphere = null;
    const cfg = cfgOf({ channels: { unicity: { allowFrom: [" @Bob ", ""] } } });
    const account = resolveUnicityAccount(cfg);
    expect(account.nametag).toBeUndefined();
    expect(account.config).toEqual({ allowFrom: ["@Bob"] });
    expect(resolveUnicityAccount(pluginCfg({ nametag: "mybot" })).nametag).toBe("mybot");
  });

  it("falls back to the plugin config and ignores invalid channel values", () => {
    const cfg = pluginCfg({ dmPolicy: "allowlist", allowFrom: ["@alice"] }, { channels: { unicity: { dmPolicy: "everyone" } } });
    const account = resolveUnicityAccount(cfg);
    expect(account.config.dmPolicy).toBe("allowlist");
    expect(account.config.allowFrom).toEqual(["@alice"]);
  });

  it("describes the account without extra fields", () => {
    const account = resolveUnicityAccount(cfgOf({}));
    expect(plugin.config.describeAccount(account, cfgOf({}))).toEqual({
      accountId: "default",
      name: undefined,
      enabled: true,
      configured: true,
      publicKey: AGENT_CHAIN,
    });
  });

  it("normalizes allowFrom entries", () => {
    const cfg = cfgOf({ channels: { unicity: { allowFrom: [PEER_CHAIN, "@Alice", "*"] } } });
    expect(plugin.config.resolveAllowFrom({ cfg })).toEqual([PEER_X, "@alice", "*"]);
  });

  it("formats allowFrom entries so commands.ownerAllowFrom matches the x-only SenderId", () => {
    expect(plugin.config.formatAllowFrom({ cfg: cfgOf({}), allowFrom: [PEER_CHAIN, PEER_X.toUpperCase(), "@Alice", " ", 42] })).toEqual([
      PEER_X,
      PEER_X,
      "alice",
      "42",
    ]);
  });
});

describe("security adapter", () => {
  const resolveDmPolicy = (cfg: OpenClawConfig, account?: unknown) =>
    plugin.security.resolveDmPolicy({ cfg, account: (account ?? resolveUnicityAccount(cfg)) as ResolvedUnicityAccount });

  it("defaults to open with a '*' allowFrom and plugin-config paths", () => {
    const policy = resolveDmPolicy(cfgOf({}));
    expect(policy).toEqual(
      expect.objectContaining({
        policy: "open",
        allowFrom: ["*"],
        policyPath: "plugins.entries.openclaw-unicity.config.dmPolicy",
        allowFromPath: "plugins.entries.openclaw-unicity.config.",
      }),
    );
  });

  it("points at channels.unicity when the keys live there", () => {
    const cfg = cfgOf({ channels: { unicity: { dmPolicy: "allowlist", allowFrom: [PEER_X] } } });
    const policy = resolveDmPolicy(cfg);
    expect(policy.policy).toBe("allowlist");
    expect(policy.allowFrom).toEqual([PEER_X]);
    expect(policy.policyPath).toBe("channels.unicity.dmPolicy");
    expect(policy.allowFromPath).toBe("channels.unicity.");
  });

  it("reports open with concrete entries as an allowlist", () => {
    const policy = resolveDmPolicy(pluginCfg({ dmPolicy: "open", allowFrom: ["@alice"] }));
    expect(policy.policy).toBe("allowlist");
    expect(policy.allowFrom).toEqual(["@alice"]);
  });

  it("gives pairing approval instructions under pairing", () => {
    const policy = resolveDmPolicy(pluginCfg({ dmPolicy: "pairing" }));
    expect(policy.policy).toBe("pairing");
    expect(policy.approveHint).toContain("openclaw pairing approve unicity");
  });

  it("tolerates partial account objects from the security audit", () => {
    const cfg = cfgOf({ channels: { unicity: { dmPolicy: "disabled" } } });
    expect(resolveDmPolicy(cfg, { accountId: "default" }).policy).toBe("disabled");
    expect(() => plugin.security.resolveDmPolicy({ cfg, account: undefined as unknown as ResolvedUnicityAccount })).not.toThrow();
  });

  it("normalizes and classifies entries", () => {
    const policy = resolveDmPolicy(cfgOf({}));
    expect(policy.normalizeEntry?.(PEER_CHAIN)).toBe(PEER_X);
    expect(policy.classifyEntryAuthentication?.(PEER_X)).toBe("verified");
    expect(policy.classifyEntryAuthentication?.("@alice")).toBe("asserted");
  });

  it("routes DMs with the same scope as the inbound pipeline", () => {
    const cfg = cfgOf({ session: { dmScope: "per-peer" } });
    expect(plugin.security.dmRouting.resolveDmScope({ cfg, accountId: "default", account: resolveUnicityAccount(cfg) })).toBe(
      "per-account-channel-peer",
    );
    expect(resolveUnicityDmScope).toHaveBeenCalledWith(cfg);
  });
});

describe("pairing adapter", () => {
  it("stores approvals as x-only keys", () => {
    expect(plugin.pairing.idLabel).toBe("Unicity pubkey");
    expect(plugin.pairing.normalizeAllowEntry(PEER_CHAIN)).toBe(PEER_X);
    expect(plugin.pairing.normalizeAllowEntry(`unicity:${PEER_X.toUpperCase()}`)).toBe(PEER_X);
    expect(plugin.pairing.normalizeAllowEntry("unicity:@Bob")).toBe("@bob");
  });

  it("notifies the approved key when the wallet is open in this process", async () => {
    await plugin.pairing.notifyApproval({ cfg: cfgOf({}), id: PEER_CHAIN });
    expect(sphere.communications.sendDM).toHaveBeenCalledWith(PEER_X, expect.stringContaining("approved"));
  });

  it("fails loudly instead of opening a wallet when none is open", async () => {
    h.sphere = null;
    await expect(plugin.pairing.notifyApproval({ cfg: cfgOf({}), id: PEER_X })).rejects.toThrow(/not open/);
  });
});

describe("outbound.sendText", () => {
  it("is a direct, chunked adapter", () => {
    expect(plugin.outbound.deliveryMode).toBe("direct");
    expect(plugin.outbound.textChunkLimit).toBe(4000);
    expect(typeof plugin.outbound.chunker).toBe("function");
  });

  it("sends DMs and returns the transport event id", async () => {
    const res = await plugin.outbound.sendText(sendCtx({ to: "@Alice" }));
    expect(sphere.communications.sendDM).toHaveBeenCalledWith("@alice", "hello");
    expect(res).toEqual({ channel: "unicity", to: "@alice", messageId: "dm-1" });
  });

  it("sends to hex targets as x-only keys", async () => {
    await plugin.outbound.sendText(sendCtx({ to: PEER_CHAIN }));
    expect(sphere.communications.sendDM).toHaveBeenCalledWith(PEER_X, "hello");
  });

  it("runs the dispatch and handoff hooks before the platform send", async () => {
    const order: string[] = [];
    sphere.communications.sendDM.mockImplementation(async () => {
      order.push("send");
      return { id: "dm-x", recipientPubkey: "", content: "" };
    });
    await plugin.outbound.sendText(
      sendCtx({
        onPlatformSendDispatch: async () => {
          order.push("dispatch");
        },
        assertDirectAdapterHandoff: () => order.push("handoff"),
      }),
    );
    expect(order).toEqual(["dispatch", "handoff", "send"]);
  });

  it("does not send when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(plugin.outbound.sendText(sendCtx({ signal: controller.signal }))).rejects.toThrow();
    expect(sphere.communications.sendDM).not.toHaveBeenCalled();
  });

  it("routes known group ids to the group with reply threading", async () => {
    const res = await plugin.outbound.sendText(sendCtx({ to: GROUP_ID, replyToId: "parent" }));
    expect(sphere.groupChat!.sendMessage).toHaveBeenCalledWith(GROUP_ID, "hello", "parent");
    expect(sphere.communications.sendDM).not.toHaveBeenCalled();
    expect(res).toEqual({ channel: "unicity", to: GROUP_ID, messageId: "gev-1" });
  });

  it("throws instead of inventing an id when the group send returns null", async () => {
    sphere.groupChat!.sendMessage.mockResolvedValueOnce(null as never);
    const err = await plugin.outbound.sendText(sendCtx({ to: GROUP_ID })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBeUndefined();
  });

  it("never DMs a bare name that is not a joined group (the transport would resolve it as a nametag)", async () => {
    for (const groups of [[], null]) {
      sphere.groupChat = groups === null ? null : { ...sphere.groupChat!, getGroups: vi.fn(() => groups) };
      const err = await plugin.outbound.sendText(sendCtx({ to: "general" })).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED", retryable: false });
      expect((err as Error).message).toContain("Use @name");
    }
    expect(sphere.communications.sendDM).not.toHaveBeenCalled();
  });

  it("DMs @nametags, keys and DIRECT addresses, and posts a bare name to the joined group of that id", async () => {
    await plugin.outbound.sendText(sendCtx({ to: "@general" }));
    expect(sphere.communications.sendDM).toHaveBeenLastCalledWith("@general", "hello");
    await plugin.outbound.sendText(sendCtx({ to: "DIRECT://00aabbccddeeff0011" }));
    expect(sphere.communications.sendDM).toHaveBeenLastCalledWith("DIRECT://00aabbccddeeff0011", "hello");
    sphere.groupChat!.getGroups.mockReturnValue([{ id: "general", name: "General", visibility: "PUBLIC" }]);
    await plugin.outbound.sendText(sendCtx({ to: "general" }));
    expect(sphere.groupChat!.sendMessage).toHaveBeenCalledWith("general", "hello", undefined);
    expect(sphere.communications.sendDM).toHaveBeenCalledTimes(2);
  });

  it("reports a permanent not-dispatched error when group chat goes away before the send", async () => {
    const err = await plugin.outbound
      .sendText(
        sendCtx({
          to: GROUP_ID,
          onPlatformSendDispatch: async () => {
            sphere.groupChat = null;
          },
        }),
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED", retryable: false });
  });

  it("never DMs an unknown new-format group id", async () => {
    const err = await plugin.outbound.sendText(sendCtx({ to: "other-0123456789abcdef" })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED", retryable: false });
    expect(sphere.communications.sendDM).not.toHaveBeenCalled();
  });

  it("rejects targets that are not recipients or group ids", async () => {
    await expect(plugin.outbound.sendText(sendCtx({ to: "not a target!" }))).rejects.toMatchObject({
      code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
    });
  });

  it("maps an unresolvable recipient to a not-dispatched error", async () => {
    sphere.communications.sendDM.mockRejectedValueOnce(Object.assign(new Error("Unicity ID not found"), { code: "INVALID_RECIPIENT" }));
    await expect(plugin.outbound.sendText(sendCtx())).rejects.toMatchObject({ code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED", retryable: false });
  });

  it("rethrows other send failures unchanged (the event may have reached a relay)", async () => {
    const failure = new Error("relay timeout");
    sphere.communications.sendDM.mockRejectedValueOnce(failure);
    await expect(plugin.outbound.sendText(sendCtx())).rejects.toBe(failure);
  });

  it("waits for the wallet and reports a retryable not-dispatched error when it never opens", async () => {
    h.sphere = null;
    await expect(plugin.outbound.sendText(sendCtx())).rejects.toMatchObject({ code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED", retryable: true });
    expect(waitForSphere).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
  });
});

describe("messaging adapter", () => {
  it("normalizes targets", () => {
    expect(normalizeUnicityTarget(" @Alice ")).toBe("@alice");
    expect(normalizeUnicityTarget(PEER_CHAIN)).toBe(PEER_X);
    expect(normalizeUnicityTarget(`unicity:${PEER_X}`)).toBe(PEER_X);
    expect(normalizeUnicityTarget(GROUP_ID)).toBe(GROUP_ID);
    expect(normalizeUnicityTarget("  ")).toBeUndefined();
    expect(plugin.messaging.normalizeTarget("@Bob")).toBe("@bob");
  });

  it("recognizes nametags, keys and group ids", () => {
    const looksLikeId = plugin.messaging.targetResolver.looksLikeId;
    expect(looksLikeId("@alice")).toBe(true);
    expect(looksLikeId(PEER_X)).toBe(true);
    expect(looksLikeId(GROUP_ID)).toBe(true);
    expect(looksLikeId("not a target!")).toBe(false);
    expect(plugin.messaging.targetResolver.hint).toBe("<@nametag|pubkey|group id>");
  });
});

describe("status adapter", () => {
  it("keeps the runtime snapshot fields", () => {
    const account = resolveUnicityAccount(cfgOf({}));
    const snapshot = plugin.status.buildAccountSnapshot({
      account,
      cfg: cfgOf({}),
      runtime: { accountId: "default", running: true, connected: true, lifecycle: "ready", lastEventAt: 5 },
    });
    expect(snapshot).toEqual(
      expect.objectContaining({ accountId: "default", running: true, connected: true, lifecycle: "ready", lastEventAt: 5, configured: true, publicKey: AGENT_CHAIN }),
    );
  });

  it("summarizes the channel", () => {
    const account = resolveUnicityAccount(cfgOf({}));
    const summary = plugin.status.buildChannelSummary({ account, cfg: cfgOf({}), defaultAccountId: "default", snapshot: { accountId: "default", running: true } });
    expect(summary).toEqual(expect.objectContaining({ running: true, nametag: "agentbot", publicKey: AGENT_CHAIN }));
  });
});

describe("directory adapter", () => {
  it("lists joined groups", async () => {
    expect(await plugin.directory.listGroups({} as Any)).toEqual([{ kind: "group", id: GROUP_ID, name: "Devs" }]);
  });

  it("lists members by key and never as their claimed nametag", async () => {
    const members = await plugin.directory.listGroupMembers({ groupId: GROUP_ID } as Any);
    expect(members).toEqual([
      { kind: "user", id: PEER_X, name: `${PEER_X.slice(0, 12)}… (claims @owner, unverified)` },
      { kind: "user", id: AGENT_X, name: `${AGENT_X.slice(0, 12)}…` },
    ]);
  });

  it("is empty without a wallet or group chat", async () => {
    sphere.groupChat = null;
    expect(await plugin.directory.listGroups({} as Any)).toEqual([]);
    h.sphere = null;
    expect(await plugin.directory.listGroupMembers({ groupId: GROUP_ID } as Any)).toEqual([]);
  });
});

describe("agentPrompt adapter", () => {
  it("declares plain-text formatting and target syntax", () => {
    const hints = plugin.agentPrompt.inboundFormattingHints({ cfg: cfgOf({}) });
    expect(hints?.text_markup).toBe("plain_text");
    expect(plugin.agentPrompt.messageToolHints({ cfg: cfgOf({}) })[0]).toContain("@nametag");
  });
});

describe("setupWizard", () => {
  it("reports status from config and the wallet file only", async () => {
    h.sphere = null;
    h.walletExists = false;
    const status = await plugin.setupWizard.getStatus({ cfg: pluginCfg({ nametag: "mybot" }), accountOverrides: {} });
    expect(status).toEqual(expect.objectContaining({ channel: "unicity", configured: true }));
    expect(status.statusLines[0]).toBe("Nametag: @mybot");
    expect(status.statusLines[2]).toBe("Payments: disabled (no API key; get one at https://sphere.unicity.network)");
    const keyed = await plugin.setupWizard.getStatus({ cfg: pluginCfg({ nametag: "mybot", apiKey: "sk_secret" }), accountOverrides: {} });
    expect(keyed.statusLines[2]).toBe("Payments: API key set");
    expect(JSON.stringify(keyed)).not.toContain("sk_secret");
    const empty = await plugin.setupWizard.getStatus({ cfg: cfgOf({}), accountOverrides: {} });
    expect(empty.configured).toBe(false);
  });

  it("returns a new config built by applySetupAnswers and leaves ctx.cfg untouched", async () => {
    const cfg = pluginCfg({ nametag: "oldbot" });
    const before = JSON.stringify(cfg);
    const prompter = {} as Any;
    const result = await plugin.setupWizard.configure({ cfg, prompter, accountOverrides: {}, runtime: {} as Any, shouldPromptAccountIds: false, forceAllowFrom: false });
    expect(collectSetupAnswers).toHaveBeenCalledWith(prompter, expect.objectContaining({ nametag: "oldbot" }));
    expect(applySetupAnswers).toHaveBeenCalledWith(cfg, { nametag: "newbot", owner: "alice", network: "testnet2", apiKey: "sk_new" });
    expect(result).toEqual({ cfg: expect.objectContaining({ applied: expect.anything() }), accountId: "default" });
    expect(JSON.stringify(cfg)).toBe(before);
  });
});

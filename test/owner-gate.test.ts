import { describe, it, expect, vi, beforeEach } from "vitest";
import { Type } from "typebox";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";

const OWNER = "a".repeat(64);
const STRANGER = "b".repeat(64);

const ownerAuthority = { isOwnerKey: vi.fn((pk: string | null | undefined) => toXOnly(pk) === OWNER) };
let authority: typeof ownerAuthority | null = ownerAuthority;

function toXOnly(pk: string | null | undefined): string | null {
  const k = (pk ?? "").trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(k)) return k;
  if (/^0[23][0-9a-f]{64}$/.test(k)) return k.slice(2);
  return null;
}

/** The gateway's live config as the runtime reports it (only `channels` matters to the gate). */
let liveConfig: unknown = {};

vi.mock("@unicitylabs/sphere-sdk", () => ({ isValidNametag: () => true }));
vi.mock("../src/config.js", () => ({ CHANNEL_ID: "unicity", PLUGIN_ID: "openclaw-unicity" }));
vi.mock("../src/identity.js", () => ({
  getOwnerAuthority: () => authority,
  toXOnly: (pk: string | null | undefined) => toXOnly(pk),
}));
vi.mock("../src/access.js", () => ({ stripChannelPrefix: (raw: string) => raw.trim().replace(/^unicity:/i, "") }));
vi.mock("../src/runtime.js", () => ({ getUnicityRuntimeOrNull: () => ({ config: { current: () => liveConfig } }) }));

const {
  ALL_TOOL_NAMES,
  OWNER_ONLY_TOOL_NAMES,
  PUBLIC_GROUPS_ONLY_PARAM,
  PUBLIC_TOOL_NAMES,
  SENDER_SCOPED_FLAG_PARAM,
  SENDER_SCOPED_TOOL_NAMES,
  STRANGER_TOOL_ALLOWLIST,
  TOOL_GATE_MATCHER,
  beforeToolCallGate,
  gatedToolFactory,
  groupToolPolicy,
  isOwnerRequester,
  nonOwnerToolPolicy,
} = await import("../src/owner-gate.js");

const GROUP_ID = "trading-floor-0123456789abcdef";
/** Session key core builds for a Unicity group turn (session.groupScope "per-group"). */
const GROUP_SESSION = `agent:main:unicity:group:${GROUP_ID}`;
const DM_SESSION = `agent:main:unicity:default:direct:${OWNER}`;
/** The key every group turn would share if a group were routed into the agent's main session (groupScope "main"). */
const MAIN_SESSION = "agent:main:main";

function makeTool(name: string, parameters = Type.Object({ recipient: Type.String(), amount: Type.String() })) {
  const execute = vi.fn(async (_id: string, params: unknown) => ({
    content: [{ type: "text" as const, text: "ok" }],
    details: { params },
  }));
  const tool: AnyAgentTool = { name, label: name, description: "Request a payment.", parameters, execute };
  return { tool, execute };
}

const ctx = (c: Partial<OpenClawPluginToolContext>): OpenClawPluginToolContext => c;

describe("tool name lists", () => {
  it("cover 15 distinct tools, each in exactly one class: 13 owner-only, 1 sender-scoped, list_groups public", () => {
    expect(new Set(ALL_TOOL_NAMES).size).toBe(15);
    expect(OWNER_ONLY_TOOL_NAMES).toHaveLength(13);
    expect(SENDER_SCOPED_TOOL_NAMES).toEqual(["unicity_request_payment"]);
    expect(PUBLIC_TOOL_NAMES).toEqual(["unicity_list_groups"]);
    expect([...ALL_TOOL_NAMES].sort()).toEqual([...OWNER_ONLY_TOOL_NAMES, ...SENDER_SCOPED_TOOL_NAMES, ...PUBLIC_TOOL_NAMES].sort());
    expect(OWNER_ONLY_TOOL_NAMES).toContain("unicity_respond_payment_request");
  });

  it("lets non-owner turns use only request_payment and list_groups, plus the operator's additions", () => {
    expect(STRANGER_TOOL_ALLOWLIST).toEqual(["unicity_request_payment", "unicity_list_groups"]);
    expect(nonOwnerToolPolicy()).toEqual({
      allow: ["unicity_request_payment", "unicity_list_groups"],
      deny: [...OWNER_ONLY_TOOL_NAMES],
    });
    expect(nonOwnerToolPolicy(["web_search", "unicity_list_groups"])).toEqual({
      allow: ["unicity_request_payment", "unicity_list_groups", "web_search"],
      deny: [...OWNER_ONLY_TOOL_NAMES],
    });
  });

  it("also denies every owner-only tool by name (deny wins in core), and nothing the allowlist offers", () => {
    const { allow, deny } = nonOwnerToolPolicy(["web_search"]);
    expect([...deny].sort()).toEqual([...OWNER_ONLY_TOOL_NAMES].sort());
    expect(deny.filter((tool) => allow.includes(tool))).toEqual([]);
    // A copy: the policy goes to core, which must not be able to change the constant through it.
    expect(deny).not.toBe(OWNER_ONLY_TOOL_NAMES);
  });

  it("never lets the operator's additions select an owner-only tool (the owner's transfer and group turns get this policy)", () => {
    const selectors = [
      "*", "unicity_*", "unicity_list_*", "*_send_tokens", "UNICITY_SEND_TOKENS", " unicity_top_up ", "group:plugins",
      "openclaw-unicity", "openclaw-*",
    ];
    expect(nonOwnerToolPolicy(selectors).allow).toEqual(["unicity_request_payment", "unicity_list_groups"]);
    expect(nonOwnerToolPolicy(["web_*", "group:web", "unicity_list_groups", "unicity_request_payment"]).allow).toEqual([
      "unicity_request_payment", "unicity_list_groups", "web_*", "group:web",
    ]);
  });

  it("group turns get only the public tools: no sender-scoped request_payment, whatever the operator adds", () => {
    expect(groupToolPolicy()).toEqual({
      allow: ["unicity_list_groups"],
      deny: [...OWNER_ONLY_TOOL_NAMES, "unicity_request_payment"],
    });
    expect(groupToolPolicy(["web_search", "unicity_request_payment", "unicity_request_*", "*_payment", "unicity_list_groups"])).toEqual({
      allow: ["unicity_list_groups", "web_search"],
      deny: [...OWNER_ONLY_TOOL_NAMES, "unicity_request_payment"],
    });
    expect(groupToolPolicy(["*", "unicity_*", "group:plugins", "openclaw-unicity", " UNICITY_SEND_TOKENS "]).allow).toEqual([
      "unicity_list_groups",
    ]);
    // The DM policy keeps request_payment for strangers.
    expect(nonOwnerToolPolicy(["unicity_request_*"]).allow).toEqual(["unicity_request_payment", "unicity_list_groups", "unicity_request_*"]);
  });

  it("the before_tool_call matcher covers the gated wallet tools and core's message tool", () => {
    expect([...TOOL_GATE_MATCHER].sort()).toEqual([...OWNER_ONLY_TOOL_NAMES, ...SENDER_SCOPED_TOOL_NAMES, "message"].sort());
  });
});

describe("isOwnerRequester", () => {
  beforeEach(() => {
    authority = ownerAuthority;
  });

  it("allows a host-authenticated owner on any channel", () => {
    expect(isOwnerRequester({ channel: "telegram", senderId: "12345", senderIsOwner: true })).toBe(true);
  });

  it("allows the owner's unicity key (x-only or 66-hex chain key)", () => {
    expect(isOwnerRequester({ channel: "unicity", senderId: OWNER })).toBe(true);
    expect(isOwnerRequester({ channel: "Unicity", senderId: `02${OWNER}` })).toBe(true);
  });

  it("denies strangers, the owner key on other channels, and an unset owner authority", () => {
    expect(isOwnerRequester({ channel: "unicity", senderId: STRANGER })).toBe(false);
    expect(isOwnerRequester({ channel: "telegram", senderId: OWNER })).toBe(false);
    expect(isOwnerRequester({})).toBe(false);
    authority = null;
    expect(isOwnerRequester({ channel: "unicity", senderId: OWNER })).toBe(false);
  });

  it("on the unicity channel ignores the host's senderIsOwner (e.g. a pairing-bootstrapped command owner)", () => {
    expect(isOwnerRequester({ channel: "unicity", senderId: STRANGER, senderIsOwner: true })).toBe(false);
    expect(isOwnerRequester({ channel: "unicity", senderIsOwner: true })).toBe(false);
    expect(isOwnerRequester({ channel: "unicity", senderId: OWNER, senderIsOwner: false })).toBe(true);
  });

  it("is never true in a Unicity group session, not even for the owner's (relay-asserted) key", () => {
    expect(isOwnerRequester({ channel: "unicity", senderId: OWNER, sessionKey: GROUP_SESSION })).toBe(false);
    expect(isOwnerRequester({ channel: "telegram", senderIsOwner: true, sessionKey: GROUP_SESSION })).toBe(false);
    expect(isOwnerRequester({ channel: "unicity", senderId: OWNER, sessionKey: DM_SESSION })).toBe(true);
    expect(isOwnerRequester({ channel: "telegram", senderIsOwner: true, sessionKey: "agent:main:telegram:group:42" })).toBe(true);
  });

  it("is never true when the run delivers to a Unicity group, even in a session without a group marker", () => {
    expect(isOwnerRequester({ channel: "unicity", senderId: OWNER, sessionKey: MAIN_SESSION, unicityTarget: GROUP_ID })).toBe(false);
    expect(isOwnerRequester({ channel: "unicity", senderId: OWNER, sessionKey: MAIN_SESSION, unicityTarget: `unicity:group:${GROUP_ID}` })).toBe(false);
    expect(isOwnerRequester({ channel: "unicity", senderId: OWNER, unicityTarget: "shortGroup1" })).toBe(false);
    expect(isOwnerRequester({ channel: "unicity", senderId: OWNER, sessionKey: MAIN_SESSION, unicityTarget: OWNER })).toBe(true);
    expect(isOwnerRequester({ channel: "unicity", senderId: OWNER, unicityTarget: `unicity:02${OWNER}` })).toBe(true);
  });
});

describe("gatedToolFactory", () => {
  beforeEach(() => {
    authority = ownerAuthority;
  });

  it("offers owner-only tools to the owner via senderIsOwner", async () => {
    const { tool, execute } = makeTool("unicity_send_tokens");
    const assertInvocationCurrent = vi.fn();
    const gated = gatedToolFactory(tool)(ctx({ messageChannel: "telegram", requesterSenderId: "1", senderIsOwner: true, assertInvocationCurrent }));
    expect(gated?.name).toBe("unicity_send_tokens");
    await gated!.execute("c1", { recipient: "@bob", amount: "1" });
    expect(assertInvocationCurrent).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("c1", { recipient: "@bob", amount: "1" }, undefined, undefined);
  });

  it("offers owner-only tools to the owner's unicity key", () => {
    const { tool } = makeTool("unicity_get_balance");
    expect(gatedToolFactory(tool)(ctx({ messageChannel: "unicity", requesterSenderId: OWNER }))).not.toBeNull();
  });

  it("hides owner-only tools from strangers and from runs without a requester", () => {
    const { tool } = makeTool("unicity_send_tokens");
    const factory = gatedToolFactory(tool);
    expect(factory(ctx({ messageChannel: "unicity", requesterSenderId: STRANGER, senderIsOwner: false }))).toBeNull();
    expect(factory(ctx({}))).toBeNull();
  });

  it("in a group session hides owner-only tools and request_payment (the sender key is only the relay's word)", async () => {
    for (const key of [OWNER, STRANGER]) {
      const member = ctx({ messageChannel: "unicity", requesterSenderId: key, sessionKey: GROUP_SESSION });
      expect(gatedToolFactory(makeTool("unicity_send_tokens").tool)(member)).toBeNull();
      expect(gatedToolFactory(makeTool("unicity_request_payment").tool)(member)).toBeNull();
      const { tool, execute } = makeTool("unicity_list_groups", Type.Object({}));
      await gatedToolFactory(tool)(member)!.execute("g", { scope: "joined" });
      expect(execute).toHaveBeenCalledWith("g", { scope: "joined", [PUBLIC_GROUPS_ONLY_PARAM]: true }, undefined, undefined);
    }
  });

  it("treats a run delivering to a Unicity group as a group run even when its session key has no group marker", async () => {
    const groupRun = ctx({
      messageChannel: "unicity",
      requesterSenderId: OWNER,
      sessionKey: MAIN_SESSION,
      deliveryContext: { channel: "unicity", to: GROUP_ID },
    });
    expect(gatedToolFactory(makeTool("unicity_send_tokens").tool)(groupRun)).toBeNull();
    expect(gatedToolFactory(makeTool("unicity_request_payment").tool)(groupRun)).toBeNull();
    const { tool, execute } = makeTool("unicity_list_groups", Type.Object({}));
    await gatedToolFactory(tool)(groupRun)!.execute("g", {});
    expect(execute).toHaveBeenCalledWith("g", { [PUBLIC_GROUPS_ONLY_PARAM]: true }, undefined, undefined);

    const ownerDm = ctx({ messageChannel: "unicity", requesterSenderId: OWNER, deliveryContext: { channel: "unicity", to: OWNER } });
    expect(gatedToolFactory(makeTool("unicity_send_tokens").tool)(ownerDm)).not.toBeNull();
    // Only a Unicity delivery target counts.
    const telegramOwner = ctx({ messageChannel: "telegram", senderIsOwner: true, deliveryContext: { channel: "telegram", to: "group1" } });
    expect(gatedToolFactory(makeTool("unicity_send_tokens").tool)(telegramOwner)).not.toBeNull();
  });

  it("hides owner-only tools from a unicity stranger the host marks as owner", () => {
    const { tool } = makeTool("unicity_send_tokens");
    expect(gatedToolFactory(tool)(ctx({ messageChannel: "unicity", requesterSenderId: STRANGER, senderIsOwner: true }))).toBeNull();
  });

  it("treats a tool in no class as owner-only", () => {
    const { tool } = makeTool("unicity_unclassified", Type.Object({}));
    expect(gatedToolFactory(tool)(ctx({ messageChannel: "unicity", requesterSenderId: STRANGER }))).toBeNull();
    expect(gatedToolFactory(tool)(ctx({}))).toBeNull();
    expect(gatedToolFactory(tool)(ctx({ messageChannel: "unicity", requesterSenderId: OWNER }))?.name).toBe("unicity_unclassified");
  });

  it("keeps public tools available to everyone", () => {
    const { tool } = makeTool("unicity_list_groups", Type.Object({}));
    expect(gatedToolFactory(tool)(ctx({ messageChannel: "unicity", requesterSenderId: STRANGER }))).not.toBeNull();
    expect(gatedToolFactory(tool)(ctx({}))).not.toBeNull();
  });

  it("limits non-owners to public groups in unicity_list_groups, whatever the model passes", async () => {
    const { tool, execute } = makeTool("unicity_list_groups", Type.Object({}));
    const stranger = gatedToolFactory(tool)(ctx({ messageChannel: "unicity", requesterSenderId: STRANGER }));
    expect(stranger!.parameters).toBe(tool.parameters);
    await stranger!.execute("g1", { scope: "joined", [PUBLIC_GROUPS_ONLY_PARAM]: false });
    expect(execute).toHaveBeenLastCalledWith("g1", { scope: "joined", [PUBLIC_GROUPS_ONLY_PARAM]: true }, undefined, undefined);

    const owner = gatedToolFactory(tool)(ctx({ messageChannel: "unicity", requesterSenderId: OWNER }));
    await owner!.execute("g2", { scope: "joined" });
    expect(execute).toHaveBeenLastCalledWith("g2", { scope: "joined" }, undefined, undefined);
  });

  it("forces the sender-scoped recipient to the stranger's own key and drops it from the schema", async () => {
    const { tool, execute } = makeTool("unicity_request_payment");
    const gated = gatedToolFactory(tool)(ctx({ messageChannel: "unicity", requesterSenderId: `03${STRANGER.toUpperCase()}` }));
    expect(gated).not.toBeNull();
    const schema = gated!.parameters as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(["amount"]);
    expect(Object.keys(schema.properties)).toEqual(["amount"]);
    // Same own keys as the original, including TypeBox's non-enumerable kind marker.
    expect(Reflect.ownKeys(gated!.parameters)).toEqual(Reflect.ownKeys(tool.parameters));
    expect((tool.parameters as { required?: string[] }).required).toEqual(["recipient", "amount"]);
    expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual(["recipient", "amount"]);
    expect(gated!.description).toContain("current sender");
    await gated!.execute("c2", { recipient: "@victim", amount: "5" });
    expect(execute).toHaveBeenCalledWith("c2", { recipient: STRANGER, amount: "5", [SENDER_SCOPED_FLAG_PARAM]: true }, undefined, undefined);
  });

  it("flags a stranger's request as sender-scoped, whatever the model passes", async () => {
    const { tool, execute } = makeTool("unicity_request_payment");
    const gated = gatedToolFactory(tool)(ctx({ messageChannel: "unicity", requesterSenderId: STRANGER }));
    expect(Object.keys((gated!.parameters as { properties: object }).properties)).not.toContain(SENDER_SCOPED_FLAG_PARAM);
    await gated!.execute("c5", { amount: "5", [SENDER_SCOPED_FLAG_PARAM]: false });
    expect(execute).toHaveBeenCalledWith("c5", { recipient: STRANGER, amount: "5", [SENDER_SCOPED_FLAG_PARAM]: true }, undefined, undefined);
  });

  it("keeps the sender-scoped tool's schema for the owner and flags the call as the owner's, whatever the model passes", async () => {
    const { tool, execute } = makeTool("unicity_request_payment");
    const gated = gatedToolFactory(tool)(ctx({ messageChannel: "unicity", requesterSenderId: OWNER }));
    expect(gated!.parameters).toBe(tool.parameters);
    await gated!.execute("c3", { recipient: "@bob", amount: "5" });
    expect(execute).toHaveBeenLastCalledWith("c3", { recipient: "@bob", amount: "5", [SENDER_SCOPED_FLAG_PARAM]: false }, undefined, undefined);
    await gated!.execute("c6", { recipient: "@bob", amount: "5", [SENDER_SCOPED_FLAG_PARAM]: true });
    expect(execute).toHaveBeenLastCalledWith("c6", { recipient: "@bob", amount: "5", [SENDER_SCOPED_FLAG_PARAM]: false }, undefined, undefined);
    const telegramOwner = gatedToolFactory(tool)(ctx({ messageChannel: "telegram", requesterSenderId: "1", senderIsOwner: true }));
    await telegramOwner!.execute("c7", { recipient: "@bob", amount: "5", [SENDER_SCOPED_FLAG_PARAM]: true });
    expect(execute).toHaveBeenLastCalledWith("c7", { recipient: "@bob", amount: "5", [SENDER_SCOPED_FLAG_PARAM]: false }, undefined, undefined);
  });

  it("hides the sender-scoped tool from non-owners without a unicity key", () => {
    const { tool } = makeTool("unicity_request_payment");
    const factory = gatedToolFactory(tool);
    expect(factory(ctx({ messageChannel: "telegram", requesterSenderId: "12345" }))).toBeNull();
    expect(factory(ctx({ messageChannel: "unicity" }))).toBeNull();
  });

  it("throws (the host then skips the tool) when the owner check throws", () => {
    ownerAuthority.isOwnerKey.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const { tool } = makeTool("unicity_send_tokens");
    expect(() => gatedToolFactory(tool)(ctx({ messageChannel: "unicity", requesterSenderId: OWNER }))).toThrow("boom");
  });

  it("does not run the tool when the invocation is no longer current", async () => {
    const { tool, execute } = makeTool("unicity_send_tokens");
    const gated = gatedToolFactory(tool)(ctx({
      senderIsOwner: true,
      assertInvocationCurrent: () => {
        throw new Error("Plugin tool runtime is no longer active.");
      },
    }));
    await expect(gated!.execute("c4", {})).rejects.toThrow("no longer active");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("beforeToolCallGate", () => {
  beforeEach(() => {
    authority = ownerAuthority;
  });

  const call = (toolName: string, requester?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    beforeToolCallGate({ toolName, params: {} }, requester === undefined ? { toolName, ...extra } : { toolName, requester, ...extra });

  it("allows the owner via senderIsOwner and via the unicity owner key", () => {
    expect(call("unicity_send_tokens", { channel: "telegram", senderId: "1", senderIsOwner: true })).toBeUndefined();
    expect(call("unicity_respond_payment_request", { channel: "unicity", senderId: OWNER })).toBeUndefined();
  });

  it("blocks the owner's key in a Unicity group session", () => {
    expect(call("unicity_send_tokens", { channel: "unicity", senderId: OWNER }, { sessionKey: GROUP_SESSION })).toMatchObject({ block: true });
    expect(call("unicity_send_tokens", { channel: "unicity", senderId: OWNER }, { sessionKey: DM_SESSION })).toBeUndefined();
  });

  it("blocks a unicity stranger even when the host marks them as owner", () => {
    expect(call("unicity_send_tokens", { channel: "unicity", senderId: STRANGER, senderIsOwner: true })).toMatchObject({ block: true });
  });

  it("blocks strangers from owner-only tools", () => {
    expect(call("unicity_send_tokens", { channel: "unicity", senderId: STRANGER })).toEqual({
      block: true,
      blockReason: expect.stringContaining("restricted to the wallet owner"),
    });
    expect(call("unicity_respond_payment_request", { channel: "unicity", senderId: STRANGER, senderIsOwner: false })).toMatchObject({ block: true });
  });

  it("fails closed when the requester is missing or malformed", () => {
    expect(call("unicity_send_tokens")).toMatchObject({ block: true });
    expect(beforeToolCallGate({ toolName: "unicity_send_tokens" }, null)).toMatchObject({ block: true });
    expect(call("unicity_send_tokens", { channel: "unicity", senderId: OWNER, senderIsOwner: "true" })).toBeUndefined();
    expect(call("unicity_send_tokens", { channel: "unicity", senderId: 42, senderIsOwner: "true" })).toMatchObject({ block: true });
  });

  it("fails closed when the owner check throws", () => {
    ownerAuthority.isOwnerKey.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(call("unicity_send_tokens", { channel: "unicity", senderId: OWNER })).toMatchObject({ block: true });
  });

  it("lets a unicity stranger request payment (recipient is forced by the factory) but not other channels", () => {
    expect(call("unicity_request_payment", { channel: "unicity", senderId: STRANGER })).toBeUndefined();
    expect(call("unicity_request_payment", { channel: "telegram", senderId: "12345" })).toMatchObject({ block: true });
    expect(call("unicity_request_payment")).toMatchObject({ block: true });
  });

  it("blocks request_payment in a Unicity group session for every sender key", () => {
    expect(call("unicity_request_payment", { channel: "unicity", senderId: STRANGER }, { sessionKey: GROUP_SESSION })).toMatchObject({ block: true });
    expect(call("unicity_request_payment", { channel: "unicity", senderId: OWNER }, { sessionKey: GROUP_SESSION })).toMatchObject({ block: true });
  });

  it("ignores tools it does not gate", () => {
    expect(call("unicity_list_groups")).toBeUndefined();
    expect(call("exec")).toBeUndefined();
  });
});

describe("beforeToolCallGate: core message tool", () => {
  beforeEach(() => {
    authority = ownerAuthority;
    liveConfig = {};
  });

  const message = (params: Record<string, unknown>, requester?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    beforeToolCallGate({ toolName: "message", params }, { toolName: "message", ...(requester ? { requester } : {}), ...extra });
  const stranger = { channel: "unicity", senderId: STRANGER };

  it("blocks a unicity stranger from sending through Unicity to anyone else", () => {
    expect(message({ action: "send", target: "@alice", message: "hi" }, stranger)).toMatchObject({
      block: true,
      blockReason: expect.stringContaining("restricted to the wallet owner"),
    });
    expect(message({ action: "send", channel: "unicity", to: `unicity:${OWNER}`, message: "hi" }, stranger)).toMatchObject({ block: true });
    expect(message({ action: "send", channel: "unicity", target: "trading-floor-0123456789abcdef" }, stranger)).toMatchObject({ block: true });
    // Legacy destination field: core moves it into `target`.
    expect(message({ action: "send", channel: "unicity", channelId: "@alice", message: "hi" }, stranger)).toMatchObject({ block: true });
    expect(message({ action: "broadcast", targets: [STRANGER, "@alice"] }, stranger)).toMatchObject({ block: true });
  });

  it("lets a unicity stranger message only themselves or their own conversation", () => {
    expect(message({ action: "send", message: "hi" }, stranger)).toBeUndefined();
    expect(message({ action: "send", channel: "unicity", target: `unicity:02${STRANGER}` }, stranger)).toBeUndefined();
  });

  it("blocks Unicity sends from non-owners on other channels and from runs without a requester", () => {
    const telegram = { channel: "telegram", senderId: "12345", senderIsOwner: false };
    expect(message({ action: "send", channel: "unicity", target: "@alice" }, telegram)).toMatchObject({ block: true });
    expect(message({ action: "broadcast", targets: ["@alice"] }, telegram)).toMatchObject({ block: true });
    expect(message({ action: "broadcast", channel: "all", targets: ["@alice"] }, telegram)).toMatchObject({ block: true });
    expect(message({ action: "send", channel: "unicity", target: "@alice" })).toMatchObject({ block: true });
    expect(message({ action: "send", target: "@alice" })).toMatchObject({ block: true });
  });

  it("blocks the owner's key in a Unicity group session from messaging others", () => {
    const owner = { channel: "unicity", senderId: OWNER };
    expect(message({ action: "send", target: "@alice" }, owner, { sessionKey: GROUP_SESSION })).toMatchObject({ block: true });
    expect(message({ action: "send", target: "@alice" }, owner, { sessionKey: DM_SESSION })).toBeUndefined();
  });

  it("blocks every Unicity send from a group session, including to the relay-asserted sender key", () => {
    const member = { channel: "unicity", senderId: STRANGER };
    expect(message({ action: "send", target: STRANGER }, member, { sessionKey: GROUP_SESSION })).toMatchObject({ block: true });
    expect(message({ action: "send", message: "hi" }, member, { sessionKey: GROUP_SESSION })).toMatchObject({ block: true });
  });

  it("treats a channel core cannot resolve as Unicity for a Unicity stranger (core falls back to the run's channel)", () => {
    for (const channel of ["x", "all", "Unicity​", "webchat", "defaults", "__proto__", "telegram"]) {
      expect(message({ action: "send", channel, target: "@alice", message: "hi" }, stranger)).toMatchObject({ block: true });
    }
    expect(message({ action: "broadcast", channel: "x", targets: ["@alice", "@bob"] }, stranger)).toMatchObject({ block: true });
    // Back to the stranger themselves stays allowed whatever the channel says.
    expect(message({ action: "send", channel: "x", target: STRANGER }, stranger)).toBeUndefined();
    expect(message({ action: "send", channel: "all", message: "hi" }, stranger)).toBeUndefined();
  });

  it("counts an explicit channel only when it is enabled under `channels`", () => {
    liveConfig = {
      channels: { defaults: {}, modelByChannel: {}, webchat: {}, all: {}, telegram: { botToken: "t" }, discord: { enabled: false } },
    };
    expect(message({ action: "send", channel: "telegram", target: "67890" }, stranger)).toBeUndefined();
    expect(message({ action: "send", channel: " Telegram ", target: "67890" }, stranger)).toBeUndefined();
    expect(message({ action: "broadcast", channel: "telegram", targets: ["67890"] }, stranger)).toBeUndefined();
    for (const channel of ["discord", "defaults", "modelbychannel", "webchat", "all", "__proto__", "constructor", "x"]) {
      expect(message({ action: "send", channel, target: "@alice" }, stranger)).toMatchObject({ block: true });
    }
  });

  it("blocks internal runs in a Unicity session (Control UI, sessions_send) unless the requester is the owner", () => {
    const internal = { channel: "webchat", senderIsOwner: false };
    for (const sessionKey of [GROUP_SESSION, `agent:main:unicity:direct:${STRANGER}`]) {
      expect(message({ action: "send", target: "@alice", message: "hi" }, internal, { sessionKey })).toMatchObject({ block: true });
      expect(message({ action: "send", message: "hi" }, internal, { sessionKey })).toMatchObject({ block: true });
    }
    expect(message({ action: "send", target: "@alice" }, { channel: "webchat", senderIsOwner: true }, { sessionKey: DM_SESSION })).toBeUndefined();
    // Any non-owner run in a Unicity session is held to the Unicity rules.
    const telegram = { channel: "telegram", senderId: "12345" };
    expect(message({ action: "send", target: "@alice" }, telegram, { sessionKey: `agent:main:unicity:direct:${STRANGER}` })).toMatchObject({ block: true });
  });

  it("blocks channel-less and internal non-owner runs (core may fall back to Unicity as the only configured channel)", () => {
    liveConfig = { channels: { unicity: { dmPolicy: "open" } } };
    expect(message({ action: "send", target: "@alice" }, { channel: "webchat", senderIsOwner: false })).toMatchObject({ block: true });
    expect(message({ action: "send", target: "@alice" }, { channel: "cron" })).toMatchObject({ block: true });
    expect(message({ action: "send", target: "@alice" }, { senderId: "1" })).toMatchObject({ block: true });
  });

  it("leaves owners and other channels' traffic alone", () => {
    liveConfig = { channels: { telegram: { enabled: true } } };
    const telegramOwner = { channel: "telegram", senderId: "1", senderIsOwner: true };
    expect(message({ action: "send", channel: "unicity", target: "@alice" }, telegramOwner)).toBeUndefined();
    expect(message({ action: "send", target: "@alice" }, { channel: "unicity", senderId: OWNER })).toBeUndefined();
    const telegramStranger = { channel: "telegram", senderId: "12345" };
    expect(message({ action: "send", target: "67890" }, telegramStranger)).toBeUndefined();
    // Core falls back to the run's own channel (telegram) for a channel it cannot resolve.
    expect(message({ action: "send", channel: "x", target: "67890" }, telegramStranger)).toBeUndefined();
    expect(message({ action: "send", channel: "telegram", target: "67890" }, stranger)).toBeUndefined();
    expect(message({ action: "broadcast", channel: "telegram", targets: ["67890"] }, stranger)).toBeUndefined();
  });

  it("fails closed when the owner check throws", () => {
    ownerAuthority.isOwnerKey.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(message({ action: "send", target: "@alice" }, { channel: "unicity", senderId: OWNER })).toMatchObject({ block: true });
  });
});

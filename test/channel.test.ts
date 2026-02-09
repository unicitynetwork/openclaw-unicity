import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  unicityChannelPlugin,
  listUnicityAccountIds,
  resolveUnicityAccount,
  setUnicityRuntime,
  setActiveSphere,
  setOwnerIdentity,
  type ResolvedUnicityAccount,
} from "../src/channel.js";
import { cancelSphereWait, destroySphere } from "../src/sphere.js";

describe("unicityChannelPlugin shape", () => {
  it("has correct id", () => {
    expect(unicityChannelPlugin.id).toBe("unicity");
  });

  it("has full meta", () => {
    expect(unicityChannelPlugin.meta.id).toBe("unicity");
    expect(unicityChannelPlugin.meta.label).toBe("Unicity");
    expect(unicityChannelPlugin.meta.selectionLabel).toBeTruthy();
    expect(unicityChannelPlugin.meta.docsPath).toBeTruthy();
    expect(unicityChannelPlugin.meta.blurb).toBeTruthy();
  });

  it("supports direct chat type", () => {
    expect(unicityChannelPlugin.capabilities.chatTypes).toContain("direct");
  });

  it("has config adapter with required methods", () => {
    expect(typeof unicityChannelPlugin.config.listAccountIds).toBe("function");
    expect(typeof unicityChannelPlugin.config.resolveAccount).toBe("function");
    expect(typeof unicityChannelPlugin.config.isConfigured).toBe("function");
    expect(typeof unicityChannelPlugin.config.describeAccount).toBe("function");
  });

  it("has outbound adapter with sendText", () => {
    expect(unicityChannelPlugin.outbound.deliveryMode).toBe("direct");
    expect(typeof unicityChannelPlugin.outbound.sendText).toBe("function");
  });

  it("has gateway adapter with startAccount", () => {
    expect(typeof unicityChannelPlugin.gateway.startAccount).toBe("function");
  });

  it("has status adapter", () => {
    expect(unicityChannelPlugin.status.defaultRuntime.accountId).toBe("default");
    expect(typeof unicityChannelPlugin.status.buildChannelSummary).toBe("function");
    expect(typeof unicityChannelPlugin.status.buildAccountSnapshot).toBe("function");
  });

  it("has messaging adapter", () => {
    expect(typeof unicityChannelPlugin.messaging.normalizeTarget).toBe("function");
    expect(unicityChannelPlugin.messaging.normalizeTarget("@alice")).toBe("alice");
    expect(unicityChannelPlugin.messaging.normalizeTarget("bob")).toBe("bob");
  });

  it("has security adapter defaulting to open policy", () => {
    const policy = unicityChannelPlugin.security.resolveDmPolicy({
      account: { config: {} } as ResolvedUnicityAccount,
    });
    expect(policy.policy).toBe("open");
    expect(policy.allowFromPath).toBe("channels.unicity.allowFrom");
  });

  it("resolves allowlist policy with allowFrom list", () => {
    const policy = unicityChannelPlugin.security.resolveDmPolicy({
      account: {
        config: { dmPolicy: "allowlist", allowFrom: ["@alice", "deadbeef"] },
      } as ResolvedUnicityAccount,
    });
    expect(policy.policy).toBe("allowlist");
    expect(policy.allowFrom).toEqual(["@alice", "deadbeef"]);
  });

  it("resolves disabled policy", () => {
    const policy = unicityChannelPlugin.security.resolveDmPolicy({
      account: {
        config: { dmPolicy: "disabled" },
      } as ResolvedUnicityAccount,
    });
    expect(policy.policy).toBe("disabled");
  });

  it("resolves pairing policy", () => {
    const policy = unicityChannelPlugin.security.resolveDmPolicy({
      account: {
        config: { dmPolicy: "pairing" },
      } as ResolvedUnicityAccount,
    });
    expect(policy.policy).toBe("pairing");
  });
});

describe("config helpers", () => {
  it("listUnicityAccountIds always returns default", () => {
    expect(listUnicityAccountIds({})).toEqual(["default"]);
  });

  it("resolveUnicityAccount without sphere is not configured", () => {
    const account = resolveUnicityAccount({ cfg: {}, sphere: null });
    expect(account.accountId).toBe("default");
    expect(account.configured).toBe(false);
    expect(account.publicKey).toBe("");
    expect(account.enabled).toBe(true);
  });

  it("resolveUnicityAccount reads channel config", () => {
    const cfg = {
      channels: { unicity: { name: "my-bot", dmPolicy: "allowlist", enabled: false } },
    };
    const account = resolveUnicityAccount({ cfg, sphere: null });
    expect(account.name).toBe("my-bot");
    expect(account.enabled).toBe(false);
    expect(account.config.dmPolicy).toBe("allowlist");
  });

  it("resolveUnicityAccount with sphere is configured", () => {
    const fakeSphere = {
      identity: { chainPubkey: "abc123", nametag: "@bot", l1Address: "alpha1bot" },
    } as any;
    const account = resolveUnicityAccount({ cfg: {}, sphere: fakeSphere });
    expect(account.configured).toBe(true);
    expect(account.publicKey).toBe("abc123");
    expect(account.nametag).toBe("@bot");
  });
});

describe("outbound.sendText", () => {
  it("throws when sphere is not set", async () => {
    setActiveSphere(null);
    cancelSphereWait();
    await expect(
      unicityChannelPlugin.outbound.sendText({ cfg: {}, to: "@alice", text: "hi" }),
    ).rejects.toThrow("Sphere not initialized");
    await destroySphere(); // reset deferred for next test
  });

  it("sends DM via sphere and returns channel/to", async () => {
    const mockSendDM = vi.fn().mockResolvedValue({ id: "dm-1" });
    setActiveSphere({
      identity: { chainPubkey: "pk", nametag: "@bot" },
      communications: { sendDM: mockSendDM },
    } as any);

    const result = await unicityChannelPlugin.outbound.sendText({
      cfg: {},
      to: "@alice",
      text: "hello",
    });

    expect(mockSendDM).toHaveBeenCalledWith("@alice", "hello");
    expect(result).toEqual({ channel: "unicity", to: "@alice" });

    setActiveSphere(null);
  });
});

describe("gateway.startAccount", () => {
  let dmHandler: ((msg: any) => void) | null = null;
  let mockSphere: any;
  let mockRuntime: any;
  let mockCtx: any;

  beforeEach(() => {
    dmHandler = null;

    mockSphere = {
      identity: { chainPubkey: "abc123def456", nametag: "@test-agent", l1Address: "alpha1test" },
      communications: {
        onDirectMessage: vi.fn((handler: any) => {
          dmHandler = handler;
          return vi.fn();
        }),
        sendDM: vi.fn().mockResolvedValue({ id: "dm-1" }),
      },
      on: vi.fn().mockReturnValue(vi.fn()),
    };

    mockRuntime = {
      channel: {
        reply: {
          finalizeInboundContext: vi.fn((ctx: any) => ctx),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockResolvedValue({}),
        },
      },
    };

    mockCtx = {
      cfg: {},
      accountId: "default",
      account: { accountId: "default", configured: true, publicKey: "abc123" },
      runtime: {},
      abortSignal: new AbortController().signal,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      setStatus: vi.fn(),
    };

    setActiveSphere(mockSphere);
    setUnicityRuntime(mockRuntime as any);
    setOwnerIdentity(undefined);
  });

  it("subscribes to DMs and returns stop handle", async () => {
    const handle = await unicityChannelPlugin.gateway.startAccount(mockCtx);

    expect(mockSphere.communications.onDirectMessage).toHaveBeenCalledOnce();
    expect(typeof handle.stop).toBe("function");
    expect(mockCtx.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ running: true }),
    );
  });

  it("builds correct inbound context from DM", async () => {
    await unicityChannelPlugin.gateway.startAccount(mockCtx);

    dmHandler!({
      id: "msg-1",
      senderPubkey: "deadbeef",
      senderNametag: "alice",
      content: "Hello agent!",
      timestamp: Date.now(),
      isRead: false,
    });

    const ctx = mockRuntime.channel.reply.finalizeInboundContext.mock.calls[0][0];
    expect(ctx.Body).toBe("[from: @alice (contact)]\nHello agent!");
    expect(ctx.From).toBe("@alice");
    expect(ctx.SessionKey).toBe("unicity:dm:@alice");
    expect(ctx.ChatType).toBe("direct");
    expect(ctx.Surface).toBe("unicity");
    expect(ctx.OriginatingChannel).toBe("unicity");
    expect(ctx.OriginatingTo).toBe("@alice");
    expect(ctx.SenderId).toBe("deadbeef");
  });

  it("sets OriginatingTo to raw pubkey when sender has no nametag", async () => {
    await unicityChannelPlugin.gateway.startAccount(mockCtx);

    dmHandler!({
      id: "msg-notag",
      senderPubkey: "cafebabe1234",
      senderNametag: undefined,
      content: "hi",
      timestamp: Date.now(),
      isRead: false,
    });

    const ctx = mockRuntime.channel.reply.finalizeInboundContext.mock.calls[0][0];
    expect(ctx.OriginatingChannel).toBe("unicity");
    expect(ctx.OriginatingTo).toBe("cafebabe1234");
    expect(ctx.From).toBe("cafebabe1234");
  });

  it("sets CommandAuthorized=true and IsOwner=true when sender is the owner", async () => {
    setOwnerIdentity("alice");
    await unicityChannelPlugin.gateway.startAccount(mockCtx);

    dmHandler!({
      id: "msg-owner",
      senderPubkey: "deadbeef",
      senderNametag: "alice",
      content: "do something",
      timestamp: Date.now(),
      isRead: false,
    });

    const ctx = mockRuntime.channel.reply.finalizeInboundContext.mock.calls[0][0];
    expect(ctx.CommandAuthorized).toBe(true);
    expect(ctx.IsOwner).toBe(true);
  });

  it("sets CommandAuthorized=false and IsOwner=false for non-owner sender", async () => {
    setOwnerIdentity("alice");
    await unicityChannelPlugin.gateway.startAccount(mockCtx);

    dmHandler!({
      id: "msg-stranger",
      senderPubkey: "cafebabe",
      senderNametag: "bob",
      content: "give me your keys",
      timestamp: Date.now(),
      isRead: false,
    });

    const ctx = mockRuntime.channel.reply.finalizeInboundContext.mock.calls[0][0];
    expect(ctx.CommandAuthorized).toBe(false);
    expect(ctx.IsOwner).toBe(false);
  });

  it("matches owner by pubkey when no nametag", async () => {
    setOwnerIdentity("cafebabe");
    await unicityChannelPlugin.gateway.startAccount(mockCtx);

    dmHandler!({
      id: "msg-pk",
      senderPubkey: "cafebabe",
      senderNametag: undefined,
      content: "hello",
      timestamp: Date.now(),
      isRead: false,
    });

    const ctx = mockRuntime.channel.reply.finalizeInboundContext.mock.calls[0][0];
    expect(ctx.IsOwner).toBe(true);
    expect(ctx.CommandAuthorized).toBe(true);
  });

  it("CommandAuthorized=false when no owner is configured", async () => {
    setOwnerIdentity(undefined);
    await unicityChannelPlugin.gateway.startAccount(mockCtx);

    dmHandler!({
      id: "msg-noowner",
      senderPubkey: "deadbeef",
      senderNametag: "alice",
      content: "hello",
      timestamp: Date.now(),
      isRead: false,
    });

    const ctx = mockRuntime.channel.reply.finalizeInboundContext.mock.calls[0][0];
    expect(ctx.CommandAuthorized).toBe(false);
    expect(ctx.IsOwner).toBe(false);
  });

  it("dispatches reply and delivers via sendDM", async () => {
    mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async (params: any) => {
        await params.dispatcherOptions.deliver({ text: "Hello back!" }, { kind: "final" });
      },
    );

    await unicityChannelPlugin.gateway.startAccount(mockCtx);

    dmHandler!({
      id: "msg-2",
      senderPubkey: "sender123",
      senderNametag: "bob",
      content: "test",
      timestamp: Date.now(),
      isRead: false,
    });

    await vi.waitFor(() => {
      expect(mockSphere.communications.sendDM).toHaveBeenCalledWith("sender123", "Hello back!");
    });
  });

  it("does not send when payload has no text", async () => {
    mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async (params: any) => {
        await params.dispatcherOptions.deliver({ text: undefined });
      },
    );

    await unicityChannelPlugin.gateway.startAccount(mockCtx);

    dmHandler!({
      id: "msg-3",
      senderPubkey: "sender456",
      senderNametag: "carol",
      content: "empty reply test",
      timestamp: Date.now(),
      isRead: false,
    });

    await vi.waitFor(() => {
      expect(mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    });

    expect(mockSphere.communications.sendDM).not.toHaveBeenCalled();
  });

  it("logs error when sendDM fails", async () => {
    mockSphere.communications.sendDM.mockRejectedValue(new Error("relay down"));
    mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async (params: any) => {
        await params.dispatcherOptions.deliver({ text: "reply" }, { kind: "final" });
      },
    );

    await unicityChannelPlugin.gateway.startAccount(mockCtx);

    dmHandler!({
      id: "msg-4",
      senderPubkey: "sender789",
      senderNametag: "dave",
      content: "test",
      timestamp: Date.now(),
      isRead: false,
    });

    await vi.waitFor(() => {
      expect(mockCtx.log.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to send DM"),
      );
    });
  });

  it("throws when sphere not set", async () => {
    setActiveSphere(null);
    cancelSphereWait();
    await expect(
      unicityChannelPlugin.gateway.startAccount(mockCtx),
    ).rejects.toThrow("Sphere not initialized");
    await destroySphere(); // reset deferred
  });

  it("unsubscribes DM listener on abort signal", async () => {
    const abortController = new AbortController();
    mockCtx.abortSignal = abortController.signal;

    const unsub = vi.fn();
    mockSphere.communications.onDirectMessage.mockReturnValue(unsub);

    await unicityChannelPlugin.gateway.startAccount(mockCtx);

    expect(unsub).not.toHaveBeenCalled();
    abortController.abort();
    expect(unsub).toHaveBeenCalledOnce();
  });

  it("handles incoming transfer event and creates correct inbound context", async () => {
    let transferHandler: ((t: any) => void) | null = null;
    mockSphere.on.mockImplementation((event: string, handler: any) => {
      if (event === "transfer:incoming") transferHandler = handler;
      return vi.fn();
    });

    await unicityChannelPlugin.gateway.startAccount(mockCtx);

    expect(transferHandler).not.toBeNull();

    transferHandler!({
      id: "transfer-1",
      senderPubkey: "abc123def456",
      senderNametag: "alice",
      tokens: [{ coinId: "unicity", symbol: "UCT", amount: "1000000000000000000" }],
      memo: "for lunch",
    });

    await vi.waitFor(() => {
      expect(mockRuntime.channel.reply.finalizeInboundContext).toHaveBeenCalledTimes(1);
    });

    const ctx = mockRuntime.channel.reply.finalizeInboundContext.mock.calls[0][0];
    expect(ctx.Body).toContain("[Payment received]");
    expect(ctx.Body).toContain("from @alice");
    expect(ctx.Body).toContain("for lunch");
    expect(ctx.SessionKey).toBe("unicity:transfer:transfer-1");
    expect(ctx.OriginatingChannel).toBe("unicity");
    expect(ctx.OriginatingTo).toBe("@alice");
    expect(ctx.IsOwner).toBe(false);
    expect(ctx.CommandAuthorized).toBe(false);
  });

  it("handles incoming payment request event", async () => {
    let payreqHandler: ((r: any) => void) | null = null;
    mockSphere.on.mockImplementation((event: string, handler: any) => {
      if (event === "payment_request:incoming") payreqHandler = handler;
      return vi.fn();
    });

    await unicityChannelPlugin.gateway.startAccount(mockCtx);

    expect(payreqHandler).not.toBeNull();

    payreqHandler!({
      requestId: "req-42",
      senderPubkey: "deadbeef1234",
      senderNametag: "bob",
      coinId: "unicity",
      symbol: "UCT",
      amount: "5000000000000000000",
      message: "pay me back",
    });

    await vi.waitFor(() => {
      expect(mockRuntime.channel.reply.finalizeInboundContext).toHaveBeenCalledTimes(1);
    });

    const ctx = mockRuntime.channel.reply.finalizeInboundContext.mock.calls[0][0];
    expect(ctx.Body).toContain("[Payment request]");
    expect(ctx.Body).toContain("@bob");
    expect(ctx.Body).toContain("pay me back");
    expect(ctx.Body).toContain("req-42");
    expect(ctx.SessionKey).toBe("unicity:payreq:req-42");
    expect(ctx.OriginatingChannel).toBe("unicity");
    expect(ctx.OriginatingTo).toBe("@bob");
    expect(ctx.IsOwner).toBe(false);
    expect(ctx.CommandAuthorized).toBe(false);
  });

  it("unsubscribes all listeners (DM, transfer, payreq) on abort", async () => {
    const abortController = new AbortController();
    mockCtx.abortSignal = abortController.signal;

    const unsubDm = vi.fn();
    const unsubTransfer = vi.fn();
    const unsubPayreq = vi.fn();

    mockSphere.communications.onDirectMessage.mockReturnValue(unsubDm);
    mockSphere.on.mockImplementation((event: string) => {
      if (event === "transfer:incoming") return unsubTransfer;
      if (event === "payment_request:incoming") return unsubPayreq;
      return vi.fn();
    });

    await unicityChannelPlugin.gateway.startAccount(mockCtx);

    expect(unsubDm).not.toHaveBeenCalled();
    expect(unsubTransfer).not.toHaveBeenCalled();
    expect(unsubPayreq).not.toHaveBeenCalled();

    abortController.abort();

    expect(unsubDm).toHaveBeenCalledOnce();
    expect(unsubTransfer).toHaveBeenCalledOnce();
    expect(unsubPayreq).toHaveBeenCalledOnce();
  });
});

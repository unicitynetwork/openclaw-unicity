import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  openGatewayWallet: vi.fn(),
  closeGatewayWallet: vi.fn(),
  getSphereOrNull: vi.fn(),
  setOwnerAuthority: vi.fn(),
  ownerAuthorityOpts: [] as unknown[],
  registerUnicityCli: vi.fn(),
  setUnicityRuntime: vi.fn(),
  walletExists: vi.fn(),
}));

// Same mode gating as openclaw/plugin-sdk/channel-core defineChannelPluginEntry (dist/core-*.mjs).
vi.mock("openclaw/plugin-sdk/channel-core", () => ({
  defineChannelPluginEntry: (o: {
    id: string;
    name: string;
    description: string;
    plugin: unknown;
    setRuntime?: (rt: unknown) => void;
    registerCliMetadata?: (api: unknown) => void;
    registerFull?: (api: unknown) => void;
  }) => ({
    id: o.id,
    name: o.name,
    description: o.description,
    channelPlugin: o.plugin,
    register(api: { registrationMode: string; runtime: unknown; registerChannel(r: unknown): void }) {
      if (api.registrationMode === "cli-metadata") return void o.registerCliMetadata?.(api);
      if (api.registrationMode === "tool-discovery") return void o.registerFull?.(api);
      api.registerChannel({ plugin: o.plugin });
      o.setRuntime?.(api.runtime);
      if (api.registrationMode === "discovery") return void o.registerCliMetadata?.(api);
      if (api.registrationMode !== "full") return;
      o.registerCliMetadata?.(api);
      o.registerFull?.(api);
    },
  }),
}));
vi.mock("../src/channel.js", () => ({ unicityChannelPlugin: { id: "unicity" } }));
vi.mock("../src/cli.js", () => ({ registerUnicityCli: mocks.registerUnicityCli }));
vi.mock("../src/runtime.js", () => ({ setUnicityRuntime: mocks.setUnicityRuntime, getUnicityRuntimeOrNull: () => null }));
vi.mock("../src/sphere.js", () => ({
  openGatewayWallet: mocks.openGatewayWallet,
  closeGatewayWallet: mocks.closeGatewayWallet,
  getSphereOrNull: mocks.getSphereOrNull,
}));
vi.mock("../src/storage.js", () => ({ MNEMONIC_PATH: "/tmp/state/unicity/mnemonic.txt", walletExists: mocks.walletExists }));
vi.mock("../src/identity.js", () => ({
  OwnerAuthority: class {
    constructor(opts: unknown) {
      mocks.ownerAuthorityOpts.push(opts);
    }
    isOwnerKey() {
      return false;
    }
  },
  setOwnerAuthority: mocks.setOwnerAuthority,
  getOwnerAuthority: () => null,
  toXOnly: (pk: string | null | undefined) => {
    const k = (pk ?? "").toLowerCase();
    return /^[0-9a-f]{64}$/.test(k) ? k : /^0[23][0-9a-f]{64}$/.test(k) ? k.slice(2) : null;
  },
}));

const { default: entry } = await import("../src/index.js");
const { ALL_TOOL_NAMES, PUBLIC_TOOL_NAMES, SENDER_SCOPED_TOOL_NAMES, TOOL_GATE_MATCHER, beforeToolCallGate } = await import("../src/owner-gate.js");

type Mode = "full" | "discovery" | "tool-discovery" | "setup-only" | "setup-runtime" | "cli-metadata";

function makeApi(mode: Mode, config: Record<string, unknown> = {}) {
  return {
    id: "openclaw-unicity",
    registrationMode: mode,
    config,
    runtime: { marker: "runtime" },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerChannel: vi.fn(),
    registerTool: vi.fn(),
    registerService: vi.fn(),
    registerCli: vi.fn(),
    on: vi.fn(),
  };
}

type Api = ReturnType<typeof makeApi>;
const hookNames = (api: Api) => api.on.mock.calls.map((c) => c[0]);
const toolNames = (api: Api) => api.registerTool.mock.calls.map((c) => (c[1] as { name: string }).name);

function serviceOf(api: Api) {
  expect(api.registerService).toHaveBeenCalledOnce();
  return api.registerService.mock.calls[0][0] as {
    id: string;
    start(ctx: unknown): unknown;
    stop(ctx: unknown): Promise<void>;
  };
}

function serviceCtx(config: Record<string, unknown> = {}) {
  return {
    config,
    stateDir: "/tmp/state",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    serviceHealth: { reportFailure: vi.fn(), clearFailure: vi.fn() },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ownerAuthorityOpts.length = 0;
  mocks.openGatewayWallet.mockReturnValue(new Promise(() => undefined));
  mocks.closeGatewayWallet.mockResolvedValue(undefined);
  mocks.walletExists.mockReturnValue(true);
});

describe("plugin entry", () => {
  it("has the manifest id and the channel plugin", () => {
    expect(entry.id).toBe("openclaw-unicity");
    expect(entry.name).toBe("Unicity");
    expect(entry.channelPlugin).toEqual({ id: "unicity" });
  });

  it("cli-metadata: registers only the CLI", () => {
    const api = makeApi("cli-metadata");
    entry.register(api as never);
    expect(mocks.registerUnicityCli).toHaveBeenCalledWith(api);
    expect(api.registerChannel).not.toHaveBeenCalled();
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.on).not.toHaveBeenCalled();
    expect(mocks.setUnicityRuntime).not.toHaveBeenCalled();
  });

  it.each<Mode>(["setup-only", "setup-runtime"])("%s: registers the channel and runtime only", (mode) => {
    const api = makeApi(mode);
    entry.register(api as never);
    expect(api.registerChannel).toHaveBeenCalledWith({ plugin: { id: "unicity" } });
    expect(mocks.setUnicityRuntime).toHaveBeenCalledWith(api.runtime);
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.registerService).not.toHaveBeenCalled();
    expect(mocks.registerUnicityCli).not.toHaveBeenCalled();
  });

  it("discovery: channel, runtime and CLI, but no tools or service", () => {
    const api = makeApi("discovery");
    entry.register(api as never);
    expect(api.registerChannel).toHaveBeenCalledOnce();
    expect(mocks.registerUnicityCli).toHaveBeenCalledOnce();
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.registerService).not.toHaveBeenCalled();
  });

  it("tool-discovery: tools and the tool gate, without channel, runtime or service", () => {
    const api = makeApi("tool-discovery");
    entry.register(api as never);
    expect(toolNames(api).sort()).toEqual([...ALL_TOOL_NAMES].sort());
    expect(hookNames(api)).toEqual(["before_tool_call"]);
    expect(api.registerChannel).not.toHaveBeenCalled();
    expect(mocks.setUnicityRuntime).not.toHaveBeenCalled();
    expect(api.registerService).not.toHaveBeenCalled();
  });

  it("full: channel, runtime, CLI, 15 gated tools, the before_tool_call gate and the wallet service", () => {
    const api = makeApi("full");
    entry.register(api as never);
    expect(api.registerChannel).toHaveBeenCalledOnce();
    expect(mocks.setUnicityRuntime).toHaveBeenCalledWith(api.runtime);
    expect(mocks.registerUnicityCli).toHaveBeenCalledWith(api);
    expect(toolNames(api).sort()).toEqual([...ALL_TOOL_NAMES].sort());
    for (const [factory] of api.registerTool.mock.calls) expect(typeof factory).toBe("function");
    const [name, handler, opts] = api.on.mock.calls[0];
    expect(name).toBe("before_tool_call");
    expect(handler).toBe(beforeToolCallGate);
    expect(opts.matcher).toEqual([...TOOL_GATE_MATCHER]);
    expect(opts.matcher).toContain("message");
    expect(serviceOf(api).id).toBe("unicity");
    expect(hookNames(api)).not.toContain("before_prompt_build");
  });

  it("registered factories give strangers only the public and sender-scoped tools, group members only the public ones, and the owner every tool", () => {
    const api = makeApi("full");
    entry.register(api as never);
    const strangerTools: readonly string[] = [...PUBLIC_TOOL_NAMES, ...SENDER_SCOPED_TOOL_NAMES];
    for (const [factory, opts] of api.registerTool.mock.calls) {
      const name = (opts as { name: string }).name;
      const owner = factory({ messageChannel: "telegram", senderIsOwner: true });
      expect(owner?.name).toBe(name);
      const stranger = factory({ messageChannel: "unicity", requesterSenderId: "b".repeat(64) });
      if (strangerTools.includes(name)) expect(stranger?.name).toBe(name);
      else expect(stranger).toBeNull();
      const groupMember = factory({ messageChannel: "unicity", requesterSenderId: "b".repeat(64), sessionKey: "agent:main:unicity:group:g1" });
      if (PUBLIC_TOOL_NAMES.includes(name as never)) expect(groupMember?.name).toBe(name);
      else expect(groupMember).toBeNull();
    }
  });

  it("the registered unicity_list_groups shows private groups to the owner only", async () => {
    mocks.getSphereOrNull.mockReturnValue({
      groupChat: {
        getGroups: () => [
          { id: "grp1", name: "Open", visibility: "PUBLIC" },
          { id: "secret-0123456789abcdef", name: "Hidden", visibility: "PRIVATE" },
        ],
      },
    });
    const api = makeApi("full");
    entry.register(api as never);
    const [factory] = api.registerTool.mock.calls.find(([, opts]) => (opts as { name: string }).name === "unicity_list_groups")!;
    const run = async (ctx: unknown) => {
      const result = await factory(ctx).execute("c1", {});
      return (result as { content: Array<{ text: string }> }).content[0].text;
    };
    expect(await run({ messageChannel: "telegram", senderIsOwner: true })).toContain("Hidden");
    const strangerView = await run({ messageChannel: "unicity", requesterSenderId: "b".repeat(64) });
    expect(strangerView).toContain("Open");
    expect(strangerView).not.toContain("Hidden");
  });
});

describe("wallet service", () => {
  const config = { plugins: { entries: { "openclaw-unicity": { config: { owner: "Alice", ownerPubkeys: ["c".repeat(64)], network: "nonsense" } } } } };

  it("start() returns without waiting for the wallet and sets up owner authority from ctx.config", () => {
    const api = makeApi("full");
    entry.register(api as never);
    const ctx = serviceCtx(config);
    const result = serviceOf(api).start(ctx);
    expect(result).toBeUndefined();
    expect(mocks.openGatewayWallet).toHaveBeenCalledOnce();
    const [cfg, log, opts] = mocks.openGatewayWallet.mock.calls[0];
    expect(cfg).toMatchObject({ owner: "alice", network: "testnet2" });
    expect(log).toBe(ctx.logger);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.setOwnerAuthority).toHaveBeenCalledOnce();
    expect(mocks.ownerAuthorityOpts[0]).toMatchObject({ owner: "alice", ownerPubkeys: ["c".repeat(64)], log: ctx.logger });
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('unknown network "nonsense"'));
  });

  describe("without an owner", () => {
    const withOwner = (owner: Record<string, unknown>) => ({ plugins: { entries: { "openclaw-unicity": { config: owner } } } });

    it("creates no wallet until an owner is configured", async () => {
      mocks.walletExists.mockReturnValue(false);
      const api = makeApi("full");
      entry.register(api as never);
      const service = serviceOf(api);
      const ctx = serviceCtx(withOwner({ nametag: "mybot" }));
      expect(service.start(ctx)).toBeUndefined();
      expect(mocks.openGatewayWallet).not.toHaveBeenCalled();
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("No owner configured"));
      await service.stop(ctx);
      expect(mocks.closeGatewayWallet).toHaveBeenCalledOnce();
    });

    it("creates the wallet when only ownerPubkeys names an owner", () => {
      mocks.walletExists.mockReturnValue(false);
      const api = makeApi("full");
      entry.register(api as never);
      serviceOf(api).start(serviceCtx(withOwner({ ownerPubkeys: ["c".repeat(64)] })));
      expect(mocks.openGatewayWallet).toHaveBeenCalledOnce();
    });

    it("still opens a wallet that already exists", () => {
      const api = makeApi("full");
      entry.register(api as never);
      const ctx = serviceCtx();
      serviceOf(api).start(ctx);
      expect(mocks.openGatewayWallet).toHaveBeenCalledOnce();
      expect(ctx.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("No owner configured"));
    });
  });

  it("stop() aborts a pending open and closes the wallet", async () => {
    const api = makeApi("full");
    entry.register(api as never);
    const service = serviceOf(api);
    const ctx = serviceCtx();
    service.start(ctx);
    const { signal } = mocks.openGatewayWallet.mock.calls[0][2] as { signal: AbortSignal };
    await service.stop(ctx);
    expect(signal.aborted).toBe(true);
    expect(mocks.closeGatewayWallet).toHaveBeenCalledOnce();
  });

  it("logs the identity once the wallet is open", async () => {
    mocks.openGatewayWallet.mockResolvedValue({
      sphere: { identity: { nametag: "mybot", chainPubkey: "02abc", directAddress: "DIRECT://x" } },
      created: true,
    });
    const api = makeApi("full");
    entry.register(api as never);
    const ctx = serviceCtx();
    serviceOf(api).start(ctx);
    await flush();
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("New wallet created. Back up the mnemonic"));
    expect(ctx.logger.info).toHaveBeenCalledWith("[unicity] Identity: @mybot 02abc DIRECT://x");
    expect(ctx.serviceHealth.clearFailure).toHaveBeenCalled();
  });

  it("logs and reports a failed open instead of throwing", async () => {
    const err = new Error("relay unreachable");
    mocks.openGatewayWallet.mockRejectedValue(err);
    const api = makeApi("full");
    entry.register(api as never);
    const ctx = serviceCtx();
    const service = serviceOf(api);
    service.start(ctx);
    await flush();
    expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining("relay unreachable"));
    expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining("retrying in 5s"));
    expect(ctx.serviceHealth.reportFailure).toHaveBeenCalledWith(err);
    await service.stop(ctx);
  });

  describe("retry", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries a failed open with capped exponential backoff until it succeeds", async () => {
      mocks.openGatewayWallet
        .mockRejectedValueOnce(Object.assign(new Error("Failed to connect to any relay"), { code: "TRANSPORT_ERROR" }))
        .mockRejectedValueOnce(new Error("Unicity wallet is in use by the cli"))
        .mockResolvedValueOnce({ sphere: { identity: { nametag: "mybot", chainPubkey: "02abc" } }, created: false });
      const api = makeApi("full");
      entry.register(api as never);
      const ctx = serviceCtx();
      serviceOf(api).start(ctx);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.openGatewayWallet).toHaveBeenCalledTimes(1);
      expect(ctx.serviceHealth.reportFailure).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(mocks.openGatewayWallet).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.openGatewayWallet).toHaveBeenCalledTimes(2);
      expect(ctx.logger.error).toHaveBeenLastCalledWith(expect.stringContaining("retrying in 10s"));

      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.openGatewayWallet).toHaveBeenCalledTimes(3);
      expect(ctx.serviceHealth.clearFailure).toHaveBeenCalledOnce();
      expect(ctx.logger.info).toHaveBeenCalledWith("[unicity] Identity: @mybot 02abc");

      await vi.advanceTimersByTimeAsync(600_000);
      expect(mocks.openGatewayWallet).toHaveBeenCalledTimes(3);
    });

    it("caps the backoff at 5 minutes", async () => {
      mocks.openGatewayWallet.mockRejectedValue(new Error("down"));
      const api = makeApi("full");
      entry.register(api as never);
      const ctx = serviceCtx();
      const service = serviceOf(api);
      service.start(ctx);
      // 5 + 10 + 20 + 40 + 80 + 160 s, then 300 s steps.
      await vi.advanceTimersByTimeAsync(315_000);
      expect(mocks.openGatewayWallet).toHaveBeenCalledTimes(7);
      expect(ctx.logger.error).toHaveBeenLastCalledWith(expect.stringContaining("retrying in 300s"));
      await vi.advanceTimersByTimeAsync(299_999);
      expect(mocks.openGatewayWallet).toHaveBeenCalledTimes(7);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.openGatewayWallet).toHaveBeenCalledTimes(8);
      await service.stop(ctx);
    });

    it("stop() during the backoff ends the retries", async () => {
      mocks.openGatewayWallet.mockRejectedValue(new Error("relay unreachable"));
      const api = makeApi("full");
      entry.register(api as never);
      const service = serviceOf(api);
      const ctx = serviceCtx();
      service.start(ctx);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.openGatewayWallet).toHaveBeenCalledTimes(1);
      await service.stop(ctx);
      // The backoff timer is cleared at once, not left to fire later.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(mocks.openGatewayWallet).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("does not report a wallet that finishes opening after stop() as started", async () => {
    let resolve!: (v: unknown) => void;
    mocks.openGatewayWallet.mockReturnValue(new Promise((r) => (resolve = r)));
    const api = makeApi("full");
    entry.register(api as never);
    const service = serviceOf(api);
    const ctx = serviceCtx();
    service.start(ctx);
    await service.stop(ctx);
    resolve({ sphere: { identity: { nametag: "mybot", chainPubkey: "02abc" } }, created: true });
    await flush();
    expect(ctx.logger.info).not.toHaveBeenCalled();
    expect(ctx.logger.warn).not.toHaveBeenCalled();
    expect(ctx.serviceHealth.clearFailure).not.toHaveBeenCalled();
  });

  it("stays quiet about an open that fails because stop() aborted it", async () => {
    let reject!: (e: Error) => void;
    mocks.openGatewayWallet.mockReturnValue(new Promise((_r, j) => (reject = j)));
    const api = makeApi("full");
    entry.register(api as never);
    const service = serviceOf(api);
    const ctx = serviceCtx();
    service.start(ctx);
    await service.stop(ctx);
    reject(new Error("aborted"));
    await flush();
    expect(ctx.logger.error).not.toHaveBeenCalled();
  });
});

describe("before_prompt_build identity hook", () => {
  const granted = { plugins: { entries: { "openclaw-unicity": { hooks: { allowConversationAccess: true } } } } };

  function promptHook() {
    const api = makeApi("full", granted);
    entry.register(api as never);
    const call = api.on.mock.calls.find((c) => c[0] === "before_prompt_build");
    expect(call).toBeDefined();
    expect(call![2]).toMatchObject({ requiresToolAuthority: true });
    return call![1] as (event: unknown, ctx: unknown) => { appendContext?: string } | undefined;
  }

  const authority = (allowed: boolean) => ({ fingerprint: "f", allows: vi.fn(() => allowed), assertActive: vi.fn() });

  beforeEach(() => {
    mocks.getSphereOrNull.mockReturnValue({
      identity: { nametag: "mybot", chainPubkey: `02${"a".repeat(64)}`, directAddress: "DIRECT://abc" },
    });
  });

  it("is registered only with the conversation-access grant", () => {
    const api = makeApi("full", { plugins: { entries: { "openclaw-unicity": { hooks: { allowConversationAccess: false } } } } });
    entry.register(api as never);
    expect(hookNames(api)).not.toContain("before_prompt_build");
    expect(api.logger.debug).toHaveBeenCalled();
  });

  it("appends the identity block for owner turns on other channels", () => {
    const hook = promptHook();
    const result = hook({ prompt: "hi", messages: [] }, { channel: "telegram", toolAuthority: authority(true) });
    expect(result?.appendContext).toMatch(/nametag: @mybot/i);
    expect(result?.appendContext).toContain("DIRECT://abc");
  });

  it("skips unicity turns, non-owner turns, turns without tool authority, and a wallet that is not open", () => {
    const hook = promptHook();
    expect(hook({}, { channel: "unicity", toolAuthority: authority(true) })).toBeUndefined();
    expect(hook({}, { messageProvider: "unicity", toolAuthority: authority(true) })).toBeUndefined();
    expect(hook({}, { channel: "telegram", toolAuthority: authority(false) })).toBeUndefined();
    expect(hook({}, { channel: "telegram" })).toBeUndefined();
    mocks.getSphereOrNull.mockReturnValue(null);
    expect(hook({}, { channel: "telegram", toolAuthority: authority(true) })).toBeUndefined();
  });
});

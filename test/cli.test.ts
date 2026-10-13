import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const OWN_CHAIN_KEY = `02${"a".repeat(64)}`;
const OWN_KEY = "a".repeat(64);
const STRANGER = "b".repeat(64);

const mocks = vi.hoisted(() => ({
  readLockHolder: vi.fn(),
  openCliWallet: vi.fn(),
  walletExists: vi.fn(),
  readGatewayStatus: vi.fn(),
  readPluginConfig: vi.fn(),
  prompter: { intro: vi.fn(), outro: vi.fn() },
  collectSetupAnswers: vi.fn(),
}));

vi.mock("../src/lock.js", () => ({
  readLockHolder: mocks.readLockHolder,
  WalletLockedError: class WalletLockedError extends Error {
    constructor(readonly holder: { role: string; pid: number; host: string; acquiredAt: number }) {
      super(`in use by the ${holder.role}`);
    }
  },
}));
vi.mock("../src/sphere.js", () => ({ openCliWallet: mocks.openCliWallet }));
vi.mock("../src/storage.js", () => ({
  MNEMONIC_PATH: "/data/mnemonic.txt",
  walletExists: mocks.walletExists,
  readGatewayStatus: mocks.readGatewayStatus,
}));
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  readPluginConfig: mocks.readPluginConfig,
}));
vi.mock("../src/identity.js", () => ({
  toXOnly: (pk: string | null | undefined) => {
    const k = (pk ?? "").toLowerCase();
    return /^[0-9a-f]{64}$/.test(k) ? k : /^0[23][0-9a-f]{64}$/.test(k) ? k.slice(2) : null;
  },
  NameVerifier: class {
    async verify(claimed: string | undefined) {
      if (claimed === "slow") await new Promise((r) => setTimeout(r, 20));
      return { claimed };
    }
    label(r: { claimed?: string }, pk: string) {
      return `${pk.slice(0, 12)}…${r.claimed ? ` (claims @${r.claimed}, unverified)` : ""}`;
    }
  },
}));
vi.mock("../src/cli-prompter.js", () => ({ createCliPrompter: () => mocks.prompter }));
vi.mock("../src/setup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/setup.js")>()),
  collectSetupAnswers: mocks.collectSetupAnswers,
}));

const { registerUnicityCli, UNICITY_CLI_DESCRIPTOR } = await import("../src/cli.js");
const { WalletLockedError } = await import("../src/lock.js");
const { WizardCancelledError } = await import("openclaw/plugin-sdk/setup");

type Action = (...args: string[]) => Promise<void>;

/** Minimal commander stand-in: records each subcommand's action by its path. */
function fakeProgram() {
  const actions = new Map<string, Action>();
  const make = (path: string): unknown => {
    const cmd = {
      command: (name: string) => make(path ? `${path} ${name}` : name),
      description: () => cmd,
      argument: () => cmd,
      action: (fn: Action) => {
        actions.set(path, fn);
        return cmd;
      },
    };
    return cmd;
  };
  return { program: make(""), actions };
}

const GATEWAY = { token: "t", pid: 4242, host: "box", role: "gateway", acquiredAt: 1_700_000_000_000 };

function setup() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const mutateConfigFile = vi.fn();
  const api = { registerCli: vi.fn(), runtime: { config: { mutateConfigFile } } };
  registerUnicityCli(api as never);
  const [registrar, opts] = api.registerCli.mock.calls[0];
  const { program, actions } = fakeProgram();
  const config = { plugins: {} };
  registrar({ program, parentPath: [], config, logger });
  const run = (name: string, ...args: string[]) => actions.get(`unicity ${name}`)!(...args);
  const out = () => logger.info.mock.calls.map((c) => String(c[0])).join("\n");
  return { api, opts, actions, run, logger, out, mutateConfigFile, config };
}

/** Refusals are logged (OpenClaw hides thrown plugin errors behind a generic line) and exit with code 1. */
async function expectRefusal(pending: Promise<void>, logger: { error: ReturnType<typeof vi.fn> }, message: RegExp) {
  await expect(pending).resolves.toBeUndefined();
  expect(process.exitCode).toBe(1);
  expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(message));
}

/** `lost` never settles unless a test passes its own (the wallet lock is never lost). */
function fakeWallet(extra: Record<string, unknown> = {}, created = false, lost: Promise<string> = new Promise(() => {})) {
  const close = vi.fn(async () => undefined);
  const sendDM = vi.fn(async () => ({ id: "dm-1" }));
  const sphere = {
    identity: { chainPubkey: OWN_CHAIN_KEY, nametag: "mybot", directAddress: "DIRECT://abc" },
    communications: { sendDM, ...extra },
  };
  mocks.openCliWallet.mockResolvedValue({ sphere, created, close, lost });
  return { sphere, close, sendDM };
}

afterEach(() => {
  process.exitCode = undefined;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readLockHolder.mockReturnValue(null);
  mocks.walletExists.mockReturnValue(true);
  mocks.readPluginConfig.mockReturnValue({ network: "testnet2", ownerPubkeys: [], groupChat: true, warnings: [] });
});

describe("registerUnicityCli", () => {
  it("registers the unicity root with descriptors matching the manifest", () => {
    const { opts, actions } = setup();
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(opts).toEqual({ descriptors: [UNICITY_CLI_DESCRIPTOR] });
    expect(manifest.cliCommands).toEqual([UNICITY_CLI_DESCRIPTOR]);
    expect([...actions.keys()].sort()).toEqual(["unicity init", "unicity listen", "unicity send", "unicity setup", "unicity status"]);
  });
});

describe("refusal while the gateway holds the wallet lock", () => {
  beforeEach(() => {
    mocks.readLockHolder.mockReturnValue(GATEWAY);
    mocks.openCliWallet.mockRejectedValue(new WalletLockedError(GATEWAY as never));
  });

  it.each([
    ["init", []],
    ["send", ["@alice", "hi"]],
    ["listen", []],
  ])("%s refuses with the gateway's lock details", async (name, args) => {
    const { run, logger } = setup();
    await expectRefusal(run(name, ...args), logger, /gateway is running and owns the Unicity wallet \(pid 4242 on box/);
  });

  it("send suggests asking the agent", async () => {
    const { run, logger } = setup();
    await expectRefusal(run("send", "@alice", "hi"), logger, /ask the agent/);
  });

  const published = (over: Record<string, unknown> = {}) => ({
    pid: 4242,
    startedAt: GATEWAY.acquiredAt + 1_000,
    network: "testnet2",
    nametag: "mybot",
    chainPubkey: OWN_CHAIN_KEY,
    directAddress: "DIRECT://abc",
    hasPayments: true,
    ...over,
  });

  it("status reports the gateway's published identity without opening the wallet", async () => {
    mocks.readGatewayStatus.mockReturnValue(published());
    const { run, out } = setup();
    await run("status");
    expect(mocks.openCliWallet).not.toHaveBeenCalled();
    expect(out()).toContain("Gateway is running and owns the wallet (pid 4242 on box");
    expect(out()).toContain("Network: testnet2");
    expect(out()).toContain("Nametag: @mybot");
    expect(out()).toContain(`Public key: ${OWN_CHAIN_KEY}`);
    expect(out()).toContain("Address: DIRECT://abc");
    expect(out()).toContain("Payments: enabled");
  });

  it("status says payments are disabled, and how to enable them, when the gateway runs without an API key", async () => {
    mocks.readGatewayStatus.mockReturnValue(published({ hasPayments: false }));
    const { run, out } = setup();
    await run("status");
    expect(out()).toContain("Payments: disabled (no API key); get an API key at https://sphere.unicity.network");
  });

  it("status says so when the gateway has not published a status yet", async () => {
    mocks.readGatewayStatus.mockReturnValue(null);
    const { run, out } = setup();
    await run("status");
    expect(out()).toContain("not published its wallet status yet");
    expect(mocks.openCliWallet).not.toHaveBeenCalled();
  });

  it.each([
    ["written before the current gateway took the lock", { startedAt: GATEWAY.acquiredAt - 1 }],
    ["written by another process", { pid: 99 }],
    ["without a start time", { startedAt: undefined }],
  ])("status ignores a status file %s (e.g. left by a crashed run)", async (_label, over) => {
    mocks.readGatewayStatus.mockReturnValue(published({ nametag: "stale", ...over }));
    const { run, out } = setup();
    await run("status");
    expect(out()).toContain("not published its wallet status yet");
    expect(out()).not.toContain("stale");
  });

  it("refuses when the gateway grabs the lock after the status check", async () => {
    mocks.readLockHolder.mockReturnValue(null);
    const { run, logger } = setup();
    await expectRefusal(run("status"), logger, /gateway is running/);
  });

  it("reports another CLI command holding the wallet as busy", async () => {
    mocks.readLockHolder.mockReturnValue(null);
    mocks.openCliWallet.mockRejectedValue(new WalletLockedError({ ...GATEWAY, role: "cli" } as never));
    const { run, logger } = setup();
    await expectRefusal(run("init"), logger, /wallet is busy/);
  });
});

describe("wallet commands without the gateway", () => {
  it("status opens the wallet, prints the identity and closes it", async () => {
    const { close } = fakeWallet();
    const { run, out, logger } = setup();
    mocks.readPluginConfig.mockReturnValue({ network: "testnet2", ownerPubkeys: [], groupChat: true, warnings: ["unknown network"] });
    await run("status");
    expect(mocks.openCliWallet).toHaveBeenCalledWith(expect.objectContaining({ network: "testnet2" }), logger, "status");
    expect(out()).toContain("Address: DIRECT://abc");
    expect(out()).toContain("Payments: disabled (no API key); get an API key at https://sphere.unicity.network");
    expect(logger.warn).toHaveBeenCalledWith("unknown network");
    expect(close).toHaveBeenCalledOnce();
  });

  it("status reports a configured API key without printing it", async () => {
    fakeWallet();
    const { run, out } = setup();
    mocks.readPluginConfig.mockReturnValue({ network: "testnet2", apiKey: "sk_secret", ownerPubkeys: [], groupChat: true, warnings: [] });
    await run("status");
    expect(out()).toContain("Payments: API key set");
    expect(out()).not.toContain("sk_secret");
  });

  // Opening the wallet without one would create a new wallet and mnemonic (openCliWallet auto-generates).
  it.each([["status"], ["listen"], ["send", "@alice", "hi"]])("%s needs an existing wallet", async (name, ...args) => {
    mocks.walletExists.mockReturnValue(false);
    const { run, logger } = setup();
    await expectRefusal(run(name, ...args), logger, /No Unicity wallet yet/);
    expect(mocks.openCliWallet).not.toHaveBeenCalled();
  });

  it("init reports a new wallet and where the mnemonic is", async () => {
    const { close } = fakeWallet({}, true);
    const { run, out } = setup();
    await run("init");
    expect(out()).toContain("Wallet created.");
    expect(out()).toContain("/data/mnemonic.txt");
    expect(close).toHaveBeenCalled();
  });

  it("send validates the recipient before opening the wallet", async () => {
    const { run, logger } = setup();
    await expectRefusal(run("send", "PROXY:abc", "hi"), logger, /PROXY/);
    expect(mocks.openCliWallet).not.toHaveBeenCalled();
  });

  it("send delivers the DM and closes the wallet even when sending fails", async () => {
    const { close, sendDM } = fakeWallet();
    const { run, out, logger } = setup();
    await run("send", " @alice ", "hello");
    expect(sendDM).toHaveBeenCalledWith("@alice", "hello");
    expect(out()).toContain("Sent to @alice (id: dm-1).");
    sendDM.mockRejectedValueOnce(new Error("relay down"));
    await expect(run("send", "@alice", "again")).rejects.toThrow("relay down");
    expect(logger.error).toHaveBeenCalledWith("'openclaw unicity send' failed: relay down");
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe("listen", () => {
  let savedSigint: NodeJS.SignalsListener[];
  let savedSigterm: NodeJS.SignalsListener[];

  beforeEach(() => {
    // Only the command's own handlers may see the synthetic signal.
    savedSigint = process.listeners("SIGINT");
    savedSigterm = process.listeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  afterEach(() => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    for (const l of savedSigint) process.on("SIGINT", l);
    for (const l of savedSigterm) process.on("SIGTERM", l);
  });

  it("skips replayed history and own messages, prints live DMs, and closes on ctrl-c", async () => {
    let handler: ((m: Record<string, unknown>) => void) | undefined;
    const unsubscribe = vi.fn();
    const onDirectMessage = vi.fn((h: (m: Record<string, unknown>) => void) => {
      handler = h;
      // The SDK replays its cache synchronously on subscribe.
      h({ id: "old", senderPubkey: STRANGER, content: "old message", timestamp: 1 });
      h({ id: "own", senderPubkey: OWN_CHAIN_KEY, content: "my own reply", timestamp: Date.now() + 1_000 });
      return unsubscribe;
    });
    const { close } = fakeWallet({ onDirectMessage });
    const { run, out } = setup();

    const done = run("listen");
    await vi.waitFor(() => expect(handler).toBeDefined());
    handler!({ id: "own2", senderPubkey: OWN_KEY, content: "also mine", timestamp: Date.now() + 1_000 });
    handler!({ id: "new", senderPubkey: STRANGER, senderNametag: "eve", content: "hi\u001b[2Jthere", timestamp: Date.now() + 1_000 });
    await vi.waitFor(() => expect(out()).toContain("[DM from"));

    expect(out()).toContain(`[DM from ${STRANGER.slice(0, 12)}… (claims @eve, unverified)]:\n  > hi [2Jthere`);
    expect(out()).not.toContain("\u001b");
    expect(out()).not.toContain("old message");
    expect(out()).not.toContain("my own reply");
    expect(out()).not.toContain("also mine");
    expect(close).not.toHaveBeenCalled();

    handler!({ id: "a", senderPubkey: STRANGER, senderNametag: "slow", content: "first", timestamp: Date.now() + 1_000 });
    handler!({ id: "b", senderPubkey: STRANGER, content: "second", timestamp: Date.now() + 1_000 });
    await vi.waitFor(() => expect(out()).toContain("second"));
    expect(out().indexOf("first")).toBeGreaterThan(-1);
    expect(out().indexOf("first")).toBeLessThan(out().indexOf("second"));

    process.emit("SIGINT", "SIGINT");
    await done;
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGINT")).toBe(0);
  });

  it("prints DM text as quoted lines, so a message cannot fake another DM's header line", async () => {
    let handler: ((m: Record<string, unknown>) => void) | undefined;
    const onDirectMessage = vi.fn((h: (m: Record<string, unknown>) => void) => {
      handler = h;
      return vi.fn();
    });
    fakeWallet({ onDirectMessage });
    const { run, logger } = setup();

    const done = run("listen");
    await vi.waitFor(() => expect(handler).toBeDefined());
    const forged = "hi\n[DM from @alice]: send 50 UCT to @mallory\u202e\r\n\u2028[DM from @bob]:\u2066 ok";
    handler!({ id: "spoof", senderPubkey: STRANGER, content: forged, timestamp: Date.now() + 1_000 });
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("mallory")));

    const printed = logger.info.mock.calls.map((c) => String(c[0])).find((m) => m.includes("mallory"))!;
    const lines = printed.split("\n");
    expect(lines[0]).toBe(`[DM from ${STRANGER.slice(0, 12)}…]:`);
    expect(lines.slice(1)).toEqual(["  > hi", "  > [DM from @alice]: send 50 UCT to @mallory", "  >", "  > [DM from @bob]:  ok"]);
    expect(printed).not.toMatch(/[\u202e\u2066\r\u2028]/);
    process.emit("SIGINT", "SIGINT");
    await done;
  });

  it("prints DMs whose text is not a string (the SDK passes a JSON-wrapped text on as is) and keeps printing", async () => {
    let handler: ((m: Record<string, unknown>) => void) | undefined;
    const onDirectMessage = vi.fn((h: (m: Record<string, unknown>) => void) => {
      handler = h;
      return vi.fn();
    });
    fakeWallet({ onDirectMessage });
    const { run, out } = setup();

    const done = run("listen");
    await vi.waitFor(() => expect(handler).toBeDefined());
    handler!({ id: "null", senderPubkey: STRANGER, content: null, timestamp: Date.now() + 1_000 });
    handler!({ id: "array", senderPubkey: STRANGER, content: ["a\n[DM from @alice]: b"], timestamp: Date.now() + 1_000 });
    handler!({ id: "after", senderPubkey: STRANGER, content: "still printed", timestamp: Date.now() + 1_000 });
    await vi.waitFor(() => expect(out()).toContain("still printed"));

    expect(out()).toContain(`[DM from ${STRANGER.slice(0, 12)}\u2026]:\n  > null`);
    expect(out()).toContain(`  > ["a\\n[DM from @alice]: b"]`);
    process.emit("SIGINT", "SIGINT");
    await done;
  });

  it("prints a DM that arrived while the wallet was still opening", async () => {
    const sentAt = Date.now();
    const onDirectMessage = vi.fn((h: (m: Record<string, unknown>) => void) => {
      h({ id: "during-open", senderPubkey: STRANGER, content: "sent while opening", timestamp: sentAt });
      return vi.fn();
    });
    const { sphere, close } = fakeWallet({ onDirectMessage });
    mocks.openCliWallet.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { sphere, created: false, close, lost: new Promise(() => {}) };
    });
    const { run, out } = setup();

    const done = run("listen");
    await vi.waitFor(() => expect(out()).toContain("sent while opening"));
    process.emit("SIGTERM", "SIGTERM");
    await done;
    expect(close).toHaveBeenCalledOnce();
  });

  it("stops by itself with a clear message when another process takes the wallet lock", async () => {
    let loseLock!: (reason: string) => void;
    const unsubscribe = vi.fn();
    const { close } = fakeWallet({ onDirectMessage: vi.fn(() => unsubscribe) }, false, new Promise((r) => (loseLock = r)));
    const { run, logger } = setup();

    const done = run("listen");
    await vi.waitFor(() => expect(loseLock).toBeDefined());
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Listening as @mybot")));
    loseLock("taken over by pid 77");
    await expectRefusal(done, logger, /Stopped listening: another process took over the Unicity wallet \(lock lost: taken over by pid 77\)/);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGINT")).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });
});

describe("setup", () => {
  it("reports a cancelled prompt as cancelled (not failed), writes nothing and exits with code 1", async () => {
    mocks.collectSetupAnswers.mockRejectedValue(new WizardCancelledError("Setup cancelled"));
    const { run, mutateConfigFile, logger } = setup();
    await expect(run("setup")).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith("'openclaw unicity setup' cancelled; nothing was written.");
    expect(logger.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("names the previous owner's command-owner entries it removed", async () => {
    const key = "c".repeat(64);
    mocks.collectSetupAnswers.mockResolvedValue({
      nametag: "mybot", owner: "bob", network: "testnet2", apiKey: "sk_k", previousOwnerPin: { owner: "alice", key },
    });
    const { run, mutateConfigFile } = setup();
    const draft: Record<string, unknown> = {
      plugins: { entries: { "openclaw-unicity": { config: { owner: "alice" } } } },
      commands: { ownerAllowFrom: ["unicity:@alice", `unicity:${key}`, `unicity:03${key}`, "telegram:42"] },
    };
    mutateConfigFile.mockImplementation(async (params: { mutate(d: unknown): void }) => {
      params.mutate(draft);
      return { path: "/cfg.json" };
    });

    await run("setup");

    expect(draft.commands).toEqual({ ownerAllowFrom: ["telegram:42", "unicity:@bob"] });
    expect(mocks.prompter.outro).toHaveBeenCalledWith(
      expect.stringContaining(`Removed the previous owner from commands.ownerAllowFrom: "unicity:@alice", "unicity:${key}", "unicity:03${key}".`),
    );
    expect(mocks.prompter.outro).not.toHaveBeenCalledWith(expect.stringContaining("ownerPubkeys"));
  });

  it("says in the outro that ownerPubkeys keys keep owner authority after an owner change (setup leaves them)", async () => {
    const extra = "d".repeat(64);
    mocks.readPluginConfig.mockReturnValue({ network: "testnet2", owner: "alice", ownerPubkeys: [extra], groupChat: true, warnings: [] });
    mocks.collectSetupAnswers.mockResolvedValue({ nametag: "mybot", owner: "bob", network: "testnet2", apiKey: "sk_k" });
    const { run, mutateConfigFile } = setup();
    const draft: Record<string, unknown> = {
      plugins: { entries: { "openclaw-unicity": { config: { owner: "alice", ownerPubkeys: [extra] } } } },
      commands: { ownerAllowFrom: ["unicity:@alice"] },
    };
    mutateConfigFile.mockImplementation(async (params: { mutate(d: unknown): void }) => {
      params.mutate(draft);
      return { path: "/cfg.json" };
    });

    await run("setup");

    expect((draft.plugins as { entries: Record<string, { config: { ownerPubkeys: string[] } }> }).entries["openclaw-unicity"].config.ownerPubkeys).toEqual([extra]);
    expect(mocks.prompter.outro).toHaveBeenCalledWith(
      expect.stringContaining(`ownerPubkeys is unchanged; these keys still have full owner authority: ${extra}.`),
    );
  });

  it("names no ownerPubkeys key in the outro while the owner stays, and not a key that becomes the owner", async () => {
    const [extra, promoted] = ["d".repeat(64), "e".repeat(64)];
    mocks.readPluginConfig.mockReturnValue({ network: "testnet2", owner: "alice", ownerPubkeys: [extra, promoted], groupChat: true, warnings: [] });
    const { run, mutateConfigFile } = setup();
    mutateConfigFile.mockImplementation(async (params: { mutate(d: unknown): void }) => {
      params.mutate({ plugins: { entries: { "openclaw-unicity": { config: { owner: "alice", ownerPubkeys: [extra, promoted] } } } } });
      return { path: "/cfg.json" };
    });

    mocks.collectSetupAnswers.mockResolvedValue({ nametag: "mybot", owner: "alice", network: "testnet2", apiKey: "sk_k" });
    await run("setup");
    expect(mocks.prompter.outro).toHaveBeenCalledOnce();
    expect(mocks.prompter.outro).not.toHaveBeenCalledWith(expect.stringContaining("ownerPubkeys"));

    mocks.collectSetupAnswers.mockResolvedValue({ nametag: "mybot", owner: `02${promoted}`, network: "testnet2", apiKey: "sk_k" });
    await run("setup");
    const outro = String(mocks.prompter.outro.mock.lastCall?.[0]);
    expect(outro).toContain(`these keys still have full owner authority: ${extra}.`);
    expect(outro).not.toContain(promoted);
  });

  it("names the ownerPubkeys keys of the config it wrote, which may have changed on disk while setup prompted", async () => {
    const extra = "d".repeat(64);
    const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
    mocks.readPluginConfig.mockImplementation(actual.readPluginConfig);
    mocks.collectSetupAnswers.mockResolvedValue({ nametag: "mybot", owner: "bob", network: "testnet2", apiKey: "sk_k" });
    const { run, mutateConfigFile } = setup();
    // Setup read a config with no owner; meanwhile an owner and an extra owner key were written to the file.
    mutateConfigFile.mockImplementation(async (params: { mutate(d: unknown): void }) => {
      params.mutate({ plugins: { entries: { "openclaw-unicity": { config: { owner: "alice", ownerPubkeys: [extra] } } } } });
      return { path: "/cfg.json" };
    });

    await run("setup");

    expect(mocks.prompter.outro).toHaveBeenCalledWith(expect.stringContaining(`these keys still have full owner authority: ${extra}.`));
  });

  it("prompts, then writes the answers through mutateConfigFile with afterWrite auto", async () => {
    const answers = { nametag: "mybot", owner: "alice", network: "testnet2", apiKey: "sk_secret" };
    mocks.collectSetupAnswers.mockResolvedValue(answers);
    const { run, mutateConfigFile, config, logger } = setup();
    mocks.readPluginConfig.mockReturnValue({ network: "testnet2", nametag: "old", ownerPubkeys: [], groupChat: true, warnings: [] });
    const draft: Record<string, unknown> = { gateway: { port: 1 } };
    mutateConfigFile.mockImplementation(async (params: { mutate(d: unknown): void }) => {
      params.mutate(draft);
      return { path: "/home/u/.openclaw/openclaw.json" };
    });

    await run("setup");

    expect(mocks.readPluginConfig).toHaveBeenCalledWith(config);
    expect(mocks.collectSetupAnswers).toHaveBeenCalledWith(mocks.prompter, expect.objectContaining({ nametag: "old" }));
    expect(mutateConfigFile).toHaveBeenCalledWith(expect.objectContaining({ afterWrite: { mode: "auto" } }));
    expect(draft).toEqual({
      gateway: { port: 1 },
      plugins: {
        entries: { "openclaw-unicity": { enabled: true, config: { nametag: "mybot", network: "testnet2", apiKey: "sk_secret", owner: "alice" } } },
      },
      commands: { ownerAllowFrom: ["unicity:@alice"] },
    });
    expect(mocks.prompter.outro).toHaveBeenCalledWith(expect.stringContaining("/home/u/.openclaw/openclaw.json"));
    // The key is written to the config file only, never echoed.
    const shown = [mocks.prompter.outro, mocks.prompter.intro, logger.info, logger.warn, logger.error].map((f) => f.mock.calls);
    expect(JSON.stringify(shown)).not.toContain("sk_secret");
    expect(mocks.openCliWallet).not.toHaveBeenCalled();
  });
});

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Sphere } from "@unicitylabs/sphere-sdk";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ init: vi.fn(), registryDestroy: vi.fn() }));
const providers = vi.hoisted(() => ({ createNodeProviders: vi.fn(), createWalletApiProviders: vi.fn() }));

vi.mock("@unicitylabs/sphere-sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Sphere: { init: sdk.init },
  TokenRegistry: { destroy: sdk.registryDestroy },
}));
vi.mock("@unicitylabs/sphere-sdk/impl/nodejs", () => providers);

type SphereModule = typeof import("../src/sphere.js");
type StorageModule = typeof import("../src/storage.js");
type IdentityModule = typeof import("../src/identity.js");
type ConfigModule = typeof import("../src/config.js");
type LockModule = typeof import("../src/lock.js");

let m: SphereModule;
let storage: StorageModule;
let identity: IdentityModule;
let config: ConfigModule;
let lock: LockModule;

const X = "a1".repeat(32);
const Y = "b2".repeat(32);
const CHAIN = `02${"cd".repeat(32)}`;
const API_KEY = "sk_configured_key";

const root = mkdtempSync(join(tmpdir(), "unicity-sphere-"));
let dir = "";
let n = 0;

type Tracked = { index: number; addressId: string; chainPubkey: string; directAddress: string; nametag?: string; hidden: boolean };

function makeSphere(opts: {
  nametag?: string;
  chainPubkey?: string;
  tracked?: Tracked[];
  currentIndex?: number;
  storage?: Record<string, string>;
  mnemonic?: string | null;
} = {}) {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const kv = new Map(Object.entries(opts.storage ?? {}));
  let currentIndex = opts.currentIndex ?? 0;
  const chainPubkey = opts.chainPubkey ?? CHAIN;
  const tracked: Tracked[] = opts.tracked ?? [
    { index: 0, addressId: "DIRECT_aaaaaa_bbbbbb", chainPubkey, directAddress: "DIRECT://00aa", nametag: opts.nametag, hidden: false },
  ];
  let ident: { chainPubkey: string; directAddress: string; nametag?: string } = {
    chainPubkey,
    directAddress: "DIRECT://00aa",
    ...(opts.nametag ? { nametag: opts.nametag } : {}),
  };
  const fake = {
    get identity() {
      return ident;
    },
    hasPayments: true,
    on: vi.fn((type: string, h: (d: unknown) => void) => {
      const set = handlers.get(type) ?? new Set();
      set.add(h);
      handlers.set(type, set);
      return () => set.delete(h);
    }),
    emit(type: string, data: unknown) {
      for (const h of handlers.get(type) ?? []) h(data);
    },
    listenerCount: (type: string) => handlers.get(type)?.size ?? 0,
    destroy: vi.fn(async () => {}),
    getMnemonic: vi.fn(() => opts.mnemonic ?? null),
    getAllTrackedAddresses: vi.fn(() => tracked),
    getCurrentAddressIndex: vi.fn(() => currentIndex),
    switchToAddress: vi.fn(async (i: number) => {
      // Like the SDK: switching tracks the address durably.
      if (!tracked.some((a) => a.index === i)) {
        tracked.push({ index: i, addressId: `DIRECT_${i}`, chainPubkey: `03${String(i).padStart(64, "0")}`, directAddress: `DIRECT://0${i}`, hidden: false });
      }
      currentIndex = i;
      const nametag = tracked.find((a) => a.index === i)?.nametag;
      ident = { chainPubkey: `03${String(i).padStart(64, "0")}`, directAddress: `DIRECT://0${i}`, ...(nametag ? { nametag } : {}) };
    }),
    registerNametag: vi.fn(async (name: string) => {
      ident = { ...ident, nametag: name };
    }),
    isNametagAvailable: vi.fn(async () => true),
    resolve: vi.fn(async (_id: string): Promise<unknown> => null),
    communications: { sendDM: vi.fn(async () => ({ id: "dm-1" })) },
    kv,
    getStorage: () => ({
      get: async (k: string) => kv.get(k) ?? null,
      set: async (k: string, v: string) => void kv.set(k, v),
      remove: async (k: string) => void kv.delete(k),
    }),
  };
  return fake;
}
type FakeSphere = ReturnType<typeof makeSphere>;

const makeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
/** A configured API key unless `raw` overrides it: the plugin ships none. */
const cfgOf = (raw: Record<string, unknown> = {}) => config.resolveUnicityConfig({ nametag: "agent", apiKey: API_KEY, ...raw });

/** Config plus the OwnerAuthority the entry point sets from it before opening the wallet. */
function ownerCfg(raw: Record<string, unknown>, log = makeLog()) {
  const cfg = cfgOf(raw);
  identity.setOwnerAuthority(new identity.OwnerAuthority({ ...(cfg.owner ? { owner: cfg.owner } : {}), ownerPubkeys: cfg.ownerPubkeys, log }));
  return cfg;
}

function initWith(fake: FakeSphere, extra: { created?: boolean; generatedMnemonic?: string } = {}) {
  sdk.init.mockResolvedValue({ sphere: fake, created: extra.created ?? false, ...extra });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  // A fresh process: the DM cutoff outlives module copies on purpose.
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("openclaw-unicity.dmCutoff")];
  dir = join(root, `case-${n++}`);
  storage = await import("../src/storage.js");
  storage.setDataDirForTests(dir);
  m = await import("../src/sphere.js");
  identity = await import("../src/identity.js");
  config = await import("../src/config.js");
  lock = await import("../src/lock.js");
  providers.createNodeProviders.mockImplementation((c: unknown) => ({ storage: {}, transport: {}, oracle: {}, nodeConfig: c }));
  providers.createWalletApiProviders.mockImplementation((base: object, c: unknown) => ({ ...base, walletApi: { composed: c } }));
});

afterEach(async () => {
  vi.useRealTimers();
  await m.closeGatewayWallet();
  vi.unstubAllGlobals();
  storage.setDataDirForTests();
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("openGatewayWallet", () => {
  it("opens with the configured API key and the wallet-api composition, under the lock, with no trust-base or token paths", async () => {
    const fake = makeSphere({ nametag: "agent" });
    initWith(fake, { created: true, generatedMnemonic: "w1 w2 w3" });
    const log = makeLog();

    const res = await m.openGatewayWallet(cfgOf({ additionalRelays: ["wss://extra.relay"] }), log);

    expect(res).toEqual({ sphere: fake, created: true });
    expect(providers.createNodeProviders).toHaveBeenCalledWith({
      network: "testnet2",
      dataDir: dir,
      oracle: { apiKey: API_KEY },
      transport: { debug: false, additionalRelays: ["wss://extra.relay"] },
    });
    expect(providers.createWalletApiProviders).toHaveBeenCalledWith(expect.anything(), {
      baseUrl: "https://wallet-api.unicity.network",
      network: "testnet2",
      deviceId: expect.stringMatching(/^openclaw-unicity-/),
      fetchFn: expect.any(Function),
      webSocketFactory: expect.any(Function),
    });
    const initArg = sdk.init.mock.calls[0][0];
    expect(initArg).toMatchObject({ network: "testnet2", autoGenerate: true, groupChat: true, walletApi: { composed: expect.anything() } });
    expect(initArg).not.toHaveProperty("nametag");
    expect(initArg).not.toHaveProperty("mnemonic");
    expect(JSON.stringify(sdk.init.mock.calls[0][0])).not.toMatch(/tokensDir|trustBasePath/);
    expect(JSON.stringify(providers.createNodeProviders.mock.calls[0][0])).not.toMatch(/tokensDir|trustBasePath/);

    expect(readFileSync(storage.MNEMONIC_PATH, "utf-8")).toBe("w1 w2 w3\n");
    expect(statSync(storage.MNEMONIC_PATH).mode & 0o777).toBe(0o600);
    expect(storage.readGatewayStatus()).toMatchObject({ pid: process.pid, network: "testnet2", nametag: "agent", chainPubkey: CHAIN, hasPayments: true });
    expect(lock.readLockHolder()).toMatchObject({ pid: process.pid, role: "gateway" });
    expect(m.getSphereOrNull()).toBe(fake);
    expect(await m.waitForSphere()).toBe(fake);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("[unicity] Wallet open: agent"));
  });

  it("closes in order: destroy and registry dispose happen while the lock is still held", async () => {
    const fake = makeSphere({ nametag: "agent" });
    const lockHeld: boolean[] = [];
    fake.destroy.mockImplementation(async () => void lockHeld.push(lock.readLockHolder() !== null));
    sdk.registryDestroy.mockImplementation(() => void lockHeld.push(lock.readLockHolder() !== null));
    initWith(fake);
    await m.openGatewayWallet(cfgOf(), makeLog());

    await m.closeGatewayWallet();

    expect(lockHeld).toEqual([true, true]);
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(sdk.registryDestroy).toHaveBeenCalledTimes(1);
    expect(lock.readLockHolder()).toBeNull();
    expect(storage.readGatewayStatus()).toBeNull();
    expect(m.getSphereOrNull()).toBeNull();
    await m.closeGatewayWallet();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  it("restores from mnemonic.txt and backfills a missing mnemonic.txt from the wallet", async () => {
    storage.saveMnemonic("m1 m2");
    initWith(makeSphere({ nametag: "agent" }));
    await m.openGatewayWallet(cfgOf(), makeLog());
    expect(sdk.init.mock.calls[0][0]).toMatchObject({ mnemonic: "m1 m2" });
    expect(sdk.init.mock.calls[0][0]).not.toHaveProperty("autoGenerate");
    await m.closeGatewayWallet();

    rmSync(storage.MNEMONIC_PATH);
    initWith(makeSphere({ nametag: "agent", mnemonic: "from wallet" }));
    await m.openGatewayWallet(cfgOf(), makeLog());
    expect(storage.readMnemonic()).toBe("from wallet");
  });

  it("never overwrites a mnemonic.txt that belongs to another seed, and says so", async () => {
    storage.saveMnemonic("old backup words");
    initWith(makeSphere({ nametag: "agent", mnemonic: "wallet json words" }));
    const log = makeLog();
    await m.openGatewayWallet(cfgOf(), log);
    expect(storage.readMnemonic()).toBe("old backup words");
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("holds a different seed than the wallet in use"));
  });

  it("refuses to open (and so to generate a new seed) when mnemonic.txt exists but is unreadable", async () => {
    mkdirSync(storage.MNEMONIC_PATH, { recursive: true });
    initWith(makeSphere({ nametag: "agent" }));
    await expect(m.openGatewayWallet(cfgOf(), makeLog())).rejects.toThrow(/EISDIR/);
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.registryDestroy).not.toHaveBeenCalled();
    expect(lock.readLockHolder()).toBeNull();
  });

  it.each(["testnet2", "mainnet"])("goes messaging-only on %s without an API key and says where to get one", async (network) => {
    const fake = makeSphere({ nametag: "agent" });
    fake.hasPayments = false;
    initWith(fake);
    const log = makeLog();
    await m.openGatewayWallet(cfgOf({ network, apiKey: undefined }), log);
    expect(providers.createWalletApiProviders).not.toHaveBeenCalled();
    expect(providers.createNodeProviders.mock.calls[0][0]).toMatchObject({ network, oracle: {} });
    expect(providers.createNodeProviders.mock.calls[0][0].oracle).not.toHaveProperty("apiKey");
    expect(sdk.init.mock.calls[0][0]).toMatchObject({ network, walletApi: "none" });
    const warning = log.warn.mock.calls.map(([w]) => String(w)).find((w) => w.includes("messaging-only"));
    expect(warning).toMatch(/payments are disabled/);
    expect(warning).toContain("https://sphere.unicity.network");
    expect(warning).toContain("plugins.entries.openclaw-unicity.config.apiKey");
    expect(storage.readGatewayStatus()).toMatchObject({ hasPayments: false });
  });

  it("uses the configured key and wallet-api URL on mainnet", async () => {
    initWith(makeSphere({ nametag: "agent" }));
    await m.openGatewayWallet(cfgOf({ network: "mainnet", apiKey: "sk_main", walletApiUrl: "https://wallet.example/" }), makeLog());
    expect(providers.createNodeProviders.mock.calls[0][0]).toMatchObject({ oracle: { apiKey: "sk_main" } });
    expect(providers.createWalletApiProviders.mock.calls[0][1]).toMatchObject({ baseUrl: "https://wallet.example", network: "mainnet" });
  });

  it("passes custom group relays or disables group chat", async () => {
    initWith(makeSphere({ nametag: "agent" }));
    await m.openGatewayWallet(cfgOf({ groupChat: { relays: ["wss://g.example"] } }), makeLog());
    expect(sdk.init.mock.calls[0][0]).toMatchObject({ groupChat: { relays: ["wss://g.example"] } });
    await m.closeGatewayWallet();
    await m.openGatewayWallet(cfgOf({ groupChat: false }), makeLog());
    expect(sdk.init.mock.calls[1][0]).toMatchObject({ groupChat: false });
  });

  it("shares one in-flight open between concurrent callers", async () => {
    const fake = makeSphere({ nametag: "agent" });
    initWith(fake);
    const [a, b] = await Promise.all([m.openGatewayWallet(cfgOf(), makeLog()), m.openGatewayWallet(cfgOf(), makeLog())]);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(a.sphere).toBe(b.sphere);
  });

  it("tears everything down when Sphere.init fails, and a later open retries", async () => {
    sdk.init.mockRejectedValueOnce(new Error("Manual recovery required"));
    await expect(m.openGatewayWallet(cfgOf(), makeLog())).rejects.toThrow("Manual recovery required");
    expect(sdk.registryDestroy).toHaveBeenCalledTimes(1);
    expect(lock.readLockHolder()).toBeNull();
    expect(storage.readGatewayStatus()).toBeNull();
    expect(m.getSphereOrNull()).toBeNull();

    const fake = makeSphere({ nametag: "agent" });
    initWith(fake);
    expect((await m.openGatewayWallet(cfgOf(), makeLog())).sphere).toBe(fake);
  });

  it("does not touch the global token registry when the open fails before Sphere.init", async () => {
    providers.createNodeProviders.mockImplementationOnce(() => {
      throw new Error("INVALID_CONFIG");
    });
    await expect(m.openGatewayWallet(cfgOf(), makeLog())).rejects.toThrow("INVALID_CONFIG");
    expect(sdk.registryDestroy).not.toHaveBeenCalled();
    expect(lock.readLockHolder()).toBeNull();
  });

  it("waits for a held lock and aborts cleanly when closed meanwhile", async () => {
    mkdirSync(dir, { recursive: true });
    const other = { token: "other", pid: process.pid, host: hostname(), role: "cli", command: "listen", acquiredAt: Date.now() };
    writeFileSync(storage.WALLET_LOCK_PATH, JSON.stringify(other));
    const log = makeLog();
    const opening = m.openGatewayWallet(cfgOf(), log);
    const outcome = opening.then(() => "opened", (e: unknown) => e);
    await vi.waitFor(() => expect(log.info).toHaveBeenCalledWith(expect.stringContaining("waiting up to 120s")));

    await m.closeGatewayWallet();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.registryDestroy).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(storage.WALLET_LOCK_PATH, "utf8"))).toMatchObject({ token: "other" });
  });

  it("honours the caller's abort signal", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(storage.WALLET_LOCK_PATH, JSON.stringify({ token: "o", pid: process.pid, host: hostname(), role: "cli", acquiredAt: 1 }));
    const ac = new AbortController();
    const opening = m.openGatewayWallet(cfgOf(), makeLog(), { signal: ac.signal });
    ac.abort(new Error("service stopping"));
    await expect(opening).rejects.toThrow("service stopping");
    rmSync(storage.WALLET_LOCK_PATH);
    initWith(makeSphere({ nametag: "agent" }));
    await expect(m.openGatewayWallet(cfgOf(), makeLog())).resolves.toBeTruthy();
  });

  it("closing during Sphere.init waits for it, then destroys the wallet and unlocks", async () => {
    const fake = makeSphere({ nametag: "agent" });
    const init = deferred<unknown>();
    sdk.init.mockReturnValue(init.promise);
    const opening = m.openGatewayWallet(cfgOf(), makeLog());
    const outcome = opening.then(() => "opened", (e: unknown) => e);
    await vi.waitFor(() => expect(sdk.init).toHaveBeenCalled());
    const waiter = m.waitForSphere({ timeoutMs: 200 });

    let closed = false;
    const closing = m.closeGatewayWallet().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false);
    expect(lock.readLockHolder()).not.toBeNull();

    init.resolve({ sphere: fake, created: true, generatedMnemonic: "seed words" });
    await closing;
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(sdk.registryDestroy).toHaveBeenCalledTimes(1);
    expect(lock.readLockHolder()).toBeNull();
    expect(storage.readMnemonic()).toBe("seed words");
    expect(await waiter).toBeNull();
    expect(fake.communications.sendDM).not.toHaveBeenCalled();
  });

  it("closing after the wallet is published (owner lookup pending) unpublishes and tears it down", async () => {
    const fake = makeSphere({ nametag: "agent" });
    fake.resolve.mockReturnValue(new Promise(() => {}));
    initWith(fake, { created: true });
    const opening = m.openGatewayWallet(ownerCfg({ owner: "alice" }), makeLog());
    const outcome = opening.then(() => "opened", (e: unknown) => e);
    expect(await m.waitForSphere()).toBe(fake);
    expect(storage.readGatewayStatus()).not.toBeNull();

    await m.closeGatewayWallet();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(m.getSphereOrNull()).toBeNull();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(sdk.registryDestroy).toHaveBeenCalledTimes(1);
    expect(storage.readGatewayStatus()).toBeNull();
    expect(lock.readLockHolder()).toBeNull();
    expect(fake.communications.sendDM).not.toHaveBeenCalled();
  });

  it("an open started while a close is running waits for the close to finish", async () => {
    const first = makeSphere({ nametag: "agent" });
    const destroyed = deferred<void>();
    first.destroy.mockReturnValue(destroyed.promise);
    initWith(first);
    await m.openGatewayWallet(cfgOf(), makeLog());
    const closing = m.closeGatewayWallet();

    const second = makeSphere({ nametag: "agent" });
    initWith(second);
    const reopening = m.openGatewayWallet(cfgOf(), makeLog());
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.init).toHaveBeenCalledTimes(1);

    destroyed.resolve();
    await closing;
    expect((await reopening).sphere).toBe(second);
    expect(sdk.init).toHaveBeenCalledTimes(2);
    expect(lock.readLockHolder()).toMatchObject({ pid: process.pid, role: "gateway" });
  });

  it("stop waits at most ~3 s for an open stuck in Sphere.init; the teardown then finishes in the background", async () => {
    const fake = makeSphere({ nametag: "agent" });
    const steps: string[] = [];
    fake.destroy.mockImplementation(async () => void steps.push(`destroy locked=${lock.readLockHolder() !== null}`));
    sdk.registryDestroy.mockImplementation(() => void steps.push(`registry locked=${lock.readLockHolder() !== null}`));
    const init = deferred<unknown>();
    sdk.init.mockReturnValue(init.promise);
    const log = makeLog();
    const outcome = m.openGatewayWallet(cfgOf(), log).then(() => "opened", (e: unknown) => e);
    await vi.waitFor(() => expect(sdk.init).toHaveBeenCalled());

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let closed = false;
    const closing = m.closeGatewayWallet().then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(2_900);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await closing;
    vi.useRealTimers();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("closed in the background"));
    expect(lock.readLockHolder()).toMatchObject({ pid: process.pid, role: "gateway" });
    expect(fake.destroy).not.toHaveBeenCalled();

    init.resolve({ sphere: fake, created: false });
    expect(await outcome).toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(lock.readLockHolder()).toBeNull());
    expect(steps).toEqual(["destroy locked=true", "registry locked=true"]);
  });

  it("drops a status file a crashed predecessor left behind as soon as it holds the lock", async () => {
    storage.writeGatewayStatus({ pid: 1, startedAt: 1, network: "mainnet", nametag: "old", hasPayments: true });
    const init = deferred<unknown>();
    sdk.init.mockReturnValue(init.promise);
    const opening = m.openGatewayWallet(cfgOf(), makeLog());
    await vi.waitFor(() => expect(sdk.init).toHaveBeenCalled());
    expect(lock.readLockHolder()).toMatchObject({ pid: process.pid, role: "gateway" });
    expect(storage.readGatewayStatus()).toBeNull();
    init.resolve({ sphere: makeSphere({ nametag: "agent" }), created: false });
    await opening;
    expect(storage.readGatewayStatus()).toMatchObject({ pid: process.pid, network: "testnet2", nametag: "agent" });
  });

  it("closes the wallet when its lock is taken over, keeps the new holder's status file, and a later open starts afresh", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fake = makeSphere({ nametag: "agent" });
    initWith(fake);
    const log = makeLog();
    await m.openGatewayWallet(cfgOf(), log);
    const thief = { token: "thief", pid: process.pid + 1, host: hostname(), role: "gateway", acquiredAt: Date.now() };
    writeFileSync(storage.WALLET_LOCK_PATH, JSON.stringify(thief));
    storage.writeGatewayStatus({ pid: thief.pid, startedAt: Date.now(), network: "testnet2", nametag: "thief", hasPayments: true });

    vi.advanceTimersByTime(5_000);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Wallet lock lost"));
    await vi.waitFor(() => expect(fake.destroy).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sdk.registryDestroy).toHaveBeenCalledTimes(1));
    expect(m.getSphereOrNull()).toBeNull();
    expect(JSON.parse(readFileSync(storage.WALLET_LOCK_PATH, "utf8"))).toMatchObject({ token: "thief" });
    // The status file now belongs to the new holder: the teardown must leave it alone.
    expect(storage.readGatewayStatus()).toMatchObject({ pid: thief.pid, nametag: "thief" });

    rmSync(storage.WALLET_LOCK_PATH);
    const second = makeSphere({ nametag: "agent" });
    initWith(second);
    expect((await m.openGatewayWallet(cfgOf(), makeLog())).sphere).toBe(second);
  });
});

describe("network shims", () => {
  it("gives every wallet-api fetch a timeout signal, combined with any caller signal", async () => {
    initWith(makeSphere({ nametag: "agent" }));
    await m.openGatewayWallet(cfgOf(), makeLog());
    const fetchFn = providers.createWalletApiProviders.mock.calls[0][1].fetchFn as (u: string, i?: RequestInit) => Promise<unknown>;
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchFn("https://wallet-api.unicity.network/v1/inventory", { method: "GET" });
    await fetchFn("https://bucket.s3.example/blob?sig=1", { method: "PUT", body: "x" });
    const ac = new AbortController();
    await fetchFn("https://wallet-api.unicity.network/v1/x", { method: "POST", signal: ac.signal });

    const inits = fetchMock.mock.calls.map((c) => (c as unknown as [string, RequestInit])[1]);
    expect(inits[0]).toMatchObject({ method: "GET", signal: expect.any(AbortSignal) });
    expect(inits[1]).toMatchObject({ method: "PUT", body: "x", signal: expect.any(AbortSignal) });
    expect(inits[2].signal).not.toBe(ac.signal);
    ac.abort();
    expect(inits[2].signal!.aborted).toBe(true);
  });

  it("holds the wake socket's open and early frames until the inbox is attached", async () => {
    const sockets: FakeWs[] = [];
    class FakeWs {
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onclose: ((ev: { code: number }) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      close = vi.fn();
      constructor(readonly url: string) {
        sockets.push(this);
      }
    }
    vi.stubGlobal("WebSocket", FakeWs);
    const fake = makeSphere({ nametag: "agent" });
    const seen: string[] = [];
    sdk.init.mockImplementation(async (opts: { walletApi: { composed: { webSocketFactory: (u: string) => any } } }) => {
      const ws = opts.walletApi.composed.webSocketFactory("wss://wallet-api.unicity.network/v1/ws?ticket=t");
      ws.onopen = () => seen.push(`open listeners=${fake.listenerCount("transfer:incoming")}`);
      ws.onmessage = (ev: { data: unknown }) => seen.push(`msg ${String(ev.data)}`);
      sockets[0].onopen!();
      sockets[0].onmessage!({ data: "wake-1" });
      const dropped = opts.walletApi.composed.webSocketFactory("wss://wallet-api.unicity.network/v1/ws?ticket=u");
      dropped.onopen = () => seen.push("dropped socket opened");
      dropped.onclose = () => seen.push("dropped socket closed");
      sockets[1].onopen!();
      sockets[1].onclose!({ code: 1006 });
      expect(seen).toEqual(["dropped socket closed"]);
      return { sphere: fake, created: false };
    });

    await m.openGatewayWallet(cfgOf(), makeLog());
    expect(seen).toEqual(["dropped socket closed", "open listeners=1", "msg wake-1"]);
    sockets[0].onmessage!({ data: "wake-2" });
    expect(seen.at(-1)).toBe("msg wake-2");
  });
});

describe("event gate", () => {
  type FetchFn = (u: string, i?: RequestInit) => Promise<Response>;
  type InitOpts = { walletApi: { composed: { fetchFn: FetchFn; webSocketFactory: (u: string) => { close(): void } } } };

  it("holds mailbox and payment-request listings until the inbox is attached; other requests pass at once", async () => {
    const fake = makeSphere({ nametag: "agent" });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      fetched.push(`${init?.method} ${new URL(url).pathname} listeners=${fake.listenerCount("transfer:incoming")}`);
      return new Response("{}");
    }));
    let held: Array<Promise<Response>> = [];
    sdk.init.mockImplementation(async ({ walletApi: { composed: { fetchFn } } }: InitOpts) => {
      held = [
        fetchFn("https://wallet-api.unicity.network/v1/mailbox?since=0", { method: "GET" }),
        fetchFn("https://wallet-api.unicity.network/v1/payment-requests?role=incoming&since=0", { method: "GET" }),
      ];
      await fetchFn("https://wallet-api.unicity.network/v1/inventory", { method: "GET" });
      await fetchFn("https://wallet-api.unicity.network/v1/mailbox/claim", { method: "POST", body: "{}" });
      await new Promise((r) => setTimeout(r, 20));
      return { sphere: fake, created: false };
    });

    await m.openGatewayWallet(cfgOf(), makeLog());
    await Promise.all(held);
    expect(fetched.slice(0, 2)).toEqual(["GET /v1/inventory listeners=0", "POST /v1/mailbox/claim listeners=0"]);
    expect(fetched.slice(2).sort()).toEqual(["GET /v1/mailbox listeners=1", "GET /v1/payment-requests listeners=1"]);
  });

  it("matches the listings under a wallet-api base path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const order: string[] = [];
    sdk.init.mockImplementation(async ({ walletApi: { composed: { fetchFn } } }: InitOpts) => {
      void fetchFn("https://wallet.example/api/v1/mailbox", { method: "GET" }).then(() => order.push("mailbox"));
      await new Promise((r) => setTimeout(r, 20));
      order.push("init done");
      return { sphere: makeSphere({ nametag: "agent" }), created: false };
    });
    await m.openGatewayWallet(cfgOf({ network: "mainnet", apiKey: "sk", walletApiUrl: "https://wallet.example/api/" }), makeLog());
    await vi.waitFor(() => expect(order).toEqual(["init done", "mailbox"]));
  });

  it("lets held listings go when the SDK stops its session, so a failing init's teardown cannot deadlock on them", async () => {
    vi.stubGlobal("WebSocket", class {
      onopen = null;
      onmessage = null;
      onclose = null;
      onerror = null;
      close = vi.fn();
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    sdk.init.mockImplementation(async ({ walletApi: { composed: { fetchFn, webSocketFactory } } }: InitOpts) => {
      const ws = webSocketFactory("wss://wallet-api.unicity.network/v1/ws?ticket=t");
      const drain = fetchFn("https://wallet-api.unicity.network/v1/mailbox", { method: "GET" });
      ws.close(); // session.stop() in Sphere.destroy(), which then waits for in-flight drains
      await drain;
      throw new Error("init failed");
    });
    await expect(m.openGatewayWallet(cfgOf(), makeLog())).rejects.toThrow("init failed");
  });

  it("holds a listing for 60 s at most", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    let done = false;
    sdk.init.mockImplementation(async ({ walletApi: { composed: { fetchFn } } }: InitOpts) => {
      await fetchFn("https://wallet-api.unicity.network/v1/payment-requests?since=0", { method: "GET" });
      done = true;
      return { sphere: makeSphere({ nametag: "agent" }), created: false };
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const opening = m.openGatewayWallet(cfgOf(), makeLog());
    await vi.advanceTimersByTimeAsync(59_000);
    expect(sdk.init).toHaveBeenCalled();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await opening;
    expect(done).toBe(true);
  });

  it("lets held listings through when the open fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    let held: Promise<Response> | undefined;
    sdk.init.mockImplementation(async ({ walletApi: { composed: { fetchFn } } }: InitOpts) => {
      held = fetchFn("https://wallet-api.unicity.network/v1/mailbox", { method: "GET" });
      throw new Error("init failed");
    });
    await expect(m.openGatewayWallet(cfgOf(), makeLog())).rejects.toThrow("init failed");
    await expect(held).resolves.toBeInstanceOf(Response);
  });
});

describe("wallet event inbox", () => {
  async function openWith(fake: FakeSphere) {
    initWith(fake);
    await m.openGatewayWallet(cfgOf(), makeLog());
  }

  it("buffers events until a consumer subscribes, replays them FIFO, then delivers live", async () => {
    const fake = makeSphere({ nametag: "agent" });
    await openWith(fake);
    fake.emit("transfer:incoming", { id: "t1" });
    fake.emit("payment_request:incoming", { id: "r1" });
    fake.emit("transfer:incoming", { id: "t2" });

    const got: string[] = [];
    const h = { onTransfer: (t: { id: string }) => got.push(`T:${t.id}`), onPaymentRequest: (r: { id: string }) => got.push(`R:${r.id}`) };
    m.subscribeWalletEvents(h as never);
    expect(got).toEqual(["T:t1", "R:r1", "T:t2"]);
    fake.emit("transfer:incoming", { id: "t3" });
    expect(got).toEqual(["T:t1", "R:r1", "T:t2", "T:t3"]);
  });

  it("keeps FIFO order for events emitted while a handler runs", async () => {
    const fake = makeSphere({ nametag: "agent" });
    await openWith(fake);
    fake.emit("transfer:incoming", { id: "t1" });
    fake.emit("transfer:incoming", { id: "t2" });
    const got: string[] = [];
    m.subscribeWalletEvents({
      onTransfer: (t: { id: string }) => {
        got.push(t.id);
        if (t.id === "t1") fake.emit("transfer:incoming", { id: "t3" });
      },
      onPaymentRequest: () => {},
    } as never);
    expect(got).toEqual(["t1", "t2", "t3"]);
  });

  it("has one consumer at a time: a new subscription replaces the old one", async () => {
    const fake = makeSphere({ nametag: "agent" });
    await openWith(fake);
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = m.subscribeWalletEvents({ onTransfer: (t: { id: string }) => a.push(t.id), onPaymentRequest: () => {} } as never);
    const unsubB = m.subscribeWalletEvents({ onTransfer: (t: { id: string }) => b.push(t.id), onPaymentRequest: () => {} } as never);
    fake.emit("transfer:incoming", { id: "t1" });
    unsubA();
    fake.emit("transfer:incoming", { id: "t2" });
    expect(a).toEqual([]);
    expect(b).toEqual(["t1", "t2"]);

    unsubB();
    fake.emit("transfer:incoming", { id: "t3" });
    const c: string[] = [];
    m.subscribeWalletEvents({ onTransfer: (t: { id: string }) => c.push(t.id), onPaymentRequest: () => {} } as never);
    expect(c).toEqual(["t3"]);
  });

  it("isolates handler failures (sync and async)", async () => {
    const fake = makeSphere({ nametag: "agent" });
    const log = makeLog();
    initWith(fake);
    await m.openGatewayWallet(cfgOf(), log);
    const got: string[] = [];
    m.subscribeWalletEvents({
      onTransfer: (t: { id: string }) => {
        got.push(t.id);
        throw new Error("boom");
      },
      onPaymentRequest: async () => {
        throw new Error("async boom");
      },
    } as never);
    fake.emit("transfer:incoming", { id: "t1" });
    fake.emit("payment_request:incoming", { id: "r1" });
    fake.emit("transfer:incoming", { id: "t2" });
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual(["t1", "t2"]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("async boom"));
  });

  it("detaches on close and drops undelivered events", async () => {
    const fake = makeSphere({ nametag: "agent" });
    const log = makeLog();
    initWith(fake);
    await m.openGatewayWallet(cfgOf(), log);
    fake.emit("transfer:incoming", { id: "t1" });
    await m.closeGatewayWallet();
    expect(fake.listenerCount("transfer:incoming")).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("1 undelivered wallet event"));
    const got: string[] = [];
    m.subscribeWalletEvents({ onTransfer: (t: { id: string }) => got.push(t.id), onPaymentRequest: () => {} } as never);
    expect(got).toEqual([]);
  });
});

describe("nametag handling", () => {
  async function openWithNametag(fake: FakeSphere, nametag: string | undefined, log = makeLog()) {
    initWith(fake);
    await m.openGatewayWallet(cfgOf({ nametag }), log);
    return log;
  }

  it("registers the configured nametag when the wallet has none", async () => {
    const fake = makeSphere();
    await openWithNametag(fake, "Agent");
    expect(fake.registerNametag).toHaveBeenCalledWith("agent");
    expect(fake.switchToAddress).not.toHaveBeenCalled();
    expect(storage.readGatewayStatus()).toMatchObject({ nametag: "agent" });
  });

  it("does nothing when the wallet already has it (case-insensitive)", async () => {
    const fake = makeSphere({ nametag: "@agent" });
    await openWithNametag(fake, "AGENT");
    expect(fake.registerNametag).not.toHaveBeenCalled();
    expect(fake.switchToAddress).not.toHaveBeenCalled();
  });

  it("switches to the tracked address that already owns the nametag", async () => {
    const fake = makeSphere({
      tracked: [
        { index: 0, addressId: "DIRECT_aaaaaa_bbbbbb", chainPubkey: CHAIN, directAddress: "DIRECT://00", nametag: "agent", hidden: false },
        { index: 1, addressId: "DIRECT_cccccc_dddddd", chainPubkey: `03${X}`, directAddress: "DIRECT://01", nametag: "other", hidden: false },
      ],
      nametag: "agent",
    });
    await openWithNametag(fake, "other");
    expect(fake.switchToAddress).toHaveBeenCalledWith(1);
    expect(fake.registerNametag).not.toHaveBeenCalled();
  });

  it("registers a new nametag on a fresh address after an availability check", async () => {
    const fake = makeSphere({ nametag: "agent" });
    const log = await openWithNametag(fake, "newbot");
    expect(fake.isNametagAvailable).toHaveBeenCalledWith("newbot");
    expect(fake.switchToAddress).toHaveBeenCalledWith(1);
    expect(fake.switchToAddress.mock.calls[0]).toHaveLength(1);
    expect(fake.registerNametag).toHaveBeenCalledWith("newbot");
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Switched to address 1 with nametag @newbot"));
  });

  it("keeps the current address when the new nametag is taken", async () => {
    const fake = makeSphere({ nametag: "agent" });
    fake.isNametagAvailable.mockResolvedValue(false);
    const log = await openWithNametag(fake, "taken");
    expect(fake.switchToAddress).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("@taken is taken"));
  });

  it("switches back when registering on the fresh address fails", async () => {
    const fake = makeSphere({ nametag: "agent" });
    fake.registerNametag.mockRejectedValueOnce(new Error("relay rejected"));
    const log = await openWithNametag(fake, "newbot");
    expect(fake.switchToAddress.mock.calls).toEqual([[1], [0]]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("switching back to address 0"));
  });

  it("reuses the fresh address of a failed registration instead of tracking another one each start", async () => {
    const fake = makeSphere({ nametag: "agent" });
    fake.registerNametag.mockRejectedValue(new Error("relay rejected"));
    await openWithNametag(fake, "newbot");
    await m.closeGatewayWallet();
    await openWithNametag(fake, "newbot");
    expect(fake.switchToAddress.mock.calls).toEqual([[1], [0], [1], [0]]);
    expect(fake.kv.get("openclaw_nametag_attempt_index")).toBe("1");
    await m.closeGatewayWallet();

    fake.registerNametag.mockResolvedValue(undefined);
    await openWithNametag(fake, "newbot");
    expect(fake.switchToAddress.mock.calls.at(-1)).toEqual([1]);
    expect(fake.kv.has("openclaw_nametag_attempt_index")).toBe(false);
  });

  it("does not reuse a remembered address that got a nametag meanwhile", async () => {
    const fake = makeSphere({
      nametag: "agent",
      tracked: [
        { index: 0, addressId: "DIRECT_aaaaaa_bbbbbb", chainPubkey: CHAIN, directAddress: "DIRECT://00", nametag: "agent", hidden: false },
        { index: 1, addressId: "DIRECT_cccccc_dddddd", chainPubkey: `03${X}`, directAddress: "DIRECT://01", nametag: "other", hidden: false },
      ],
      storage: { openclaw_nametag_attempt_index: "1" },
    });
    await openWithNametag(fake, "newbot");
    expect(fake.switchToAddress).toHaveBeenCalledWith(2);
  });

  it("logs and continues when registration fails on the current address", async () => {
    const fake = makeSphere();
    fake.registerNametag.mockRejectedValueOnce(new Error("VALIDATION_ERROR"));
    const log = await openWithNametag(fake, "agent");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to register nametag @agent: VALIDATION_ERROR"));
    expect(m.getSphereOrNull()).toBe(fake);
  });

  it("asks for setup when no nametag is configured or present", async () => {
    const log = await openWithNametag(makeSphere(), undefined);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("openclaw unicity setup"));
  });
});

describe("owner resolution and greeting", () => {
  it("greets a hex owner on first creation", async () => {
    const fake = makeSphere({ nametag: "agent" });
    initWith(fake, { created: true });
    const log = makeLog();
    await m.openGatewayWallet(ownerCfg({ owner: `03${X}` }), log);
    expect(fake.communications.sendDM).toHaveBeenCalledWith(X, "I'm online, master! I am @agent. What can I do for you?");
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("[unicity] Greeting sent to"));
  });

  it("resolves and pins a nametag owner, then greets the pinned key", async () => {
    const fake = makeSphere({ nametag: "agent" });
    fake.resolve.mockResolvedValue({ transportPubkey: X, chainPubkey: `02${X}`, directAddress: "DIRECT://01", timestamp: 0 });
    initWith(fake, { created: true });
    const log = makeLog();
    await m.openGatewayWallet(ownerCfg({ owner: "@Alice" }, log), log);
    expect(fake.resolve).toHaveBeenCalledWith("@alice");
    expect(fake.communications.sendDM).toHaveBeenCalledWith(X, expect.any(String));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining(`Owner @alice pinned to ${X}`));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("[unicity] Greeting sent to @alice ("));
  });

  it("says why it skips the greeting when the nametag owner did not resolve", async () => {
    const fake = makeSphere({ nametag: "agent" });
    initWith(fake, { created: true });
    const log = makeLog();
    await m.openGatewayWallet(ownerCfg({ owner: "alice" }), log);
    expect(fake.communications.sendDM).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Owner @alice has no pinned key yet; skipping the greeting"));
  });

  it("uses only the OwnerAuthority set by the entry point, never one of its own from the config", async () => {
    const fake = makeSphere({ nametag: "agent" });
    initWith(fake, { created: true });
    const log = makeLog();
    identity.setOwnerAuthority(new identity.OwnerAuthority({ ownerPubkeys: [Y], log }));
    await m.openGatewayWallet(cfgOf({ owner: `03${X}` }), log);
    expect(fake.communications.sendDM).toHaveBeenCalledWith(Y, expect.any(String));
  });

  it("skips owner resolution and the greeting when no OwnerAuthority is set", async () => {
    const fake = makeSphere({ nametag: "agent" });
    initWith(fake, { created: true });
    await m.openGatewayWallet(cfgOf({ owner: "alice" }), makeLog());
    expect(identity.getOwnerAuthority()).toBeNull();
    expect(fake.resolve).not.toHaveBeenCalled();
    expect(fake.communications.sendDM).not.toHaveBeenCalled();
  });

  it("does not greet an existing wallet or an unknown owner, and survives a failed greeting", async () => {
    const existing = makeSphere({ nametag: "agent" });
    initWith(existing);
    await m.openGatewayWallet(ownerCfg({ owner: X }), makeLog());
    expect(existing.communications.sendDM).not.toHaveBeenCalled();
    await m.closeGatewayWallet();

    const noOwner = makeSphere({ nametag: "agent" });
    initWith(noOwner, { created: true });
    await m.openGatewayWallet(ownerCfg({}), makeLog());
    expect(noOwner.communications.sendDM).not.toHaveBeenCalled();
    await m.closeGatewayWallet();

    const failing = makeSphere({ nametag: "agent" });
    failing.communications.sendDM.mockRejectedValue(new Error("relay down"));
    initWith(failing, { created: true });
    const log = makeLog();
    await expect(m.openGatewayWallet(ownerCfg({ owner: X }), log)).resolves.toMatchObject({ created: true });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to send greeting"));
  });
});

describe("waitForSphere / getSphereOrNull / getDmCutoff", () => {
  it("has no wallet and no DM cutoff before the wallet is opened", () => {
    expect(m.getSphereOrNull()).toBeNull();
    expect(m.getDmCutoff()).toBeNull();
  });

  it("records the DM cutoff once, floored to the second, and keeps it across failed opens, closes and reopens", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_750 });
    sdk.init.mockRejectedValueOnce(new Error("relay down"));
    await expect(m.openGatewayWallet(cfgOf(), makeLog())).rejects.toThrow("relay down");
    expect(m.getDmCutoff()).toBe(1_700_000_000_000);

    vi.setSystemTime(1_700_000_030_000);
    initWith(makeSphere({ nametag: "agent" }));
    await m.openGatewayWallet(cfgOf(), makeLog());
    expect(m.getDmCutoff()).toBe(1_700_000_000_000);

    await m.closeGatewayWallet();
    expect(m.getDmCutoff()).toBe(1_700_000_000_000);
    vi.setSystemTime(1_700_000_060_000);
    await m.openGatewayWallet(cfgOf(), makeLog());
    expect(m.getDmCutoff()).toBe(1_700_000_000_000);
  });

  it("keeps the DM cutoff across a plugin reload: wallet closed, modules re-imported, the same wallet reopened", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
    initWith(makeSphere({ nametag: "agent" }));
    await m.openGatewayWallet(cfgOf(), makeLog());
    await m.closeGatewayWallet();

    vi.setSystemTime(1_700_000_045_000);
    vi.resetModules();
    const reloaded = await import("../src/sphere.js");
    expect(reloaded.getDmCutoff()).toBe(1_700_000_000_000);
    initWith(makeSphere({ nametag: "agent" }));
    await reloaded.openGatewayWallet(cfgOf(), makeLog());
    expect(reloaded.getDmCutoff()).toBe(1_700_000_000_000);
    await reloaded.closeGatewayWallet();
  });

  it("gives another wallet, another address or another network a DM cutoff of its own", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
    initWith(makeSphere({ nametag: "agent" }));
    await m.openGatewayWallet(cfgOf(), makeLog());
    await m.closeGatewayWallet();

    vi.setSystemTime(1_700_000_010_000);
    initWith(makeSphere({ nametag: "agent", chainPubkey: `03${Y}` }));
    await m.openGatewayWallet(cfgOf(), makeLog());
    expect(m.getDmCutoff()).toBe(1_700_000_010_000);
    await m.closeGatewayWallet();

    // The configured nametag lives on another address: the cutoff belongs to the address the wallet runs on.
    vi.setSystemTime(1_700_000_020_000);
    const tracked = [
      { index: 0, addressId: "DIRECT_a", chainPubkey: `03${Y}`, directAddress: "DIRECT://0a", nametag: "old", hidden: false },
      { index: 1, addressId: "DIRECT_b", chainPubkey: `03${"1".padStart(64, "0")}`, directAddress: "DIRECT://01", nametag: "agent", hidden: false },
    ];
    initWith(makeSphere({ nametag: "old", chainPubkey: `03${Y}`, tracked }));
    await m.openGatewayWallet(cfgOf(), makeLog());
    expect(m.getDmCutoff()).toBe(1_700_000_020_000);
    await m.closeGatewayWallet();

    vi.setSystemTime(1_700_000_030_000);
    initWith(makeSphere({ nametag: "agent", chainPubkey: tracked[1].chainPubkey }));
    await m.openGatewayWallet(cfgOf({ network: "mainnet" }), makeLog());
    expect(m.getDmCutoff()).toBe(1_700_000_030_000);
  });

  it("raises the cutoff of the open wallet past DMs a disabled start ignored, and keeps that across a plugin reload", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
    const fake = makeSphere({ nametag: "agent" });
    initWith(fake);
    await m.openGatewayWallet(cfgOf(), makeLog());

    m.ignoreDmsBefore(makeSphere({ chainPubkey: `03${Y}` }) as unknown as Sphere, 1_700_000_090_000);
    expect(m.getDmCutoff()).toBe(1_700_000_000_000);
    m.ignoreDmsBefore(fake as unknown as Sphere, 1_700_000_050_000);
    expect(m.getDmCutoff()).toBe(1_700_000_050_000);
    m.ignoreDmsBefore(fake as unknown as Sphere, 1_700_000_040_000);
    expect(m.getDmCutoff()).toBe(1_700_000_050_000);

    await m.closeGatewayWallet();
    vi.resetModules();
    const reloaded = await import("../src/sphere.js");
    initWith(makeSphere({ nametag: "agent" }));
    await reloaded.openGatewayWallet(cfgOf(), makeLog());
    expect(reloaded.getDmCutoff()).toBe(1_700_000_050_000);
    await reloaded.closeGatewayWallet();
  });

  it("resolves once the wallet is published, null on abort or timeout", async () => {
    const ac = new AbortController();
    const aborted = m.waitForSphere({ signal: ac.signal });
    const timedOut = m.waitForSphere({ timeoutMs: 10 });
    const waiting = m.waitForSphere();
    ac.abort();
    expect(await aborted).toBeNull();
    expect(await timedOut).toBeNull();
    expect(await m.waitForSphere({ signal: ac.signal })).toBeNull();

    const fake = makeSphere({ nametag: "agent" });
    initWith(fake);
    await m.openGatewayWallet(cfgOf(), makeLog());
    expect(await waiting).toBe(fake);
    expect(await m.waitForSphere({ timeoutMs: 1 })).toBe(fake);
  });

  it("publishes the wallet before owner resolution finishes", async () => {
    const fake = makeSphere({ nametag: "agent" });
    const lookup = deferred<unknown>();
    fake.resolve.mockReturnValue(lookup.promise);
    initWith(fake, { created: true });
    const opening = m.openGatewayWallet(ownerCfg({ owner: "alice" }), makeLog());
    expect(await m.waitForSphere()).toBe(fake);
    expect(fake.communications.sendDM).not.toHaveBeenCalled();
    lookup.resolve({ transportPubkey: X, chainPubkey: `02${X}`, directAddress: "D", timestamp: 0 });
    await opening;
    expect(fake.communications.sendDM).toHaveBeenCalledWith(X, expect.any(String));
  });
});

describe("getNameVerifier", () => {
  const binding = { transportPubkey: X, chainPubkey: `02${X}`, directAddress: "D", timestamp: 0 };

  it("is one verifier for every caller, looking names up through the open wallet, so one lookup serves them all", async () => {
    const names = m.getNameVerifier();
    expect(m.getNameVerifier()).toBe(names);
    // No wallet open: nothing to look the name up with, so the claim stays unverified.
    expect(await names.verify("alice", X)).toEqual({ claimed: "alice" });

    const fake = makeSphere({ nametag: "agent" });
    fake.resolve.mockImplementation(async (id: string) => (id === "@alice" ? binding : null));
    initWith(fake);
    await m.openGatewayWallet(cfgOf(), makeLog());
    expect(await m.getNameVerifier().verify("alice", X)).toEqual({ verified: "alice" });
    expect(await m.getNameVerifier().verify("@Alice", `02${X}`)).toEqual({ verified: "alice" });
    expect(await m.getNameVerifier().verify("alice", Y)).toEqual({ claimed: "alice" });
    expect(m.getNameVerifier().label({ verified: "alice" }, X)).toBe("@alice");
    expect(fake.resolve).toHaveBeenCalledTimes(1);
    expect(m.getNameVerifier()).toBe(m.getNameVerifier());
  });

  it("starts afresh for each wallet opened: a lookup that failed through an earlier wallet is not reused", async () => {
    const first = makeSphere({ nametag: "agent" });
    first.resolve.mockRejectedValue(new Error("transport closed"));
    initWith(first);
    await m.openGatewayWallet(cfgOf(), makeLog());
    expect(await m.getNameVerifier().verify("alice", X)).toEqual({ claimed: "alice" });
    await m.closeGatewayWallet();

    const second = makeSphere({ nametag: "agent" });
    second.resolve.mockResolvedValue(binding);
    initWith(second);
    await m.openGatewayWallet(cfgOf(), makeLog());
    expect(await m.getNameVerifier().verify("alice", X)).toEqual({ verified: "alice" });
    expect(second.resolve).toHaveBeenCalledWith("@alice");
  });
});

describe("openCliWallet", () => {
  it("opens messaging-only under a cli lock and closes completely", async () => {
    const fake = makeSphere({ nametag: "agent" });
    initWith(fake, { created: true, generatedMnemonic: "cli seed" });
    const w = await m.openCliWallet(cfgOf(), makeLog(), "send");

    expect(providers.createWalletApiProviders).not.toHaveBeenCalled();
    expect(sdk.init.mock.calls[0][0]).toMatchObject({ network: "testnet2", walletApi: "none", groupChat: false, autoGenerate: true });
    expect(lock.readLockHolder()).toMatchObject({ role: "cli", command: "send", pid: process.pid });
    expect(storage.readMnemonic()).toBe("cli seed");
    expect(m.getSphereOrNull()).toBeNull();

    await Promise.all([w.close(), w.close()]);
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(sdk.registryDestroy).toHaveBeenCalledTimes(1);
    expect(lock.readLockHolder()).toBeNull();
  });

  it("refuses fast while the gateway holds the wallet", async () => {
    initWith(makeSphere({ nametag: "agent" }));
    await m.openGatewayWallet(cfgOf(), makeLog());
    const err = await m.openCliWallet(cfgOf(), makeLog(), "listen").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(lock.WalletLockedError);
    expect((err as InstanceType<LockModule["WalletLockedError"]>).holder).toMatchObject({ role: "gateway" });
    expect(sdk.init).toHaveBeenCalledTimes(1);
  });

  it("applies the configured nametag only for init; other commands warn and leave the wallet as it is", async () => {
    for (const command of ["status", "send", "listen"]) {
      const fake = makeSphere({ nametag: "agent" });
      initWith(fake);
      const log = makeLog();
      const w = await m.openCliWallet(cfgOf({ nametag: "newbot" }), log, command);
      expect(fake.registerNametag).not.toHaveBeenCalled();
      expect(fake.switchToAddress).not.toHaveBeenCalled();
      expect(fake.isNametagAvailable).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Config nametag @newbot differs from the wallet's (@agent)"));
      await w.close();
    }
    const fake = makeSphere({ nametag: "agent" });
    initWith(fake);
    const w = await m.openCliWallet(cfgOf({ nametag: "newbot" }), makeLog(), "init");
    expect(fake.switchToAddress).toHaveBeenCalledWith(1);
    expect(fake.registerNametag).toHaveBeenCalledWith("newbot");
    await w.close();
  });

  it("releases everything when Sphere.init fails", async () => {
    sdk.init.mockRejectedValueOnce(new Error("corrupt"));
    await expect(m.openCliWallet(cfgOf(), makeLog(), "init")).rejects.toThrow("corrupt");
    expect(sdk.registryDestroy).toHaveBeenCalledTimes(1);
    expect(lock.readLockHolder()).toBeNull();
  });

  describe("lock loss", () => {
    const thief = () => ({ token: "thief", pid: process.pid + 1, host: hostname(), role: "gateway", acquiredAt: Date.now() });
    const takeOver = () => {
      writeFileSync(storage.WALLET_LOCK_PATH, JSON.stringify(thief()));
      vi.advanceTimersByTime(5_000); // the holder's next heartbeat notices
    };

    beforeEach(() => void vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }));

    it("closes an open wallet when its lock is taken over, and leaves the new holder's lock alone", async () => {
      const fake = makeSphere({ nametag: "agent" });
      initWith(fake);
      const log = makeLog();
      const w = await m.openCliWallet(cfgOf(), log, "listen");

      takeOver();
      await vi.waitFor(() => expect(fake.destroy).toHaveBeenCalledTimes(1));
      expect(await w.lost).toMatch(/taken over/);
      expect(sdk.registryDestroy).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Wallet lock lost"));
      expect(JSON.parse(readFileSync(storage.WALLET_LOCK_PATH, "utf8"))).toMatchObject({ token: "thief" });

      await w.close();
      expect(fake.destroy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(storage.WALLET_LOCK_PATH, "utf8"))).toMatchObject({ token: "thief" });
    });

    it("fails an open whose lock is lost during Sphere.init, destroying the wallet init returns before it writes", async () => {
      const fake = makeSphere({ nametag: "agent", mnemonic: "late seed" });
      const init = deferred<unknown>();
      sdk.init.mockReturnValue(init.promise);
      const opening = m.openCliWallet(cfgOf(), makeLog(), "send").catch((e: unknown) => e);
      await vi.waitFor(() => expect(sdk.init).toHaveBeenCalled());

      takeOver();
      init.resolve({ sphere: fake, created: false });
      const err = await opening;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Wallet lock lost while opening the wallet \(.*taken over/);
      expect(fake.destroy).toHaveBeenCalledTimes(1);
      expect(sdk.registryDestroy).toHaveBeenCalledTimes(1);
      expect(storage.readMnemonic()).toBeUndefined(); // no mnemonic backup written next to the new holder
      expect(JSON.parse(readFileSync(storage.WALLET_LOCK_PATH, "utf8"))).toMatchObject({ token: "thief" });
    });

    it("fails an init whose lock is lost while the nametag is being registered", async () => {
      const fake = makeSphere({ nametag: "agent" });
      const registering = deferred<void>();
      fake.registerNametag.mockImplementation(() => registering.promise);
      initWith(fake);
      const opening = m.openCliWallet(cfgOf({ nametag: "newbot" }), makeLog(), "init").catch((e: unknown) => e);
      await vi.waitFor(() => expect(fake.registerNametag).toHaveBeenCalled());

      takeOver();
      expect(fake.destroy).not.toHaveBeenCalled(); // the registration in flight settles first
      registering.resolve();
      expect(((await opening) as Error).message).toMatch(/Wallet lock lost while opening/);
      expect(fake.destroy).toHaveBeenCalledTimes(1);
    });
  });
});

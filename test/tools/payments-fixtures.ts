/** Shared fakes for the payment tool tests: a testnet2-shaped token registry, in-memory storage, a fake Sphere, SDK errors. */

import { vi } from "vitest";

export const UCT = "f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0";
export const USDU = "e210f989".padEnd(64, "1");
export const BTC = "3cc412d8".padEnd(64, "2");
export const SNAKE = "7fc5d3a3".padEnd(64, "3");
export const USDCE = "eae95405".padEnd(64, "4");
export const NFT_TYPE = "971a26ee".padEnd(64, "5");

type Def = {
  network: string;
  assetKind: "fungible" | "non-fungible";
  name: string;
  symbol?: string;
  decimals?: number;
  description: string;
  id: string;
  issuance?: { tokenType: string };
};

const fungible = (id: string, symbol: string, name: string, decimals: number, extra?: Partial<Def>): Def =>
  ({ network: "unicity:testnet", assetKind: "fungible", name, symbol, decimals, description: name, id, ...extra });

export const TESTNET2_DEFS: Def[] = [
  fungible(UCT, "UCT", "unicity", 18),
  fungible(USDU, "USDU", "unicity-usd", 6),
  fungible(BTC, "BTC", "bitcoin", 8),
  fungible(SNAKE, "SNAKE", "snake", 0),
  fungible(USDCE, "USDC.e", "usd-coin-bridged", 6, { issuance: { tokenType: "2ccbf315".padEnd(64, "6") } }),
  { network: "unicity:testnet", assetKind: "non-fungible", name: "unicity-nft", description: "nft", id: NFT_TYPE },
];

/** Mutable registry state the fake root exports read. */
export const registry = { ready: true, defs: TESTNET2_DEFS as Def[] };

export function resetRegistry(): void {
  registry.ready = true;
  registry.defs = TESTNET2_DEFS;
}

const byId = (id: string) => registry.defs.find((d) => d.id === id.toLowerCase());

/** Replacement for the SDK's process-global registry readers (spread over the real root module). */
export const registryExports = {
  TokenRegistry: {
    waitForReady: vi.fn(async () => registry.ready),
    getInstance: () => ({ getFungibleTokens: () => (registry.ready ? registry.defs.filter((d) => d.assetKind === "fungible") : []) }),
  },
  getTokenDefinition: (id: string) => (registry.ready ? byId(id) : undefined),
  getCoinIdBySymbol: (s: string) => (registry.ready ? registry.defs.find((d) => d.symbol?.toUpperCase() === s.toUpperCase())?.id : undefined),
  getCoinIdByName: (n: string) => (registry.ready ? registry.defs.find((d) => d.name.toLowerCase() === n.toLowerCase())?.id : undefined),
  getTokenDecimals: (id: string) => (registry.ready ? byId(id)?.decimals ?? 0 : 0),
  getTokenSymbol: (id: string) => (registry.ready ? byId(id)?.symbol : undefined) ?? id.slice(0, 6).toUpperCase(),
  getTokenName: (id: string) => (registry.ready ? byId(id)?.name : undefined) ?? id,
};

/** In-memory replacement for src/storage.js JSON helpers. `failReads` makes every read fail like the file system would. */
export const memFiles = new Map<string, string>();
export const storageControl: { failWrites: boolean; failReads: "EIO" | "EACCES" | null; resolved: boolean } = {
  failWrites: false,
  failReads: null,
  resolved: false,
};

function readFailure(path: string): Error | null {
  if (!storageControl.failReads) return null;
  return Object.assign(new Error(`${storageControl.failReads}: cannot read ${path}`), { code: storageControl.failReads });
}

/** Fixed in-memory file paths, for tests that seed or inspect files directly. */
export const MEM_LEDGER_PATH = "/mem/payment-ledger.json";
export const MEM_OUTGOING_REQUESTS_PATH = "/mem/outgoing-requests.json";
export const MEM_OWNER_PIN_PATH = "/mem/owner-pin.json";

/** Like the real storage module: the path exports stay empty until the data dir is resolved (live ESM bindings). */
export const storageExports = {
  get LEDGER_PATH() {
    return storageControl.resolved ? MEM_LEDGER_PATH : "";
  },
  get OUTGOING_REQUESTS_PATH() {
    return storageControl.resolved ? MEM_OUTGOING_REQUESTS_PATH : "";
  },
  get OWNER_PIN_PATH() {
    return storageControl.resolved ? MEM_OWNER_PIN_PATH : "";
  },
  resolveDataDir(): string {
    storageControl.resolved = true;
    return "/mem";
  },
  readJsonFile<T>(path: string, fallback: T): T {
    const raw = memFiles.get(path);
    if (raw === undefined || readFailure(path)) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  /** Like the real one: fallback only for a missing file; read and parse errors throw. */
  readJsonFileStrict<T>(path: string, fallback: T): T {
    if (!path) throw new Error("storage path used before the data dir was resolved");
    const failure = readFailure(path);
    if (failure) throw failure;
    const raw = memFiles.get(path);
    return raw === undefined ? fallback : (JSON.parse(raw) as T);
  },
  writeJsonFileAtomic(path: string, data: unknown): void {
    if (!path) throw new Error("storage path used before the data dir was resolved");
    if (storageControl.failWrites) throw new Error("disk full");
    memFiles.set(path, JSON.stringify(data));
  },
};

export function resetStorage(): void {
  memFiles.clear();
  storageControl.resolved = false;
  storageControl.failWrites = false;
  storageControl.failReads = null;
}

export function ledgerEntries(): Array<{ op: string; key: string; state: string; transferId?: string; note?: string; at: number }> {
  return JSON.parse(memFiles.get(MEM_LEDGER_PATH) ?? "[]");
}

/** Error shaped like a SphereError from a provider bundle (code read structurally). */
export function sdkError(code: string, message = code, extra?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code }, extra);
}

export type FakePayments = {
  assets: ReturnType<typeof vi.fn>;
  unverifiedAssets: ReturnType<typeof vi.fn>;
  tokens: ReturnType<typeof vi.fn>;
  unverifiedTokens: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  mint: ReturnType<typeof vi.fn>;
  pendingTransfers: ReturnType<typeof vi.fn>;
  requests: { create: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn>; pay: ReturnType<typeof vi.fn>; decline: ReturnType<typeof vi.fn> };
};

export function makePayments(): FakePayments {
  return {
    assets: vi.fn(async () => []),
    unverifiedAssets: vi.fn(async () => []),
    tokens: vi.fn(() => []),
    unverifiedTokens: vi.fn(() => []),
    history: vi.fn(async () => ({ entries: [], more: false, cursor: null })),
    send: vi.fn(),
    mint: vi.fn(),
    pendingTransfers: vi.fn(async () => []),
    requests: { create: vi.fn(), list: vi.fn(() => []), pay: vi.fn(), decline: vi.fn(async () => undefined) },
  };
}

/** x-only key the fake resolver gives every nametag and DIRECT:// address. */
export const NAMED_KEY = "b0".repeat(32);

/** A wallet's own, self-consistent binding: its chain key is the 66-hex form of the key that signed it. */
export function binding(xOnly: string, chainPubkey = `02${xOnly}`) {
  return { transportPubkey: xOnly, chainPubkey, directAddress: "", timestamp: 1 };
}

/** Default sphere.resolve: a hex key resolves to its own binding, anything else to NAMED_KEY's. */
function defaultResolve(identifier: string) {
  return binding(/^[0-9a-f]{64}$/i.test(identifier) ? identifier.toLowerCase() : NAMED_KEY);
}

/** Fake Sphere whose `payments` getter can be made to throw (NOT_INITIALIZED / PAYMENTS_NOT_COMPOSED). */
export function makeSphere(payments: FakePayments, opts?: { hasPayments?: boolean; paymentsError?: Error; networkId?: number }) {
  return {
    hasPayments: opts?.hasPayments ?? true,
    networkId: opts?.networkId ?? 4,
    resolve: vi.fn(async (identifier: string) => defaultResolve(identifier) as ReturnType<typeof binding> | null),
    get payments() {
      if (opts?.paymentsError) throw opts.paymentsError;
      return payments;
    },
  };
}

/** A pendingTransfers() row, open by default. */
export function pendingRow(transferId: string, extra?: Record<string, unknown>) {
  return { transferId, kind: "open", recipient: "02aa", coinId: UCT, amount: "1", legs: { certified: 1, total: 1 }, deliveryPending: true, createdAt: 0, ...extra };
}

/** Holder the mocked src/sphere.js reads. */
export const wallet: { sphere: unknown } = { sphere: null };

/**
 * Exports of a mocked src/sphere.js: the fake wallet, and a real NameVerifier over it. Each fake Sphere gets a fresh
 * verifier, so cached lookups never carry over between tests.
 */
export async function sphereExports() {
  const { NameVerifier } = await import("../../src/identity.js");
  let verifier: InstanceType<typeof NameVerifier> | null = null;
  let verifierSphere: unknown = null;
  return {
    getSphereOrNull: () => wallet.sphere,
    getNameVerifier() {
      if (!verifier || verifierSphere !== wallet.sphere) {
        verifierSphere = wallet.sphere;
        verifier = new NameVerifier(() => wallet.sphere as never);
      }
      return verifier;
    },
  };
}

/** Holder the mocked src/runtime.js reads: a runtime whose config.current() carries the plugin's network. */
export const runtime: { network: string | null } = { network: "testnet2" };

export const runtimeExports = {
  getUnicityRuntimeOrNull: () =>
    runtime.network === null
      ? null
      : { config: { current: () => ({ plugins: { entries: { "openclaw-unicity": { config: { network: runtime.network } } } } }) } },
};

export function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

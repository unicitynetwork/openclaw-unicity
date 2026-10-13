/** assets.ts against the REAL SDK TokenRegistry (only fetch is stubbed), fed the live testnet2 registry entries. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenRegistry } from "@unicitylabs/sphere-sdk";
import { ensureRegistryReady, formatAmount, getAvailableSymbols, resolveCoin } from "../src/assets.js";

const UCT = "f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0";
const BTC = "3cc412d8a24510d424f74de4c471d22298b7f52625af6fd3ecb3c3d9e1a683fb";
const USDCE = "eae954053183b9d1836d6b5c892867014bcc1571fcc6813f5b56b16a78d0497f";
const SNAKE = "7fc5d3a3c480c8606d25b381ed64e9c79560ec0243628691c978f40226d06c86";
const NFT_TYPE = "971a26eef0e3aeb22bd3e7d44c47ce963400037e8df42b50d4d44e1589f83826";

/** Entries copied from unicity-ids.testnet2.json (icons dropped), in the served order. */
const TESTNET2 = [
  { network: "unicity:testnet2", assetKind: "non-fungible", name: "unicity", description: "Unicity testnet v2 token type", id: NFT_TYPE },
  { network: "unicity:testnet2", assetKind: "fungible", name: "unicity", symbol: "UCT", decimals: 18, description: "native coin", id: UCT },
  { network: "unicity:testnet2", assetKind: "fungible", name: "bitcoin", symbol: "BTC", decimals: 8, description: "bitcoin", id: BTC },
  {
    network: "unicity:testnet2", assetKind: "fungible", name: "usd-coin", symbol: "USDC.e", decimals: 6, description: "bridged USDC", id: USDCE,
    issuance: { tokenType: "2ccbf3157add2b9a2dcc10e772abf5cf328e2723f9f290a9d2b6c4a42a132d6c" },
  },
  { network: "unicity:testnet2", assetKind: "fungible", name: "snake-game", symbol: "SNAKE", decimals: 0, description: "snake", id: SNAKE },
];

const REGISTRY_URL = "https://registry.test/unicity-ids.testnet2.json";
let served: Array<() => Response>;

beforeEach(() => {
  TokenRegistry.destroy();
  served = [];
  vi.stubGlobal("fetch", vi.fn(async () => (served.shift() ?? (() => new Response("[]", { status: 503 })))()));
});

afterEach(() => {
  TokenRegistry.destroy();
  vi.unstubAllGlobals();
});

const ok = () => Response.json(TESTNET2);

describe("assets.ts over the real TokenRegistry", () => {
  it("is not ready while the registry was never configured", async () => {
    expect(await ensureRegistryReady(50)).toBe(false);
    expect(resolveCoin("UCT")).toBeNull();
  });

  it("resolves coins, flags the claimed USDC.e and formats amounts once loaded", async () => {
    served.push(ok);
    TokenRegistry.configure({ remoteUrl: REGISTRY_URL });
    expect(await ensureRegistryReady(2_000)).toBe(true);

    expect(resolveCoin("uct")).toEqual({ coinId: UCT, symbol: "UCT", name: "unicity", decimals: 18, claimed: false });
    expect(resolveCoin("USDC")).toEqual({ coinId: USDCE, symbol: "USDC.e", name: "usd-coin", decimals: 6, claimed: true });
    expect(resolveCoin("bitcoin")?.coinId).toBe(BTC);
    expect(resolveCoin(SNAKE.toUpperCase())?.decimals).toBe(0);
    expect(resolveCoin(NFT_TYPE)).toBeNull();

    expect(formatAmount("1500000000000000000", UCT)).toBe("1.5 UCT");
    expect(formatAmount("7", SNAKE)).toBe("7 SNAKE");
    expect(getAvailableSymbols().sort()).toEqual(["BTC", "SNAKE", "UCT", "USDC.e"]);
    expect(getAvailableSymbols({ excludeClaimed: true }).sort()).toEqual(["BTC", "SNAKE", "UCT"]);
  });

  it("is ready when the first load failed but a later refresh filled the registry", async () => {
    TokenRegistry.configure({ remoteUrl: REGISTRY_URL });
    expect(await TokenRegistry.waitForReady(2_000)).toBe(false);
    expect(await ensureRegistryReady(2_000)).toBe(false);

    served.push(ok);
    expect(await TokenRegistry.getInstance().refreshFromRemote()).toBe(true);
    expect(await TokenRegistry.waitForReady(2_000)).toBe(false);
    expect(await ensureRegistryReady(2_000)).toBe(true);
    expect(resolveCoin("BTC")?.coinId).toBe(BTC);
  });
});

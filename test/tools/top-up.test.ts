import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BTC,
  UCT,
  ledgerEntries,
  makePayments,
  makeSphere,
  registry,
  resetRegistry,
  resetStorage,
  runtime,
  storageControl,
  text,
  wallet,
  type FakePayments,
} from "./payments-fixtures.js";

vi.mock("@unicitylabs/sphere-sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("./payments-fixtures.js")).registryExports,
}));
vi.mock("../../src/storage.js", async () => (await import("./payments-fixtures.js")).storageExports);
vi.mock("../../src/runtime.js", async () => (await import("./payments-fixtures.js")).runtimeExports);
vi.mock("../../src/sphere.js", async () => {
  const f = await import("./payments-fixtures.js");
  return { getSphereOrNull: () => f.wallet.sphere };
});

const { topUpTool } = await import("../../src/tools/top-up.js");

let payments: FakePayments;
const topUp = (params: Record<string, unknown>) => topUpTool.execute("call", { coin: "UCT", amount: "100", ...params });

beforeEach(() => {
  resetRegistry();
  resetStorage();
  runtime.network = "testnet2";
  payments = makePayments();
  payments.mint.mockResolvedValue({ success: true, tokenId: "tok-1" });
  wallet.sphere = makeSphere(payments, { networkId: 4 });
});

describe("unicity_top_up", () => {
  it("describes minting on testnet2, run sequentially", () => {
    expect(topUpTool.description).not.toMatch(/IsOwner/i);
    expect(topUpTool.description).toContain("testnet2");
    expect(topUpTool.executionMode).toBe("sequential");
  });

  it("mints the registry coin id with exact base units and needs no nametag", async () => {
    const result = await topUp({});
    expect(payments.mint).toHaveBeenCalledWith(UCT, 100n * 10n ** 18n);
    expect(text(result)).toBe("Minted 100 UCT into the wallet (token tok-1).");
    expect(result.details).toMatchObject({ outcome: "minted", tokenId: "tok-1" });
    expect(ledgerEntries()[0]).toMatchObject({ op: "mint", state: "done" });
  });

  it("handles coins with few decimals", async () => {
    await topUp({ coin: "btc", amount: "0.5" });
    expect(payments.mint).toHaveBeenCalledWith(BTC, 50_000_000n);
  });

  it.each([
    ["the configured network is mainnet", () => { runtime.network = "mainnet"; }],
    ["the wallet's trust base is mainnet", () => { wallet.sphere = makeSphere(payments, { networkId: 1 }); }],
    ["the network cannot be determined", () => { runtime.network = null; }],
  ])("refuses when %s", async (_label, arrange) => {
    arrange();
    const result = await topUp({});
    expect(result.details).toMatchObject({ status: "error", code: "mint_not_allowed" });
    expect(payments.mint).not.toHaveBeenCalled();
  });

  it("refuses issuer-claimed coins (USDC -> USDC.e)", async () => {
    const result = await topUp({ coin: "USDC" });
    expect(result.details).toMatchObject({ code: "coin_not_mintable" });
    expect(text(result)).toContain("USDC.e is issued only by its issuer");
    expect(payments.mint).not.toHaveBeenCalled();
  });

  it("lists only mintable coins for an unknown coin", async () => {
    const result = await topUp({ coin: "DOGE" });
    expect(result.details).toMatchObject({ code: "unknown_coin" });
    expect(text(result)).toContain("Available coins: UCT, USDU, BTC, SNAKE.");
  });

  it.each([[100], ["1e2"], ["0"], ["-5"], ["0.5"]])("rejects amount %j", async (amount) => {
    const result = await topUp({ coin: amount === "0.5" ? "SNAKE" : "UCT", amount });
    expect(result.details).toMatchObject({ code: "invalid_amount" });
    expect(payments.mint).not.toHaveBeenCalled();
  });

  it("refuses while the registry is not loaded", async () => {
    registry.ready = false;
    expect((await topUp({})).details).toMatchObject({ code: "registry_not_ready" });
  });

  it("tells the model not to retry a mint that did not confirm, and blocks an identical retry", async () => {
    payments.mint.mockResolvedValueOnce({ success: false, error: "aggregator timeout" });
    const result = await topUp({});
    expect(text(result)).toContain("MINT NOT CONFIRMED — DO NOT RETRY");
    expect(text(result)).toContain("aggregator timeout");
    expect(result.details).toMatchObject({ outcome: "possibly_committed" });
    expect(result.details).not.toHaveProperty("status");

    expect((await topUp({})).details).toMatchObject({ code: "duplicate" });
    expect(payments.mint).toHaveBeenCalledTimes(1);
  });

  it("treats any thrown mint error as an unknown outcome and refuses an identical retry", async () => {
    // A throw from mint() is a mint-journal write; the one after the chain mint leaves an entry the wallet replays.
    payments.mint.mockRejectedValueOnce(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
    const result = await topUp({});
    expect(text(result)).toContain("MINT OUTCOME UNKNOWN — DO NOT RETRY");
    expect(text(result)).not.toContain("Mint failed");
    expect(result.details).toMatchObject({ outcome: "possibly_committed", code: "ENOSPC" });
    expect(result.details).not.toHaveProperty("status");
    expect(ledgerEntries()[0].state).toBe("possibly_committed");

    expect((await topUp({})).details).toMatchObject({ code: "duplicate" });
    expect(payments.mint).toHaveBeenCalledTimes(1);
  });

  it("keeps an unresolved mint blocking past the duplicate window, but a completed one only for the window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
      payments.mint.mockResolvedValueOnce({ success: false, error: "aggregator timeout" });
      await topUp({});
      vi.setSystemTime(new Date("2026-10-12T13:00:00Z")); // 1 h later: past the 15-minute duplicate window
      expect((await topUp({})).details).toMatchObject({ code: "duplicate" });
      expect(payments.mint).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-10-13T12:30:00Z")); // past the 24 h unresolved window
      expect((await topUp({})).details).toMatchObject({ outcome: "minted" });
      expect(payments.mint).toHaveBeenCalledTimes(2);

      vi.setSystemTime(new Date("2026-10-13T13:00:00Z")); // a completed mint blocks only for the duplicate window
      expect((await topUp({})).details).toMatchObject({ outcome: "minted" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an uncoded mint failure as an unknown outcome", async () => {
    payments.mint.mockRejectedValueOnce(new TypeError("boom"));
    expect((await topUp({})).details).toMatchObject({ outcome: "possibly_committed", code: "UNKNOWN" });
  });

  it("does not mint when the ledger cannot be read", async () => {
    storageControl.failReads = "EIO";
    expect((await topUp({})).details).toMatchObject({ code: "ledger_unavailable" });
    expect(payments.mint).not.toHaveBeenCalled();
  });

  it("explains a messaging-only wallet", async () => {
    wallet.sphere = makeSphere(payments, { hasPayments: false });
    expect((await topUp({})).details).toMatchObject({ code: "payments_unavailable" });
  });
});

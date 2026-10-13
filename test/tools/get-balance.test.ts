import { describe, it, expect, vi, beforeEach } from "vitest";
import { UCT, USDCE, USDU, makePayments, makeSphere, registry, resetRegistry, sdkError, text, wallet, type FakePayments } from "./payments-fixtures.js";

vi.mock("@unicitylabs/sphere-sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("./payments-fixtures.js")).registryExports,
}));
vi.mock("../../src/storage.js", async () => (await import("./payments-fixtures.js")).storageExports);
vi.mock("../../src/sphere.js", async () => {
  const f = await import("./payments-fixtures.js");
  return { getSphereOrNull: () => f.wallet.sphere };
});

const { getBalanceTool } = await import("../../src/tools/get-balance.js");

const asset = (coinId: string, symbol: string, name: string, decimals: number, totalAmount: string, tokenCount: number, transferringAmount = "0") => ({
  coinId, symbol, name, decimals, totalAmount, tokenCount, transferringAmount,
  confirmedAmount: totalAmount, unconfirmedAmount: "0", confirmedTokenCount: tokenCount, unconfirmedTokenCount: 0, transferringTokenCount: 0,
  priceUsd: null, priceEur: null, change24h: null, fiatValueUsd: null, fiatValueEur: null,
});

let payments: FakePayments;

beforeEach(() => {
  resetRegistry();
  payments = makePayments();
  wallet.sphere = makeSphere(payments);
});

describe("unicity_get_balance", () => {
  it("is owner only without IsOwner wording", () => {
    expect(getBalanceTool.name).toBe("unicity_get_balance");
    expect(getBalanceTool.description).toContain("Owner only (enforced by the plugin)");
    expect(getBalanceTool.description).not.toContain("IsOwner");
  });

  it("formats each asset with its own decimals and shows in-flight amounts", async () => {
    payments.assets.mockResolvedValue([
      asset(UCT, "UCT", "Unicity", 18, "2500000000000000000", 3, "1000000000000000000"),
      asset(USDU, "USDU", "Unicity-usd", 6, "1000000", 1),
    ]);
    const result = await getBalanceTool.execute("call", {});
    expect(payments.assets).toHaveBeenCalledWith(undefined);
    expect(text(result)).toBe("Unicity (UCT): 2.5 UCT (3 tokens, 1 UCT being sent)\nUnicity-usd (USDU): 1 USDU (1 token)");
    expect(result.details).toMatchObject({ balances: [expect.objectContaining({ coinId: UCT, totalAmount: "2500000000000000000" }), expect.anything()] });
  });

  it("resolves a coin filter to the registry hex id", async () => {
    payments.assets.mockResolvedValue([asset(UCT, "UCT", "Unicity", 18, "1000000000000000000", 1)]);
    await getBalanceTool.execute("call", { coin: "uct" });
    expect(payments.assets).toHaveBeenCalledWith(UCT);
    expect(payments.unverifiedAssets).toHaveBeenCalledWith(UCT);
  });

  it("lists claimed-coin holdings pending verification separately", async () => {
    payments.unverifiedAssets.mockResolvedValue([asset(USDCE, "USDC.e", "Usd-coin-bridged", 6, "5000000", 1)]);
    const out = text(await getBalanceTool.execute("call", { coin: "USDC" }));
    expect(payments.assets).toHaveBeenCalledWith(USDCE);
    expect(out).toBe("Pending verification (not spendable):\n  USDC.e: 5 USDC.e");
  });

  it("says when there is nothing", async () => {
    expect(text(await getBalanceTool.execute("call", {}))).toBe("The wallet holds no tokens.");
    expect(text(await getBalanceTool.execute("call", { coin: "UCT" }))).toBe("No UCT balance.");
  });

  it("rejects unknown coins and waits for the registry only when filtering", async () => {
    expect((await getBalanceTool.execute("call", { coin: "FAKE" })).details).toMatchObject({ code: "unknown_coin" });
    registry.ready = false;
    expect((await getBalanceTool.execute("call", { coin: "UCT" })).details).toMatchObject({ code: "registry_not_ready" });
    expect((await getBalanceTool.execute("call", {})).details).toEqual({ balances: [], unverified: [] });
  });

  it("reports read failures and an unavailable wallet", async () => {
    payments.assets.mockRejectedValue(new Error("mirror not loaded"));
    expect((await getBalanceTool.execute("call", {})).details).toMatchObject({ status: "error", code: "balance_unavailable" });
    wallet.sphere = makeSphere(payments, { paymentsError: sdkError("PAYMENTS_NOT_COMPOSED") });
    expect((await getBalanceTool.execute("call", {})).details).toMatchObject({ code: "payments_unavailable" });
  });
});

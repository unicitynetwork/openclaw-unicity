import { describe, it, expect, vi, beforeEach } from "vitest";
import { BTC, UCT, USDCE, makePayments, makeSphere, resetRegistry, text, wallet, type FakePayments } from "./payments-fixtures.js";

vi.mock("@unicitylabs/sphere-sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("./payments-fixtures.js")).registryExports,
}));
vi.mock("../../src/storage.js", async () => (await import("./payments-fixtures.js")).storageExports);
vi.mock("../../src/sphere.js", async () => {
  const f = await import("./payments-fixtures.js");
  return { getSphereOrNull: () => f.wallet.sphere };
});

const { listTokensTool } = await import("../../src/tools/list-tokens.js");

const token = (id: string, coinId: string, symbol: string, decimals: number, amount: string, status: string, extra?: object) => ({
  id, coinId, symbol, name: symbol, decimals, amount, status, createdAt: Date.UTC(2026, 9, 1), updatedAt: 0, ...extra,
});

let payments: FakePayments;

beforeEach(() => {
  resetRegistry();
  payments = makePayments();
  const held = [
    token("a".repeat(64), UCT, "UCT", 18, "1500000000000000000", "confirmed"),
    token("b".repeat(64), BTC, "BTC", 8, "50000000", "transferring", { suspectedSpent: true }),
  ];
  payments.tokens.mockImplementation((filter?: { coinId: string }) => held.filter((t) => !filter || t.coinId === filter.coinId));
  wallet.sphere = makeSphere(payments);
});

describe("unicity_list_tokens", () => {
  it("only offers the statuses the SDK produces", () => {
    const schema = listTokensTool.parameters as { properties: { status: { anyOf: Array<{ const: string }> } } };
    expect(schema.properties.status.anyOf.map((s) => s.const)).toEqual(["confirmed", "transferring"]);
  });

  it("lists tokens with their own decimals", async () => {
    const out = text(await listTokensTool.execute("call", {}));
    expect(payments.tokens).toHaveBeenCalledWith(undefined);
    expect(out).toBe(
      "Found 2 tokens:\n" +
        "aaaaaaaaaaaa… | 1.5 UCT | confirmed | 2026-10-01T00:00:00.000Z\n" +
        "bbbbbbbbbbbb… | 0.5 BTC | transferring (suspected spent) | 2026-10-01T00:00:00.000Z",
    );
  });

  it("filters by coin (hex id) and status", async () => {
    const out = text(await listTokensTool.execute("call", { coin: "bitcoin", status: "transferring" }));
    expect(payments.tokens).toHaveBeenCalledWith({ coinId: BTC });
    expect(out).toContain("0.5 BTC");
    expect(out).not.toContain("UCT");
    expect(payments.unverifiedTokens).not.toHaveBeenCalled();
  });

  it("appends unverified claimed-coin tokens when not filtering by status", async () => {
    payments.tokens.mockReturnValue([]);
    payments.unverifiedTokens.mockReturnValue([token("c".repeat(64), USDCE, "USDC.e", 6, "2000000", "confirmed")]);
    expect(text(await listTokensTool.execute("call", {}))).toContain("2 USDC.e | unverified (not spendable)");
  });

  it("reports no matches, unknown coins and read failures", async () => {
    expect(text(await listTokensTool.execute("call", { status: "confirmed", coin: "SNAKE" }))).toBe("No tokens found matching the criteria.");
    expect((await listTokensTool.execute("call", { coin: "FAKE" })).details).toMatchObject({ code: "unknown_coin" });
    payments.tokens.mockImplementation(() => {
      throw new Error("not started");
    });
    expect((await listTokensTool.execute("call", {})).details).toMatchObject({ code: "tokens_unavailable" });
  });
});

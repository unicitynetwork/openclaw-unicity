import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetBalance = vi.fn();
const mockGetSphere = vi.fn();
const mockToHumanReadable = vi.fn();
const mockGetCoinDecimals = vi.fn();

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

vi.mock("../../src/assets.js", () => ({
  getCoinDecimals: (coin: string) => mockGetCoinDecimals(coin),
  toHumanReadable: (amount: string, decimals: number) => mockToHumanReadable(amount, decimals),
}));

const { getBalanceTool } = await import("../../src/tools/get-balance.js");

describe("getBalanceTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      payments: { getBalance: mockGetBalance },
    });
    mockToHumanReadable.mockImplementation((amount: string) => amount);
  });

  it("has correct name and description", () => {
    expect(getBalanceTool.name).toBe("unicity_get_balance");
    expect(getBalanceTool.description).toContain("balance");
  });

  it("returns formatted balance lines", async () => {
    mockGetBalance.mockReturnValue([
      { coinId: "ALPHA", symbol: "ALPHA", name: "Alpha", totalAmount: "500", tokenCount: 3, decimals: 0 },
      { coinId: "BETA", symbol: "BETA", name: "Beta", totalAmount: "100", tokenCount: 1, decimals: 0 },
    ]);

    const result = await getBalanceTool.execute("call-1", {});

    expect(mockGetBalance).toHaveBeenCalledWith(undefined);
    expect(result.content[0].text).toContain("Alpha (ALPHA): 500 (3 tokens)");
    expect(result.content[0].text).toContain("Beta (BETA): 100 (1 token)");
  });

  it("filters by coinId when provided", async () => {
    mockGetBalance.mockReturnValue([
      { coinId: "ALPHA", symbol: "ALPHA", name: "Alpha", totalAmount: "500", tokenCount: 3, decimals: 0 },
    ]);

    await getBalanceTool.execute("call-2", { coinId: "ALPHA" });

    expect(mockGetBalance).toHaveBeenCalledWith("ALPHA");
  });

  it("returns empty message when no balances", async () => {
    mockGetBalance.mockReturnValue([]);

    const result = await getBalanceTool.execute("call-3", {});
    expect(result.content[0].text).toContain("no tokens");
  });

  it("uses asset registry decimals over SDK decimals", async () => {
    mockGetCoinDecimals.mockReturnValue(18);
    mockGetBalance.mockReturnValue([
      { coinId: "455ad8...", symbol: "UCT", name: "unicity", totalAmount: "10000000000000000000", tokenCount: 1, decimals: 8 },
    ]);

    await getBalanceTool.execute("call-dec", {});

    // Should call toHumanReadable with registry decimals (18), not SDK decimals (8)
    expect(mockToHumanReadable).toHaveBeenCalledWith("10000000000000000000", 18);
  });

  it("falls back to SDK decimals when registry has no entry", async () => {
    mockGetCoinDecimals.mockReturnValue(undefined);
    mockGetBalance.mockReturnValue([
      { coinId: "unknown", symbol: "???", name: "unknown", totalAmount: "100", tokenCount: 1, decimals: 6 },
    ]);

    await getBalanceTool.execute("call-fb", {});

    expect(mockToHumanReadable).toHaveBeenCalledWith("100", 6);
  });

  it("returns coin-specific empty message when coinId provided", async () => {
    mockGetBalance.mockReturnValue([]);

    const result = await getBalanceTool.execute("call-4", { coinId: "ALPHA" });
    expect(result.content[0].text).toContain("No balance found for ALPHA");
  });
});

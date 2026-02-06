import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetTokens = vi.fn();
const mockGetSphere = vi.fn();
const mockGetCoinDecimals = vi.fn();
const mockToHumanReadable = vi.fn();

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

vi.mock("../../src/assets.js", () => ({
  getCoinDecimals: (name: string) => mockGetCoinDecimals(name),
  toHumanReadable: (amount: string, decimals: number) => mockToHumanReadable(amount, decimals),
}));

const { listTokensTool } = await import("../../src/tools/list-tokens.js");

describe("listTokensTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      payments: { getTokens: mockGetTokens },
    });
    mockGetCoinDecimals.mockReturnValue(0);
    mockToHumanReadable.mockImplementation((amount: string) => amount);
  });

  it("has correct name and description", () => {
    expect(listTokensTool.name).toBe("uniclaw_list_tokens");
    expect(listTokensTool.description).toContain("token");
  });

  it("returns formatted token list", async () => {
    mockGetTokens.mockReturnValue([
      { id: "abcdef123456789000", coinId: "ALPHA", symbol: "ALPHA", name: "Alpha", amount: "100", status: "confirmed", createdAt: 1700000000000, updatedAt: 1700000000000 },
    ]);

    const result = await listTokensTool.execute("call-1", {});

    expect(mockGetTokens).toHaveBeenCalledWith({ coinId: undefined, status: undefined });
    expect(result.content[0].text).toContain("Found 1 token");
    expect(result.content[0].text).toContain("100 ALPHA");
    expect(result.content[0].text).toContain("confirmed");
  });

  it("passes filters to getTokens", async () => {
    mockGetTokens.mockReturnValue([]);

    await listTokensTool.execute("call-2", { coinId: "ALPHA", status: "confirmed" });

    expect(mockGetTokens).toHaveBeenCalledWith({ coinId: "ALPHA", status: "confirmed" });
  });

  it("returns empty message when no tokens found", async () => {
    mockGetTokens.mockReturnValue([]);

    const result = await listTokensTool.execute("call-3", {});
    expect(result.content[0].text).toContain("No tokens found");
  });
});

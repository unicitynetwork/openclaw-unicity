import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetHistory = vi.fn();
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

const { getTransactionHistoryTool } = await import("../../src/tools/get-transaction-history.js");

describe("getTransactionHistoryTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      payments: { getHistory: mockGetHistory },
    });
    mockGetCoinDecimals.mockReturnValue(0);
    mockToHumanReadable.mockImplementation((amount: string) => amount);
  });

  it("has correct name and description", () => {
    expect(getTransactionHistoryTool.name).toBe("unicity_get_transaction_history");
    expect(getTransactionHistoryTool.description).toContain("history");
  });

  it("returns formatted history sorted by timestamp desc", async () => {
    mockGetHistory.mockReturnValue([
      { id: "1", type: "SENT", amount: "50", coinId: "ALPHA", symbol: "ALPHA", timestamp: 1700000000000, recipientNametag: "alice", transferId: "tx-abc" },
      { id: "2", type: "RECEIVED", amount: "100", coinId: "ALPHA", symbol: "ALPHA", timestamp: 1700001000000, senderPubkey: "abcdef1234567890abcdef1234567890" },
    ]);

    const result = await getTransactionHistoryTool.execute("call-1", {});

    const text = result.content[0].text;
    // Most recent first
    expect(text.indexOf("RECEIVED")).toBeLessThan(text.indexOf("SENT"));
    expect(text).toContain("SENT 50 ALPHA to @alice");
    expect(text).toContain("RECEIVED 100 ALPHA from abcdef123456…");
  });

  it("labels SENT entries without transferId as BURN (split)", async () => {
    mockGetHistory.mockReturnValue([
      { id: "1", type: "SENT", amount: "100", coinId: "ALPHA", symbol: "ALPHA", timestamp: 1700001000000, recipientNametag: "alice", transferId: "tx-abc" },
      { id: "2", type: "SENT", amount: "800", coinId: "ALPHA", symbol: "ALPHA", timestamp: 1700000000000, recipientNametag: "alice" },
    ]);

    const result = await getTransactionHistoryTool.execute("call-burn", {});
    const text = result.content[0].text;

    // Real transfer keeps SENT label and shows recipient
    expect(text).toContain("SENT 100 ALPHA to @alice");
    // Burn entry gets relabeled and hides misleading recipient
    expect(text).toContain("BURN (split) 800 ALPHA");
    expect(text).not.toContain("BURN (split) 800 ALPHA to @alice");
  });

  it("respects limit parameter", async () => {
    mockGetHistory.mockReturnValue([
      { id: "1", type: "SENT", amount: "10", coinId: "ALPHA", symbol: "ALPHA", timestamp: 1700000000000, transferId: "tx-1" },
      { id: "2", type: "SENT", amount: "20", coinId: "ALPHA", symbol: "ALPHA", timestamp: 1700001000000, transferId: "tx-2" },
      { id: "3", type: "SENT", amount: "30", coinId: "ALPHA", symbol: "ALPHA", timestamp: 1700002000000, transferId: "tx-3" },
    ]);

    const result = await getTransactionHistoryTool.execute("call-2", { limit: 2 });

    const lines = result.content[0].text.split("\n");
    expect(lines).toHaveLength(2);
  });

  it("returns empty message when no history", async () => {
    mockGetHistory.mockReturnValue([]);

    const result = await getTransactionHistoryTool.execute("call-3", {});
    expect(result.content[0].text).toContain("No transaction history");
  });
});

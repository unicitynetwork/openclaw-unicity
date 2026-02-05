import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetHistory = vi.fn();
const mockGetSphere = vi.fn();

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

const { getTransactionHistoryTool } = await import("../../src/tools/get-transaction-history.js");

describe("getTransactionHistoryTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      payments: { getHistory: mockGetHistory },
    });
  });

  it("has correct name and description", () => {
    expect(getTransactionHistoryTool.name).toBe("uniclaw_get_transaction_history");
    expect(getTransactionHistoryTool.description).toContain("history");
  });

  it("returns formatted history sorted by timestamp desc", async () => {
    mockGetHistory.mockReturnValue([
      { id: "1", type: "SENT", amount: "50", coinId: "ALPHA", symbol: "ALPHA", timestamp: 1700000000000, recipientNametag: "alice" },
      { id: "2", type: "RECEIVED", amount: "100", coinId: "ALPHA", symbol: "ALPHA", timestamp: 1700001000000, senderPubkey: "abcdef1234567890abcdef1234567890" },
    ]);

    const result = await getTransactionHistoryTool.execute("call-1", {});

    const text = result.content[0].text;
    // Most recent first
    expect(text.indexOf("RECEIVED")).toBeLessThan(text.indexOf("SENT"));
    expect(text).toContain("SENT 50 ALPHA to @alice");
    expect(text).toContain("RECEIVED 100 ALPHA from abcdef123456…");
  });

  it("respects limit parameter", async () => {
    mockGetHistory.mockReturnValue([
      { id: "1", type: "SENT", amount: "10", coinId: "ALPHA", symbol: "ALPHA", timestamp: 1700000000000 },
      { id: "2", type: "SENT", amount: "20", coinId: "ALPHA", symbol: "ALPHA", timestamp: 1700001000000 },
      { id: "3", type: "SENT", amount: "30", coinId: "ALPHA", symbol: "ALPHA", timestamp: 1700002000000 },
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

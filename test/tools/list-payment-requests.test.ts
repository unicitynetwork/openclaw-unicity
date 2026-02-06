import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetPaymentRequests = vi.fn();
const mockGetOutgoingPaymentRequests = vi.fn();
const mockGetSphere = vi.fn();
const mockGetCoinDecimals = vi.fn();
const mockGetCoinSymbol = vi.fn();
const mockToHumanReadable = vi.fn();

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

vi.mock("../../src/assets.js", () => ({
  getCoinDecimals: (name: string) => mockGetCoinDecimals(name),
  getCoinSymbol: (name: string) => mockGetCoinSymbol(name),
  toHumanReadable: (amount: string, decimals: number) => mockToHumanReadable(amount, decimals),
}));

const { listPaymentRequestsTool } = await import("../../src/tools/list-payment-requests.js");

describe("listPaymentRequestsTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      payments: {
        getPaymentRequests: mockGetPaymentRequests,
        getOutgoingPaymentRequests: mockGetOutgoingPaymentRequests,
      },
    });
    mockGetCoinDecimals.mockReturnValue(0);
    mockGetCoinSymbol.mockImplementation((name: string) => name.toUpperCase());
    mockToHumanReadable.mockImplementation((amount: string) => amount);
  });

  it("has correct name and description", () => {
    expect(listPaymentRequestsTool.name).toBe("uniclaw_list_payment_requests");
    expect(listPaymentRequestsTool.description).toContain("payment requests");
  });

  it("lists both incoming and outgoing by default", async () => {
    mockGetPaymentRequests.mockReturnValue([
      { requestId: "req-111111111111", senderPubkey: "abcdef", senderNametag: "alice", amount: "50", coinId: "ALPHA", symbol: "ALPHA", status: "pending", timestamp: 1700000000000 },
    ]);
    mockGetOutgoingPaymentRequests.mockReturnValue([
      { id: "req-222222222222", recipientPubkey: "123456", recipientNametag: "bob", amount: "30", coinId: "ALPHA", status: "pending", createdAt: 1700000000000 },
    ]);

    const result = await listPaymentRequestsTool.execute("call-1", {});

    const text = result.content[0].text;
    expect(text).toContain("Incoming (1)");
    expect(text).toContain("@alice");
    expect(text).toContain("50 ALPHA");
    expect(text).toContain("Outgoing (1)");
    expect(text).toContain("@bob");
    expect(text).toContain("30 ALPHA");
  });

  it("filters to incoming only", async () => {
    mockGetPaymentRequests.mockReturnValue([]);

    const result = await listPaymentRequestsTool.execute("call-2", { direction: "incoming" });

    expect(mockGetPaymentRequests).toHaveBeenCalled();
    expect(mockGetOutgoingPaymentRequests).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Incoming: none");
  });

  it("filters to outgoing only", async () => {
    mockGetOutgoingPaymentRequests.mockReturnValue([]);

    const result = await listPaymentRequestsTool.execute("call-3", { direction: "outgoing" });

    expect(mockGetOutgoingPaymentRequests).toHaveBeenCalled();
    expect(mockGetPaymentRequests).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Outgoing: none");
  });

  it("passes status filter", async () => {
    mockGetPaymentRequests.mockReturnValue([]);
    mockGetOutgoingPaymentRequests.mockReturnValue([]);

    await listPaymentRequestsTool.execute("call-4", { direction: "all", status: "pending" });

    expect(mockGetPaymentRequests).toHaveBeenCalledWith({ status: "pending" });
    expect(mockGetOutgoingPaymentRequests).toHaveBeenCalledWith({ status: "pending" });
  });

  it("includes message in output when present", async () => {
    mockGetPaymentRequests.mockReturnValue([
      { requestId: "req-333333333333", senderPubkey: "abcdef", senderNametag: "alice", amount: "50", coinId: "ALPHA", symbol: "ALPHA", status: "pending", message: "for lunch", timestamp: 1700000000000 },
    ]);
    mockGetOutgoingPaymentRequests.mockReturnValue([]);

    const result = await listPaymentRequestsTool.execute("call-5", {});
    expect(result.content[0].text).toContain('"for lunch"');
  });
});

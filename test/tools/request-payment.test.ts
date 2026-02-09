import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendPaymentRequest = vi.fn();
const mockGetSphere = vi.fn();
const mockResolveCoinId = vi.fn();
const mockGetCoinSymbol = vi.fn();
const mockGetCoinDecimals = vi.fn();
const mockGetSdkCoinId = vi.fn();
const mockToSmallestUnit = vi.fn();

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

vi.mock("../../src/assets.js", () => ({
  resolveCoinId: (input: string) => mockResolveCoinId(input),
  getCoinSymbol: (name: string) => mockGetCoinSymbol(name),
  getCoinDecimals: (name: string) => mockGetCoinDecimals(name),
  getCoinId: (name: string) => mockGetSdkCoinId(name),
  toSmallestUnit: (amount: number | string, decimals: number) => mockToSmallestUnit(amount, decimals),
}));

const { requestPaymentTool } = await import("../../src/tools/request-payment.js");

describe("requestPaymentTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      payments: { sendPaymentRequest: mockSendPaymentRequest },
    });
    mockResolveCoinId.mockReturnValue("unicity");
    mockGetCoinSymbol.mockReturnValue("UCT");
    mockGetCoinDecimals.mockReturnValue(18);
    mockGetSdkCoinId.mockReturnValue("455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89");
    mockToSmallestUnit.mockReturnValue("50000000000000000000");
  });

  it("has correct name and description", () => {
    expect(requestPaymentTool.name).toBe("unicity_request_payment");
    expect(requestPaymentTool.description).toContain("payment request");
  });

  it("sends a payment request with correct parameters", async () => {
    mockSendPaymentRequest.mockResolvedValue({ success: true, requestId: "req-42", eventId: "ev-1" });

    const result = await requestPaymentTool.execute("call-1", {
      recipient: "@alice",
      amount: 50,
      coin: "UCT",
      message: "for the couch",
    });

    expect(mockResolveCoinId).toHaveBeenCalledWith("UCT");
    expect(mockToSmallestUnit).toHaveBeenCalledWith(50, 18);
    expect(mockSendPaymentRequest).toHaveBeenCalledWith("@alice", {
      amount: "50000000000000000000",
      coinId: "455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89",
      message: "for the couch",
    });
    expect(result.content[0].text).toContain("@alice");
    expect(result.content[0].text).toContain("50 UCT");
    expect(result.content[0].text).toContain("req-42");
  });

  it("returns error on failure", async () => {
    mockSendPaymentRequest.mockResolvedValue({ success: false, error: "recipient not found" });

    const result = await requestPaymentTool.execute("call-2", {
      recipient: "@unknown",
      amount: 10,
      coin: "UCT",
    });

    expect(result.content[0].text).toContain("failed");
    expect(result.content[0].text).toContain("recipient not found");
  });

  it("rejects invalid recipient format", async () => {
    await expect(
      requestPaymentTool.execute("call-3", {
        recipient: "not valid!",
        amount: 10,
        coin: "UCT",
      }),
    ).rejects.toThrow("Invalid recipient format");
  });

  it("throws on unknown coin", async () => {
    mockResolveCoinId.mockReturnValue(null);

    await expect(
      requestPaymentTool.execute("call-4", {
        recipient: "@bob",
        amount: 10,
        coin: "FAKE",
      }),
    ).rejects.toThrow('Unknown coin "FAKE"');
  });

  it("propagates sendPaymentRequest errors", async () => {
    mockSendPaymentRequest.mockRejectedValue(new Error("relay error"));

    await expect(
      requestPaymentTool.execute("call-5", {
        recipient: "@bob",
        amount: 10,
        coin: "UCT",
      }),
    ).rejects.toThrow("relay error");
  });

  it("throws on zero amount", async () => {
    await expect(
      requestPaymentTool.execute("call-6", {
        recipient: "@alice",
        amount: 0,
        coin: "UCT",
      }),
    ).rejects.toThrow("Amount must be greater than 0");
  });

  it("throws on negative amount", async () => {
    await expect(
      requestPaymentTool.execute("call-7", {
        recipient: "@alice",
        amount: -5,
        coin: "UCT",
      }),
    ).rejects.toThrow("Amount must be greater than 0");
  });
});

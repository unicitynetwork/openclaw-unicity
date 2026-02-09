import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPayPaymentRequest = vi.fn();
const mockAcceptPaymentRequest = vi.fn();
const mockRejectPaymentRequest = vi.fn();
const mockGetSphere = vi.fn();

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

const { respondPaymentRequestTool } = await import("../../src/tools/respond-payment-request.js");

describe("respondPaymentRequestTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      payments: {
        payPaymentRequest: mockPayPaymentRequest,
        acceptPaymentRequest: mockAcceptPaymentRequest,
        rejectPaymentRequest: mockRejectPaymentRequest,
      },
    });
  });

  it("has correct name and description", () => {
    expect(respondPaymentRequestTool.name).toBe("unicity_respond_payment_request");
    expect(respondPaymentRequestTool.description).toContain("IMPORTANT");
    expect(respondPaymentRequestTool.description).toContain("explicitly instructed");
  });

  it("pays a payment request", async () => {
    mockPayPaymentRequest.mockResolvedValue({ id: "tx-99", status: "completed", tokens: [] });

    const result = await respondPaymentRequestTool.execute("call-1", {
      requestId: "req-42",
      action: "pay",
      memo: "here you go",
    });

    expect(mockPayPaymentRequest).toHaveBeenCalledWith("req-42", "here you go");
    expect(result.content[0].text).toContain("paid");
    expect(result.content[0].text).toContain("tx-99");
  });

  it("returns error when pay fails", async () => {
    mockPayPaymentRequest.mockResolvedValue({ id: "tx-err", status: "failed", tokens: [], error: "Insufficient funds" });

    const result = await respondPaymentRequestTool.execute("call-2", {
      requestId: "req-42",
      action: "pay",
    });

    expect(result.content[0].text).toContain("Payment failed");
    expect(result.content[0].text).toContain("Insufficient funds");
  });

  it("accepts a payment request", async () => {
    mockAcceptPaymentRequest.mockResolvedValue(undefined);

    const result = await respondPaymentRequestTool.execute("call-3", {
      requestId: "req-42",
      action: "accept",
    });

    expect(mockAcceptPaymentRequest).toHaveBeenCalledWith("req-42");
    expect(result.content[0].text).toContain("accepted");
  });

  it("rejects a payment request", async () => {
    mockRejectPaymentRequest.mockResolvedValue(undefined);

    const result = await respondPaymentRequestTool.execute("call-4", {
      requestId: "req-42",
      action: "reject",
    });

    expect(mockRejectPaymentRequest).toHaveBeenCalledWith("req-42");
    expect(result.content[0].text).toContain("rejected");
  });

  it("throws on invalid action", async () => {
    await expect(
      respondPaymentRequestTool.execute("call-5", {
        requestId: "req-42",
        action: "invalid",
      }),
    ).rejects.toThrow('Invalid action: "invalid"');
  });

  it("propagates pay errors", async () => {
    mockPayPaymentRequest.mockRejectedValue(new Error("network timeout"));

    await expect(
      respondPaymentRequestTool.execute("call-6", {
        requestId: "req-42",
        action: "pay",
      }),
    ).rejects.toThrow("network timeout");
  });
});

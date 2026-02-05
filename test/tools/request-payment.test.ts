import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendPaymentRequest = vi.fn();
const mockGetSphere = vi.fn();

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

const { requestPaymentTool } = await import("../../src/tools/request-payment.js");

describe("requestPaymentTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      payments: { sendPaymentRequest: mockSendPaymentRequest },
    });
  });

  it("has correct name and description", () => {
    expect(requestPaymentTool.name).toBe("uniclaw_request_payment");
    expect(requestPaymentTool.description).toContain("payment request");
  });

  it("sends a payment request with correct parameters", async () => {
    mockSendPaymentRequest.mockResolvedValue({ success: true, requestId: "req-42", eventId: "ev-1" });

    const result = await requestPaymentTool.execute("call-1", {
      recipient: "@alice",
      amount: "50",
      coinId: "ALPHA",
      message: "for the couch",
    });

    expect(mockSendPaymentRequest).toHaveBeenCalledWith("alice", {
      amount: "50",
      coinId: "ALPHA",
      message: "for the couch",
    });
    expect(result.content[0].text).toContain("@alice");
    expect(result.content[0].text).toContain("50 ALPHA");
    expect(result.content[0].text).toContain("req-42");
  });

  it("returns error on failure", async () => {
    mockSendPaymentRequest.mockResolvedValue({ success: false, error: "recipient not found" });

    const result = await requestPaymentTool.execute("call-2", {
      recipient: "@unknown",
      amount: "10",
      coinId: "ALPHA",
    });

    expect(result.content[0].text).toContain("failed");
    expect(result.content[0].text).toContain("recipient not found");
  });

  it("rejects invalid recipient format", async () => {
    await expect(
      requestPaymentTool.execute("call-3", {
        recipient: "not valid!",
        amount: "10",
        coinId: "ALPHA",
      }),
    ).rejects.toThrow("Invalid recipient format");
  });

  it("propagates sendPaymentRequest errors", async () => {
    mockSendPaymentRequest.mockRejectedValue(new Error("relay error"));

    await expect(
      requestPaymentTool.execute("call-4", {
        recipient: "@bob",
        amount: "10",
        coinId: "ALPHA",
      }),
    ).rejects.toThrow("relay error");
  });
});

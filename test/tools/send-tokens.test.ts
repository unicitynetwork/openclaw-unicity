import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSend = vi.fn();
const mockGetSphere = vi.fn();

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

const { sendTokensTool } = await import("../../src/tools/send-tokens.js");

describe("sendTokensTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      payments: { send: mockSend },
    });
  });

  it("has correct name and description", () => {
    expect(sendTokensTool.name).toBe("uniclaw_send_tokens");
    expect(sendTokensTool.description).toContain("IMPORTANT");
    expect(sendTokensTool.description).toContain("explicitly instructed");
  });

  it("sends tokens with correct parameters", async () => {
    mockSend.mockResolvedValue({ id: "tx-123", status: "completed", tokens: [] });

    const result = await sendTokensTool.execute("call-1", {
      recipient: "@alice",
      amount: "100",
      coinId: "ALPHA",
      memo: "for the coffee",
    });

    expect(mockSend).toHaveBeenCalledWith({
      recipient: "alice",
      amount: "100",
      coinId: "ALPHA",
      memo: "for the coffee",
    });
    expect(result.content[0].text).toContain("tx-123");
    expect(result.content[0].text).toContain("@alice");
    expect(result.content[0].text).toContain("completed");
  });

  it("accepts a 64-char hex pubkey as recipient", async () => {
    mockSend.mockResolvedValue({ id: "tx-456", status: "completed", tokens: [] });
    const hexKey = "a".repeat(64);

    await sendTokensTool.execute("call-2", {
      recipient: hexKey,
      amount: "50",
      coinId: "ALPHA",
    });

    expect(mockSend).toHaveBeenCalledWith({
      recipient: hexKey,
      amount: "50",
      coinId: "ALPHA",
      memo: undefined,
    });
  });

  it("returns error message when transfer fails", async () => {
    mockSend.mockResolvedValue({ id: "tx-err", status: "failed", tokens: [], error: "Insufficient balance" });

    const result = await sendTokensTool.execute("call-3", {
      recipient: "@bob",
      amount: "9999",
      coinId: "ALPHA",
    });

    expect(result.content[0].text).toContain("Transfer failed");
    expect(result.content[0].text).toContain("Insufficient balance");
  });

  it("rejects invalid recipient format", async () => {
    await expect(
      sendTokensTool.execute("call-4", {
        recipient: "not valid!",
        amount: "100",
        coinId: "ALPHA",
      }),
    ).rejects.toThrow("Invalid recipient format");
  });

  it("propagates send errors", async () => {
    mockSend.mockRejectedValue(new Error("network error"));

    await expect(
      sendTokensTool.execute("call-5", {
        recipient: "@alice",
        amount: "100",
        coinId: "ALPHA",
      }),
    ).rejects.toThrow("network error");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendDM = vi.fn();
const mockGetSphere = vi.fn();

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

const { sendMessageTool } = await import("../../src/tools/send-message.js");

describe("sendMessageTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      communications: { sendDM: mockSendDM },
    });
  });

  it("has correct name and description", () => {
    expect(sendMessageTool.name).toBe("uniclaw_send_message");
    expect(sendMessageTool.description).toContain("direct message");
  });

  it("calls sphere.communications.sendDM with correct args", async () => {
    mockSendDM.mockResolvedValue({ id: "dm-42" });

    const result = await sendMessageTool.execute("call-1", {
      recipient: "@alice",
      message: "Hello Alice!",
    });

    expect(mockSendDM).toHaveBeenCalledWith("alice", "Hello Alice!");
    expect(result.content[0].text).toContain("@alice");
    expect(result.content[0].text).toContain("dm-42");
  });

  it("accepts a 64-char hex pubkey as recipient", async () => {
    mockSendDM.mockResolvedValue({ id: "dm-99" });
    const hexKey = "a".repeat(64);

    await sendMessageTool.execute("call-3", {
      recipient: hexKey,
      message: "hi",
    });

    expect(mockSendDM).toHaveBeenCalledWith(hexKey, "hi");
  });

  it("rejects invalid recipient format", async () => {
    await expect(
      sendMessageTool.execute("call-4", {
        recipient: "not valid!",
        message: "hi",
      }),
    ).rejects.toThrow("Invalid recipient format");
  });

  it("rejects empty recipient", async () => {
    await expect(
      sendMessageTool.execute("call-5", {
        recipient: "",
        message: "hi",
      }),
    ).rejects.toThrow("Invalid recipient format");
  });

  it("propagates sendDM errors", async () => {
    mockSendDM.mockRejectedValue(new Error("relay unreachable"));

    await expect(
      sendMessageTool.execute("call-2", {
        recipient: "@bob",
        message: "test",
      }),
    ).rejects.toThrow("relay unreachable");
  });
});

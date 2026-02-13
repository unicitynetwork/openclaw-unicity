import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendMessage = vi.fn();
const mockGetSphere = vi.fn();

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

const { sendGroupMessageTool } = await import("../../src/tools/send-group-message.js");

describe("sendGroupMessageTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      groupChat: { sendMessage: mockSendMessage },
    });
  });

  it("has correct name and description", () => {
    expect(sendGroupMessageTool.name).toBe("unicity_send_group_message");
    expect(sendGroupMessageTool.description).toContain("group chat");
  });

  it("sends a message to a group", async () => {
    mockSendMessage.mockResolvedValue({ id: "msg-1" });

    const result = await sendGroupMessageTool.execute("call-1", {
      groupId: "grp-1",
      message: "Hello group!",
    });

    expect(mockSendMessage).toHaveBeenCalledWith("grp-1", "Hello group!", undefined);
    expect(result.content[0].text).toContain("grp-1");
    expect(result.content[0].text).toContain("msg-1");
  });

  it("sends a reply to a specific message", async () => {
    mockSendMessage.mockResolvedValue({ id: "msg-2" });

    const result = await sendGroupMessageTool.execute("call-2", {
      groupId: "grp-1",
      message: "Reply here",
      replyToId: "msg-0",
    });

    expect(mockSendMessage).toHaveBeenCalledWith("grp-1", "Reply here", "msg-0");
    expect(result.content[0].text).toContain("msg-2");
  });

  it("propagates sendMessage errors", async () => {
    mockSendMessage.mockRejectedValue(new Error("group not found"));

    await expect(
      sendGroupMessageTool.execute("call-3", {
        groupId: "grp-bad",
        message: "test",
      }),
    ).rejects.toThrow("group not found");
  });
});

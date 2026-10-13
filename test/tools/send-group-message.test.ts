import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendMessage = vi.fn();
const mockGetSphereOrNull = vi.fn();

vi.mock("../../src/sphere.js", () => ({ getSphereOrNull: () => mockGetSphereOrNull() }));
vi.mock("../../src/assets.js", () => ({ formatAmount: vi.fn() }));

const { sendGroupMessageTool } = await import("../../src/tools/send-group-message.js");

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const GROUP_ID = "trading-floor-0123456789abcdef";

describe("sendGroupMessageTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphereOrNull.mockReturnValue({ groupChat: { sendMessage: mockSendMessage } });
  });

  it("has the right name and an owner-only description", () => {
    expect(sendGroupMessageTool.name).toBe("unicity_send_group_message");
    expect(sendGroupMessageTool.description).toContain("Owner only (enforced by the plugin)");
  });

  it("sends the message (optionally as a reply) and reports its id", async () => {
    mockSendMessage.mockResolvedValue({ id: "evt-1", groupId: GROUP_ID });
    const result = await sendGroupMessageTool.execute("c1", { groupId: GROUP_ID, message: "gm", replyToId: "evt-0" });
    expect(mockSendMessage).toHaveBeenCalledWith(GROUP_ID, "gm", "evt-0");
    expect(text(result)).toBe(`Message sent to group ${GROUP_ID} (id: evt-1)`);
  });

  it("omits an empty replyToId", async () => {
    mockSendMessage.mockResolvedValue({ groupId: "grp1" });
    const result = await sendGroupMessageTool.execute("c2", { groupId: "grp1", message: "gm", replyToId: " " });
    expect(mockSendMessage).toHaveBeenCalledWith("grp1", "gm", undefined);
    expect(text(result)).toBe("Message sent to group grp1");
  });

  it("treats a null SDK result (not joined / rejected) as a failure", async () => {
    mockSendMessage.mockResolvedValue(null);
    const result = await sendGroupMessageTool.execute("c3", { groupId: "grp1", message: "gm" });
    expect(result.details).toMatchObject({ status: "error", code: "send_failed" });
    expect(text(result)).toContain("not a member");
  });

  it("returns an error result when the SDK throws", async () => {
    mockSendMessage.mockRejectedValue(new Error("relay down"));
    const result = await sendGroupMessageTool.execute("c4", { groupId: "grp1", message: "gm" });
    expect(result.details).toMatchObject({ status: "error", code: "send_failed" });
  });

  it("rejects invalid group ids", async () => {
    const result = await sendGroupMessageTool.execute("c5", { groupId: "@alice x", message: "gm" });
    expect(result.details).toMatchObject({ status: "error", code: "invalid_group_id" });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("reports disabled group chat and a missing wallet", async () => {
    mockGetSphereOrNull.mockReturnValue({ groupChat: null });
    expect((await sendGroupMessageTool.execute("c6", { groupId: "grp1", message: "x" })).details).toMatchObject({
      code: "group_chat_disabled",
    });
    mockGetSphereOrNull.mockReturnValue(null);
    expect((await sendGroupMessageTool.execute("c7", { groupId: "grp1", message: "x" })).details).toMatchObject({
      code: "wallet_not_ready",
    });
  });
});

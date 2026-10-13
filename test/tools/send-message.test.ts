import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendDM = vi.fn();
const mockGetSphereOrNull = vi.fn();

vi.mock("../../src/sphere.js", () => ({ getSphereOrNull: () => mockGetSphereOrNull() }));
vi.mock("../../src/assets.js", () => ({ formatAmount: vi.fn() }));

const { sendMessageTool } = await import("../../src/tools/send-message.js");

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

describe("sendMessageTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphereOrNull.mockReturnValue({ communications: { sendDM: mockSendDM } });
  });

  it("has the right name and an owner-only description without the old IsOwner header", () => {
    expect(sendMessageTool.name).toBe("unicity_send_message");
    expect(sendMessageTool.description).toContain("Owner only (enforced by the plugin)");
    expect(sendMessageTool.description).not.toContain("IsOwner");
  });

  it("sends the DM to the trimmed recipient and reports the message id", async () => {
    mockSendDM.mockResolvedValue({ id: "dm-42" });
    const result = await sendMessageTool.execute("c1", { recipient: "  @alice ", message: "Hello Alice!" });
    expect(mockSendDM).toHaveBeenCalledWith("@alice", "Hello Alice!");
    expect(text(result)).toContain("@alice");
    expect(text(result)).toContain("dm-42");
    expect(result.details).toEqual({ recipient: "@alice", messageId: "dm-42" });
  });

  it("accepts 64-hex, 66-hex chain keys and DIRECT:// addresses", async () => {
    mockSendDM.mockResolvedValue({ id: "dm" });
    for (const recipient of ["a".repeat(64), `02${"b".repeat(64)}`, `DIRECT://${"c".repeat(40)}`]) {
      await sendMessageTool.execute("c2", { recipient, message: "hi" });
      expect(mockSendDM).toHaveBeenLastCalledWith(recipient, "hi");
    }
  });

  it("rejects PROXY: and malformed recipients without sending", async () => {
    for (const recipient of ["PROXY:abc", "not valid!", ""]) {
      const result = await sendMessageTool.execute("c3", { recipient, message: "hi" });
      expect(result.details).toMatchObject({ status: "error", code: "invalid_recipient" });
    }
    expect(text(await sendMessageTool.execute("c3", { recipient: "PROXY:abc", message: "hi" }))).toContain("PROXY");
    expect(mockSendDM).not.toHaveBeenCalled();
  });

  it("reports wallet_not_ready while the wallet is starting", async () => {
    mockGetSphereOrNull.mockReturnValue(null);
    const result = await sendMessageTool.execute("c4", { recipient: "@bob", message: "hi" });
    expect(result.details).toMatchObject({ status: "error", code: "wallet_not_ready" });
  });

  it("returns an error result when sendDM fails", async () => {
    mockSendDM.mockRejectedValue(new Error("relay unreachable"));
    const result = await sendMessageTool.execute("c5", { recipient: "@bob", message: "test" });
    expect(result.details).toMatchObject({ status: "error", code: "send_failed" });
    expect(text(result)).toContain("relay unreachable");
  });
});

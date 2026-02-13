import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateGroup = vi.fn();
const mockCreateInvite = vi.fn();
const mockSendDM = vi.fn();
const mockGetSphere = vi.fn();

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

const { createPrivateGroupTool } = await import("../../src/tools/create-private-group.js");

describe("createPrivateGroupTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      groupChat: { createGroup: mockCreateGroup, createInvite: mockCreateInvite },
      communications: { sendDM: mockSendDM },
    });
  });

  it("has correct name and description", () => {
    expect(createPrivateGroupTool.name).toBe("unicity_create_private_group");
    expect(createPrivateGroupTool.description).toContain("private");
    expect(createPrivateGroupTool.description).toContain("invite");
  });

  it("creates a private group and returns join code", async () => {
    mockCreateGroup.mockResolvedValue({ id: "grp-1", name: "Secret Club" });
    mockCreateInvite.mockResolvedValue("inv-abc");

    const result = await createPrivateGroupTool.execute("call-1", {
      name: "Secret Club",
    });

    expect(mockCreateGroup).toHaveBeenCalledWith({
      name: "Secret Club",
      description: undefined,
      visibility: "private",
    });
    expect(mockCreateInvite).toHaveBeenCalledWith("grp-1");
    expect(result.content[0].text).toContain("Secret Club");
    expect(result.content[0].text).toContain("grp-1");
    expect(result.content[0].text).toContain("inv-abc");
    expect(mockSendDM).not.toHaveBeenCalled();
  });

  it("sends invite DMs to invitees", async () => {
    mockCreateGroup.mockResolvedValue({ id: "grp-2", name: "Private Chat" });
    mockCreateInvite.mockResolvedValue("inv-xyz");
    mockSendDM.mockResolvedValue({ id: "dm-1" });

    const result = await createPrivateGroupTool.execute("call-2", {
      name: "Private Chat",
      description: "Top secret",
      invitees: ["@alice", "@bob"],
    });

    expect(mockSendDM).toHaveBeenCalledTimes(2);
    expect(mockSendDM).toHaveBeenCalledWith("@alice", expect.stringContaining("inv-xyz"));
    expect(mockSendDM).toHaveBeenCalledWith("@bob", expect.stringContaining("inv-xyz"));
    expect(mockSendDM).toHaveBeenCalledWith("@alice", expect.stringContaining("Private Chat"));
    expect(result.content[0].text).toContain("Invite sent to: @alice, @bob");
  });

  it("reports failed invitee DMs", async () => {
    mockCreateGroup.mockResolvedValue({ id: "grp-3", name: "Group" });
    mockCreateInvite.mockResolvedValue("inv-123");
    mockSendDM.mockRejectedValue(new Error("relay down"));

    const result = await createPrivateGroupTool.execute("call-3", {
      name: "Group",
      invitees: ["@alice"],
    });

    expect(result.content[0].text).toContain("Failed to invite: @alice");
    expect(result.content[0].text).not.toContain("Invite sent to");
  });

  it("rejects invalid invitee format", async () => {
    mockCreateGroup.mockResolvedValue({ id: "grp-4", name: "Group" });
    mockCreateInvite.mockResolvedValue("inv-456");

    const result = await createPrivateGroupTool.execute("call-4", {
      name: "Group",
      invitees: ["not valid!"],
    });

    expect(mockSendDM).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Failed to invite: not valid!");
  });

  it("propagates createGroup errors", async () => {
    mockCreateGroup.mockRejectedValue(new Error("relay error"));

    await expect(
      createPrivateGroupTool.execute("call-5", { name: "Fail" }),
    ).rejects.toThrow("relay error");
  });
});

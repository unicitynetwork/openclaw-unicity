import { describe, it, expect, vi, beforeEach } from "vitest";

const mockJoinGroup = vi.fn();
const mockGetSphere = vi.fn();

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

const { joinGroupTool } = await import("../../src/tools/join-group.js");

describe("joinGroupTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      groupChat: { joinGroup: mockJoinGroup },
    });
  });

  it("has correct name and description", () => {
    expect(joinGroupTool.name).toBe("unicity_join_group");
    expect(joinGroupTool.description).toContain("Join");
  });

  it("joins a public group without invite code", async () => {
    mockJoinGroup.mockResolvedValue(undefined);

    const result = await joinGroupTool.execute("call-1", {
      groupId: "grp-1",
    });

    expect(mockJoinGroup).toHaveBeenCalledWith("grp-1", undefined);
    expect(result.content[0].text).toContain("grp-1");
    expect(result.content[0].text).toContain("Successfully joined");
  });

  it("joins a private group with invite code", async () => {
    mockJoinGroup.mockResolvedValue(undefined);

    const result = await joinGroupTool.execute("call-2", {
      groupId: "grp-2",
      inviteCode: "secret-code",
    });

    expect(mockJoinGroup).toHaveBeenCalledWith("grp-2", "secret-code");
    expect(result.content[0].text).toContain("grp-2");
  });

  it("propagates joinGroup errors", async () => {
    mockJoinGroup.mockRejectedValue(new Error("invalid invite"));

    await expect(
      joinGroupTool.execute("call-3", { groupId: "grp-3", inviteCode: "bad" }),
    ).rejects.toThrow("invalid invite");
  });
});

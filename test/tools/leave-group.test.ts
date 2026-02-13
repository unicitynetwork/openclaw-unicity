import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLeaveGroup = vi.fn();
const mockGetSphere = vi.fn();

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

const { leaveGroupTool } = await import("../../src/tools/leave-group.js");

describe("leaveGroupTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      groupChat: { leaveGroup: mockLeaveGroup },
    });
  });

  it("has correct name and description", () => {
    expect(leaveGroupTool.name).toBe("unicity_leave_group");
    expect(leaveGroupTool.description).toContain("Leave");
  });

  it("leaves a group", async () => {
    mockLeaveGroup.mockResolvedValue(undefined);

    const result = await leaveGroupTool.execute("call-1", {
      groupId: "grp-1",
    });

    expect(mockLeaveGroup).toHaveBeenCalledWith("grp-1");
    expect(result.content[0].text).toContain("Left group grp-1");
  });

  it("propagates leaveGroup errors", async () => {
    mockLeaveGroup.mockRejectedValue(new Error("not a member"));

    await expect(
      leaveGroupTool.execute("call-2", { groupId: "grp-2" }),
    ).rejects.toThrow("not a member");
  });
});

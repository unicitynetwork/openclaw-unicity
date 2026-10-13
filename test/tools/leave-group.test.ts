import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLeaveGroup = vi.fn();
const mockGetGroup = vi.fn();
const mockGetSphereOrNull = vi.fn();
const mockRevokeGroup = vi.fn();

vi.mock("../../src/sphere.js", () => ({ getSphereOrNull: () => mockGetSphereOrNull() }));
vi.mock("../../src/assets.js", () => ({ formatAmount: vi.fn() }));
vi.mock("../../src/storage.js", () => ({ revokeGroup: (...args: unknown[]) => mockRevokeGroup(...args) }));

const { leaveGroupTool } = await import("../../src/tools/leave-group.js");

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const WALLET_KEY = `02${"a".repeat(64)}`;

describe("leaveGroupTool", () => {
  let joined: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    joined = true;
    mockRevokeGroup.mockImplementation(() => undefined);
    mockGetSphereOrNull.mockReturnValue({
      identity: { chainPubkey: WALLET_KEY },
      groupChat: { leaveGroup: mockLeaveGroup, getGroup: mockGetGroup },
    });
    // Like the SDK: the group disappears from local state once left.
    mockGetGroup.mockImplementation((id: string) => (joined ? { id, name: "Trading Floor" } : null));
    mockLeaveGroup.mockImplementation(async () => {
      joined = false;
      return true;
    });
  });

  it("has the right name and an owner-only description", () => {
    expect(leaveGroupTool.name).toBe("unicity_leave_group");
    expect(leaveGroupTool.description).toContain("Owner only (enforced by the plugin)");
  });

  it("leaves the group and names it (read before leaving)", async () => {
    const result = await leaveGroupTool.execute("c1", { groupId: "grp1" });
    expect(mockLeaveGroup).toHaveBeenCalledWith("grp1");
    expect(text(result)).toBe('Left group "Trading Floor" (id: grp1)');
  });

  it("withdraws the group's approval once left, so a re-add by a group admin is ignored again", async () => {
    await leaveGroupTool.execute("c1", { groupId: "grp1" });
    expect(mockRevokeGroup).toHaveBeenCalledWith(WALLET_KEY, "grp1");
  });

  it("still reports the leave when withdrawing the approval fails, with a warning", async () => {
    mockRevokeGroup.mockImplementation(() => {
      throw new Error("groups-approved.json is corrupt");
    });
    const result = await leaveGroupTool.execute("c1", { groupId: "grp1" });
    expect(result.details).toEqual({ groupId: "grp1" });
    expect(text(result)).toContain('Left group "Trading Floor" (id: grp1)');
    expect(text(result)).toContain("could not withdraw the group's approval (groups-approved.json is corrupt)");
    mockGetSphereOrNull.mockReturnValue({ groupChat: { leaveGroup: mockLeaveGroup, getGroup: mockGetGroup } });
    expect(text(await leaveGroupTool.execute("c2", { groupId: "grp1" }))).toContain("the wallet identity is not available");
  });

  it("keeps the approval when the leave did not happen", async () => {
    mockLeaveGroup.mockResolvedValueOnce(false);
    await leaveGroupTool.execute("c1", { groupId: "grp1" });
    mockLeaveGroup.mockRejectedValueOnce(new Error("relay down"));
    await leaveGroupTool.execute("c2", { groupId: "grp1" });
    expect(mockRevokeGroup).not.toHaveBeenCalled();
  });

  it("strips control characters and backticks from the relay-provided group name", async () => {
    mockGetGroup.mockImplementation((id: string) => (joined ? { id, name: "Evil\u001b]0;x\u0007 `name`" } : null));
    const result = await leaveGroupTool.execute("c1", { groupId: "grp1" });
    expect(text(result)).toBe('Left group "Evil ]0;x name" (id: grp1)');
  });

  it("treats a false SDK result as a failure", async () => {
    mockLeaveGroup.mockResolvedValue(false);
    const result = await leaveGroupTool.execute("c2", { groupId: "grp1" });
    expect(result.details).toMatchObject({ status: "error", code: "leave_failed" });
  });

  it("returns an error result when the SDK throws", async () => {
    mockLeaveGroup.mockRejectedValue(new Error("relay down"));
    const result = await leaveGroupTool.execute("c3", { groupId: "grp1" });
    expect(result.details).toMatchObject({ status: "error", code: "leave_failed" });
    expect(text(result)).toContain("relay down");
  });

  it("rejects invalid group ids", async () => {
    const result = await leaveGroupTool.execute("c4", { groupId: "../etc" });
    expect(result.details).toMatchObject({ status: "error", code: "invalid_group_id" });
    expect(mockLeaveGroup).not.toHaveBeenCalled();
  });

  it("reports disabled group chat and a missing wallet", async () => {
    mockGetSphereOrNull.mockReturnValue({ groupChat: null });
    expect((await leaveGroupTool.execute("c5", { groupId: "grp1" })).details).toMatchObject({ code: "group_chat_disabled" });
    mockGetSphereOrNull.mockReturnValue(null);
    expect((await leaveGroupTool.execute("c6", { groupId: "grp1" })).details).toMatchObject({ code: "wallet_not_ready" });
  });
});

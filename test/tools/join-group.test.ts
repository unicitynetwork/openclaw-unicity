import { describe, it, expect, vi, beforeEach } from "vitest";

const mockJoinGroup = vi.fn();
const mockGetGroup = vi.fn();
const mockGetSphereOrNull = vi.fn();
const mockApproveGroup = vi.fn();
/** Order of group-op markers, SDK joins and approvals. */
const events: string[] = [];

vi.mock("../../src/sphere.js", () => ({ getSphereOrNull: () => mockGetSphereOrNull() }));
vi.mock("../../src/assets.js", () => ({ formatAmount: vi.fn() }));
vi.mock("../../src/storage.js", () => ({ approveGroup: (...args: unknown[]) => mockApproveGroup(...args) }));
vi.mock("../../src/group-ops.js", () => ({
  beginGroupOp: () => events.push("begin"),
  endGroupOp: () => events.push("end"),
}));

const { joinGroupTool } = await import("../../src/tools/join-group.js");

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const LONG_ID = "a-very-long-group-slug-x-0123456789abcdef";
const WALLET_KEY = `02${"a".repeat(64)}`;

describe("joinGroupTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    mockApproveGroup.mockImplementation(() => void events.push("approve"));
    mockGetSphereOrNull.mockReturnValue({
      identity: { chainPubkey: WALLET_KEY },
      groupChat: { joinGroup: mockJoinGroup, getGroup: mockGetGroup },
    });
    mockJoinGroup.mockImplementation(async () => {
      events.push("join");
      return true;
    });
    mockGetGroup.mockReturnValue({ id: LONG_ID, name: "Long\nName" });
  });

  it("has the right name and an owner-only description", () => {
    expect(joinGroupTool.name).toBe("unicity_join_group");
    expect(joinGroupTool.description).toContain("Owner only (enforced by the plugin)");
  });

  it("joins a new-format group id with an invite code", async () => {
    const result = await joinGroupTool.execute("c1", { groupId: ` ${LONG_ID} `, inviteCode: "code-1" });
    expect(mockJoinGroup).toHaveBeenCalledWith(LONG_ID, "code-1");
    expect(text(result)).toBe(`Joined group "Long Name" (id: ${LONG_ID})`);
  });

  it("records the joined group as sanctioned for this wallet, so the channel dispatches its messages", async () => {
    await joinGroupTool.execute("c1", { groupId: LONG_ID });
    expect(mockApproveGroup).toHaveBeenCalledWith(WALLET_KEY, LONG_ID);
  });

  it("marks a group operation in flight from before the join until the approval is recorded", async () => {
    // The SDK lists the group (and the relay streams its backlog) before joinGroup resolves; the channel holds its
    // "added without approval" notice while an operation is in flight.
    await joinGroupTool.execute("c1", { groupId: LONG_ID });
    expect(events).toEqual(["begin", "join", "approve", "end"]);
  });

  it("ends the group operation when the join fails or throws, and starts none for a rejected id", async () => {
    mockJoinGroup.mockImplementationOnce(async () => {
      events.push("join");
      return false;
    });
    await joinGroupTool.execute("c1", { groupId: LONG_ID });
    expect(events).toEqual(["begin", "join", "end"]);
    events.length = 0;
    mockJoinGroup.mockImplementationOnce(async () => {
      events.push("join");
      throw new Error("timeout");
    });
    await joinGroupTool.execute("c1", { groupId: LONG_ID });
    expect(events).toEqual(["begin", "join", "end"]);
    events.length = 0;
    await joinGroupTool.execute("c1", { groupId: "not a group!" });
    expect(events).toEqual([]);
  });

  it("still reports the join when recording the approval fails, with a warning", async () => {
    mockApproveGroup.mockImplementation(() => {
      throw new Error("disk full");
    });
    const result = await joinGroupTool.execute("c1", { groupId: LONG_ID });
    expect(result.details).toEqual({ groupId: LONG_ID });
    expect(text(result)).toContain(`Joined group "Long Name" (id: ${LONG_ID})`);
    expect(text(result)).toContain("could not record the group as approved (disk full)");
  });

  it("strips control characters and backticks from the relay-provided group name", async () => {
    mockGetGroup.mockReturnValue({ id: LONG_ID, name: "a\u001b[2Jb\u0000`x`" });
    const result = await joinGroupTool.execute("c1", { groupId: LONG_ID });
    expect(text(result)).toBe(`Joined group "a [2Jb x" (id: ${LONG_ID})`);
  });

  it("joins a short alphanumeric id without a code", async () => {
    mockGetGroup.mockReturnValue(null);
    const result = await joinGroupTool.execute("c2", { groupId: "grp1", inviteCode: "  " });
    expect(mockJoinGroup).toHaveBeenCalledWith("grp1", undefined);
    expect(text(result)).toBe("Joined group (id: grp1)");
  });

  it("treats a false SDK result as a failure and approves nothing", async () => {
    mockJoinGroup.mockResolvedValue(false);
    const result = await joinGroupTool.execute("c3", { groupId: "grp1" });
    expect(result.details).toMatchObject({ status: "error", code: "join_failed" });
    expect(mockApproveGroup).not.toHaveBeenCalled();
  });

  it("returns an error result when the SDK throws", async () => {
    mockJoinGroup.mockRejectedValue(new Error("timeout"));
    const result = await joinGroupTool.execute("c4", { groupId: "grp1" });
    expect(result.details).toMatchObject({ status: "error", code: "join_failed" });
    expect(text(result)).toContain("timeout");
  });

  it("rejects invalid group ids without calling the SDK", async () => {
    const result = await joinGroupTool.execute("c5", { groupId: "not a group!" });
    expect(result.details).toMatchObject({ status: "error", code: "invalid_group_id" });
    expect(mockJoinGroup).not.toHaveBeenCalled();
  });

  it("reports disabled group chat and a missing wallet", async () => {
    mockGetSphereOrNull.mockReturnValue({ groupChat: null });
    expect((await joinGroupTool.execute("c6", { groupId: "grp1" })).details).toMatchObject({ code: "group_chat_disabled" });
    mockGetSphereOrNull.mockReturnValue(null);
    expect((await joinGroupTool.execute("c7", { groupId: "grp1" })).details).toMatchObject({ code: "wallet_not_ready" });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateGroup = vi.fn();
const mockCreateInvite = vi.fn();
const mockSendDM = vi.fn();
const mockGetSphereOrNull = vi.fn();
const mockApproveGroup = vi.fn();
/** Order of group-op markers, SDK calls, approvals and invite DMs. */
const events: string[] = [];

vi.mock("../../src/sphere.js", () => ({ getSphereOrNull: () => mockGetSphereOrNull() }));
vi.mock("../../src/assets.js", () => ({ formatAmount: vi.fn() }));
vi.mock("../../src/storage.js", () => ({ approveGroup: (...args: unknown[]) => mockApproveGroup(...args) }));
vi.mock("../../src/group-ops.js", () => ({
  beginGroupOp: () => events.push("begin"),
  endGroupOp: () => events.push("end"),
}));

const { createPrivateGroupTool } = await import("../../src/tools/create-private-group.js");

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const GROUP_ID = "strategy-0123456789abcdef";
const WALLET_KEY = `02${"a".repeat(64)}`;

describe("createPrivateGroupTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    mockApproveGroup.mockImplementation(() => void events.push("approve"));
    mockGetSphereOrNull.mockReturnValue({
      identity: { chainPubkey: WALLET_KEY },
      groupChat: { createGroup: mockCreateGroup, createInvite: mockCreateInvite },
      communications: { sendDM: mockSendDM },
    });
    mockCreateGroup.mockResolvedValue({ id: GROUP_ID, name: "Strategy", visibility: "PRIVATE" });
    mockCreateInvite.mockResolvedValue("join-code-1");
    mockSendDM.mockResolvedValue({ id: "dm" });
  });

  it("has the right name and an owner-only description", () => {
    expect(createPrivateGroupTool.name).toBe("unicity_create_private_group");
    expect(createPrivateGroupTool.description).toContain("Owner only (enforced by the plugin)");
  });

  it("creates a PRIVATE group, makes an invite and DMs it to every invitee", async () => {
    const result = await createPrivateGroupTool.execute("c1", { name: "Strategy", invitees: ["@alice", " @bob "] });
    expect(mockCreateGroup).toHaveBeenCalledWith({ name: "Strategy", description: undefined, visibility: "PRIVATE" });
    expect(mockCreateInvite).toHaveBeenCalledWith(GROUP_ID);
    expect(mockSendDM).toHaveBeenCalledTimes(2);
    expect(mockSendDM).toHaveBeenCalledWith("@bob", expect.stringContaining("join-code-1"));
    expect(mockSendDM.mock.calls[0][1]).toContain(GROUP_ID);
    expect(text(result)).toContain("Join code: join-code-1");
    expect(text(result)).toContain("Invite sent to: @alice, @bob");
    expect(result.details).toMatchObject({ groupId: GROUP_ID, invited: ["@alice", "@bob"], failed: [] });
    expect(mockApproveGroup).toHaveBeenCalledWith(WALLET_KEY, GROUP_ID);
    expect(text(result)).not.toContain("Warning");
  });

  it("marks a group operation in flight from before the create until the approval is recorded, not while inviting", async () => {
    mockCreateGroup.mockImplementation(async () => {
      events.push("create");
      return { id: GROUP_ID, name: "Strategy", visibility: "PRIVATE" };
    });
    mockSendDM.mockImplementation(async () => {
      events.push("dm");
      return { id: "dm" };
    });
    await createPrivateGroupTool.execute("c1", { name: "Strategy", invitees: ["@alice"] });
    expect(events).toEqual(["begin", "create", "approve", "end", "dm"]);
  });

  it("ends the group operation when the create returns nothing or throws", async () => {
    mockCreateGroup.mockImplementationOnce(async () => {
      events.push("create");
      return null;
    });
    await createPrivateGroupTool.execute("c1", { name: "Strategy" });
    expect(events).toEqual(["begin", "create", "end"]);
    events.length = 0;
    mockCreateGroup.mockImplementationOnce(async () => {
      events.push("create");
      throw new Error("relay down");
    });
    const result = await createPrivateGroupTool.execute("c1", { name: "Strategy" });
    expect(result.details).toMatchObject({ status: "error", code: "create_failed" });
    expect(events).toEqual(["begin", "create", "end"]);
  });

  it("approves the group even when no join code could be made", async () => {
    mockCreateInvite.mockResolvedValue(null);
    await createPrivateGroupTool.execute("c1", { name: "Strategy" });
    expect(mockApproveGroup).toHaveBeenCalledWith(WALLET_KEY, GROUP_ID);
  });

  it("validates every invitee before creating anything", async () => {
    const result = await createPrivateGroupTool.execute("c2", { name: "Strategy", invitees: ["@alice", "PROXY:xyz"] });
    expect(result.details).toMatchObject({ status: "error", code: "invalid_recipient" });
    expect(text(result)).toContain("No group was created");
    expect(mockCreateGroup).not.toHaveBeenCalled();
  });

  it("lists invitees whose DM failed", async () => {
    mockSendDM.mockRejectedValueOnce(new Error("unknown nametag"));
    const result = await createPrivateGroupTool.execute("c3", { name: "Strategy", invitees: ["@ghost", "@bob"] });
    expect(text(result)).toContain("Failed to invite: @ghost");
    expect(text(result)).toContain("Invite sent to: @bob");
  });

  it("reports a created group without an invite code as a failure that must not be retried", async () => {
    mockCreateInvite.mockResolvedValue(null);
    const result = await createPrivateGroupTool.execute("c4", { name: "Strategy", invitees: ["@alice"] });
    expect(result.details).toMatchObject({ status: "error", code: "invite_failed", groupId: GROUP_ID });
    expect(text(result)).toContain("Do not create the group again");
    expect(mockSendDM).not.toHaveBeenCalled();
  });

  it("treats a null createGroup result as a failure", async () => {
    mockCreateGroup.mockResolvedValue(null);
    const result = await createPrivateGroupTool.execute("c5", { name: "Strategy" });
    expect(result.details).toMatchObject({ status: "error", code: "create_failed" });
    expect(mockCreateInvite).not.toHaveBeenCalled();
  });

  it("reports disabled group chat and a missing wallet", async () => {
    mockGetSphereOrNull.mockReturnValue({ identity: { chainPubkey: WALLET_KEY }, groupChat: null, communications: { sendDM: mockSendDM } });
    expect((await createPrivateGroupTool.execute("c6", { name: "x" })).details).toMatchObject({ code: "group_chat_disabled" });
    mockGetSphereOrNull.mockReturnValue(null);
    expect((await createPrivateGroupTool.execute("c7", { name: "x" })).details).toMatchObject({ code: "wallet_not_ready" });
  });
});

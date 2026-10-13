import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateGroup = vi.fn();
const mockGetSphereOrNull = vi.fn();
const mockApproveGroup = vi.fn();
/** Order of group-op markers, SDK creates and approvals. */
const events: string[] = [];

vi.mock("../../src/sphere.js", () => ({ getSphereOrNull: () => mockGetSphereOrNull() }));
vi.mock("../../src/assets.js", () => ({ formatAmount: vi.fn() }));
vi.mock("../../src/storage.js", () => ({ approveGroup: (...args: unknown[]) => mockApproveGroup(...args) }));
vi.mock("../../src/group-ops.js", () => ({
  beginGroupOp: () => events.push("begin"),
  endGroupOp: () => events.push("end"),
}));

const { createPublicGroupTool } = await import("../../src/tools/create-public-group.js");

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const GROUP_ID = "trading-floor-0123456789abcdef";
const WALLET_KEY = `02${"a".repeat(64)}`;

describe("createPublicGroupTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    mockApproveGroup.mockImplementation(() => void events.push("approve"));
    mockGetSphereOrNull.mockReturnValue({ identity: { chainPubkey: WALLET_KEY }, groupChat: { createGroup: mockCreateGroup } });
  });

  it("has the right name and an owner-only description", () => {
    expect(createPublicGroupTool.name).toBe("unicity_create_public_group");
    expect(createPublicGroupTool.description).toContain("Owner only (enforced by the plugin)");
  });

  it("creates a PUBLIC group and returns its full id", async () => {
    mockCreateGroup.mockResolvedValue({ id: GROUP_ID, name: "Trading Floor", visibility: "PUBLIC" });
    const result = await createPublicGroupTool.execute("c1", { name: " Trading Floor ", description: "deals" });
    expect(mockCreateGroup).toHaveBeenCalledWith({ name: "Trading Floor", description: "deals", visibility: "PUBLIC" });
    expect(text(result)).toBe(`Public group created: Trading Floor (id: ${GROUP_ID})`);
    expect(result.details).toMatchObject({ groupId: GROUP_ID, visibility: "public" });
    expect(mockApproveGroup).toHaveBeenCalledWith(WALLET_KEY, GROUP_ID);
  });

  it("marks a group operation in flight from before the create until the approval is recorded", async () => {
    mockCreateGroup.mockImplementation(async () => {
      events.push("create");
      return { id: GROUP_ID, name: "Trading Floor", visibility: "PUBLIC" };
    });
    await createPublicGroupTool.execute("c1", { name: "Trading Floor" });
    expect(events).toEqual(["begin", "create", "approve", "end"]);
  });

  it("ends the group operation when the create returns nothing or throws", async () => {
    mockCreateGroup.mockImplementationOnce(async () => {
      events.push("create");
      return null;
    });
    await createPublicGroupTool.execute("c1", { name: "x" });
    expect(events).toEqual(["begin", "create", "end"]);
    events.length = 0;
    mockCreateGroup.mockImplementationOnce(async () => {
      events.push("create");
      throw new Error("relay down");
    });
    await createPublicGroupTool.execute("c1", { name: "x" });
    expect(events).toEqual(["begin", "create", "end"]);
  });

  it("never reports a created group as failed when recording the approval fails", async () => {
    mockCreateGroup.mockResolvedValue({ id: GROUP_ID, name: "Trading Floor", visibility: "PUBLIC" });
    mockApproveGroup.mockImplementation(() => {
      throw new Error("disk full");
    });
    const result = await createPublicGroupTool.execute("c1", { name: "Trading Floor" });
    expect(result.details).not.toHaveProperty("status");
    expect(text(result)).toContain(`Public group created: Trading Floor (id: ${GROUP_ID})`);
    expect(text(result)).toContain("could not record the group as approved");
  });

  it("treats a null SDK result as a failure", async () => {
    mockCreateGroup.mockResolvedValue(null);
    const result = await createPublicGroupTool.execute("c2", { name: "x" });
    expect(result.details).toMatchObject({ status: "error", code: "create_failed" });
    expect(mockApproveGroup).not.toHaveBeenCalled();
  });

  it("returns an error result when the SDK throws", async () => {
    mockCreateGroup.mockRejectedValue(new Error("relay down"));
    const result = await createPublicGroupTool.execute("c3", { name: "x" });
    expect(result.details).toMatchObject({ status: "error", code: "create_failed" });
    expect(text(result)).toContain("relay down");
  });

  it("reports disabled group chat, a missing wallet and an empty name", async () => {
    mockGetSphereOrNull.mockReturnValue({ groupChat: null });
    expect((await createPublicGroupTool.execute("c4", { name: "x" })).details).toMatchObject({ code: "group_chat_disabled" });
    expect(text(await createPublicGroupTool.execute("c4", { name: "x" }))).toContain("Group chat is disabled");
    mockGetSphereOrNull.mockReturnValue(null);
    expect((await createPublicGroupTool.execute("c5", { name: "x" })).details).toMatchObject({ code: "wallet_not_ready" });
    expect((await createPublicGroupTool.execute("c6", { name: "  " })).details).toMatchObject({ code: "invalid_name" });
  });
});

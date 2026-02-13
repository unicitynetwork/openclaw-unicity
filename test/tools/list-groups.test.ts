import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetGroups = vi.fn();
const mockFetchAvailableGroups = vi.fn();
const mockGetSphere = vi.fn();

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

const { listGroupsTool } = await import("../../src/tools/list-groups.js");

describe("listGroupsTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      groupChat: {
        getGroups: mockGetGroups,
        fetchAvailableGroups: mockFetchAvailableGroups,
      },
    });
  });

  it("has correct name and description", () => {
    expect(listGroupsTool.name).toBe("unicity_list_groups");
    expect(listGroupsTool.description).toContain("group");
  });

  it("lists joined groups by default", async () => {
    mockGetGroups.mockReturnValue([
      { id: "grp-1", name: "Group One", visibility: "public", memberCount: 5, unreadCount: 2 },
      { id: "grp-2", name: "Group Two", visibility: "private", memberCount: 3, unreadCount: 0 },
    ]);

    const result = await listGroupsTool.execute("call-1", {});

    expect(mockGetGroups).toHaveBeenCalled();
    expect(mockFetchAvailableGroups).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("2 groups");
    expect(result.content[0].text).toContain("Group One");
    expect(result.content[0].text).toContain("Group Two");
    expect(result.content[0].text).toContain("5 members");
    expect(result.content[0].text).toContain("2 unread");
  });

  it("lists available groups when scope is 'available'", async () => {
    mockFetchAvailableGroups.mockResolvedValue([
      { id: "grp-3", name: "Public Chat", visibility: "public", memberCount: 10 },
    ]);

    const result = await listGroupsTool.execute("call-2", { scope: "available" });

    expect(mockFetchAvailableGroups).toHaveBeenCalled();
    expect(mockGetGroups).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("1 group");
    expect(result.content[0].text).toContain("Public Chat");
  });

  it("returns empty message for joined when no groups", async () => {
    mockGetGroups.mockReturnValue([]);

    const result = await listGroupsTool.execute("call-3", {});
    expect(result.content[0].text).toContain("Not a member");
  });

  it("returns empty message for available when no groups", async () => {
    mockFetchAvailableGroups.mockResolvedValue([]);

    const result = await listGroupsTool.execute("call-4", { scope: "available" });
    expect(result.content[0].text).toContain("No available groups");
  });
});

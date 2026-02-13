import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateGroup = vi.fn();
const mockGetSphere = vi.fn();

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

const { createPublicGroupTool } = await import("../../src/tools/create-public-group.js");

describe("createPublicGroupTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      groupChat: { createGroup: mockCreateGroup },
    });
  });

  it("has correct name and description", () => {
    expect(createPublicGroupTool.name).toBe("unicity_create_public_group");
    expect(createPublicGroupTool.description).toContain("public");
  });

  it("creates a public group", async () => {
    mockCreateGroup.mockResolvedValue({ id: "grp-1", name: "Test Group" });

    const result = await createPublicGroupTool.execute("call-1", {
      name: "Test Group",
    });

    expect(mockCreateGroup).toHaveBeenCalledWith({
      name: "Test Group",
      description: undefined,
      visibility: "public",
    });
    expect(result.content[0].text).toContain("Test Group");
    expect(result.content[0].text).toContain("grp-1");
  });

  it("passes description to createGroup", async () => {
    mockCreateGroup.mockResolvedValue({ id: "grp-2", name: "Described Group" });

    await createPublicGroupTool.execute("call-2", {
      name: "Described Group",
      description: "A nice group",
    });

    expect(mockCreateGroup).toHaveBeenCalledWith({
      name: "Described Group",
      description: "A nice group",
      visibility: "public",
    });
  });

  it("propagates createGroup errors", async () => {
    mockCreateGroup.mockRejectedValue(new Error("relay error"));

    await expect(
      createPublicGroupTool.execute("call-3", { name: "Fail" }),
    ).rejects.toThrow("relay error");
  });
});

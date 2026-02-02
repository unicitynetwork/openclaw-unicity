import { describe, it, expect, vi } from "vitest";

// Mock all heavy dependencies
vi.mock("@unicitylabs/sphere-sdk", () => ({
  Sphere: { init: vi.fn() },
}));
vi.mock("@unicitylabs/sphere-sdk/impl/nodejs", () => ({
  createNodeProviders: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn() };
});

const { default: plugin } = await import("../src/index.js");

describe("plugin definition", () => {
  it("has correct id and name", () => {
    expect(plugin.id).toBe("uniclaw");
    expect(plugin.name).toBe("Uniclaw");
  });

  it("register calls all registration methods", () => {
    const api = {
      pluginConfig: { network: "testnet" },
      config: {},
      runtime: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerChannel: vi.fn(),
      registerTool: vi.fn(),
      registerService: vi.fn(),
      registerCli: vi.fn(),
      on: vi.fn(),
    } as any;

    plugin.register(api);

    expect(api.registerChannel).toHaveBeenCalledOnce();
    expect(api.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "uniclaw_send_message" }),
      expect.objectContaining({ name: "uniclaw_send_message", optional: true }),
    );
    expect(api.registerService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "uniclaw" }),
    );
    expect(api.registerCli).toHaveBeenCalledWith(expect.any(Function), {
      commands: ["uniclaw"],
    });
    expect(api.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
  });

  it("before_agent_start hook returns undefined when sphere not active", () => {
    let hookHandler: Function | null = null;
    const api = {
      pluginConfig: {},
      config: {},
      runtime: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerChannel: vi.fn(),
      registerTool: vi.fn(),
      registerService: vi.fn(),
      registerCli: vi.fn(),
      on: vi.fn((name: string, handler: Function) => {
        if (name === "before_agent_start") hookHandler = handler;
      }),
    } as any;

    plugin.register(api);
    expect(hookHandler).not.toBeNull();

    const result = hookHandler!();
    expect(result).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the sphere-sdk before importing sphere.ts
const mockSphereInit = vi.fn();
const mockCreateNodeProviders = vi.fn();
const mockRegisterNametag = vi.fn();
const mockDestroy = vi.fn();

vi.mock("@unicitylabs/sphere-sdk", () => ({
  Sphere: { init: mockSphereInit },
}));

vi.mock("@unicitylabs/sphere-sdk/impl/nodejs", () => ({
  createNodeProviders: mockCreateNodeProviders,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn() };
});

// Dynamic import so mocks are in place
const { initSphere, getSphere, getSphereOrNull, destroySphere, getGeneratedMnemonic } =
  await import("../src/sphere.js");

describe("sphere", () => {
  const fakeSphere = {
    identity: {
      publicKey: "abc123",
      nametag: "@agent",
      address: "alpha1agent",
    },
    registerNametag: mockRegisterNametag,
    destroy: mockDestroy,
  };

  // Sphere with no nametag yet — used for mint tests
  const fakeSphereNoNametag = {
    identity: {
      publicKey: "abc123",
      nametag: undefined,
      address: "alpha1agent",
    },
    registerNametag: mockRegisterNametag,
    destroy: mockDestroy,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateNodeProviders.mockReturnValue({
      storage: {},
      transport: {},
      oracle: {},
      tokenStorage: {},
    });
  });

  afterEach(async () => {
    // Reset singleton between tests
    await destroySphere();
  });

  it("getSphereOrNull returns null before init", () => {
    expect(getSphereOrNull()).toBeNull();
  });

  it("getSphere throws before init", () => {
    expect(() => getSphere()).toThrow("Sphere not initialized");
  });

  it("initSphere creates wallet and returns sphere", async () => {
    mockSphereInit.mockResolvedValue({
      sphere: fakeSphere,
      created: true,
      generatedMnemonic: "word1 word2 word3",
    });

    const result = await initSphere({ network: "testnet" });

    expect(result.created).toBe(true);
    expect(result.generatedMnemonic).toBe("word1 word2 word3");
    expect(getSphereOrNull()).toBe(fakeSphere);
    expect(getGeneratedMnemonic()).toBe("word1 word2 word3");
  });

  it("initSphere passes network and additionalRelays to providers", async () => {
    mockSphereInit.mockResolvedValue({
      sphere: fakeSphere,
      created: false,
    });

    await initSphere({
      network: "mainnet",
      additionalRelays: ["wss://extra.relay"],
    });

    expect(mockCreateNodeProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        network: "mainnet",
        transport: { additionalRelays: ["wss://extra.relay"] },
      }),
    );
  });

  it("mints nametag when wallet has no nametag yet", async () => {
    mockSphereInit.mockResolvedValue({
      sphere: fakeSphereNoNametag,
      created: true,
      generatedMnemonic: "test mnemonic",
    });
    mockRegisterNametag.mockResolvedValue({ success: true });

    await initSphere({ network: "testnet", nametag: "mybot" });

    expect(mockRegisterNametag).toHaveBeenCalledWith("mybot");
  });

  it("skips minting when wallet already has a nametag", async () => {
    mockSphereInit.mockResolvedValue({
      sphere: fakeSphere, // has nametag: "@agent"
      created: false,
    });

    await initSphere({ network: "testnet", nametag: "mybot" });

    expect(mockRegisterNametag).not.toHaveBeenCalled();
  });

  it("does not mint nametag when not configured", async () => {
    mockSphereInit.mockResolvedValue({
      sphere: fakeSphereNoNametag,
      created: true,
      generatedMnemonic: "test mnemonic",
    });

    await initSphere({ network: "testnet" });

    expect(mockRegisterNametag).not.toHaveBeenCalled();
  });

  it("handles nametag mint failure gracefully", async () => {
    mockSphereInit.mockResolvedValue({
      sphere: fakeSphereNoNametag,
      created: true,
      generatedMnemonic: "test mnemonic",
    });
    mockRegisterNametag.mockRejectedValue(new Error("already taken"));

    // Should not throw
    const result = await initSphere({ network: "testnet", nametag: "taken-name" });
    expect(result.created).toBe(true);
  });

  it("returns cached sphere on second call", async () => {
    mockSphereInit.mockResolvedValue({
      sphere: fakeSphere,
      created: true,
      generatedMnemonic: "mnemonic",
    });

    const first = await initSphere({ network: "testnet" });
    const second = await initSphere({ network: "testnet" });

    expect(mockSphereInit).toHaveBeenCalledTimes(1);
    expect(second.created).toBe(false);
    expect(second.sphere).toBe(first.sphere);
  });

  it("destroySphere cleans up and resets singleton", async () => {
    mockSphereInit.mockResolvedValue({
      sphere: fakeSphere,
      created: false,
    });

    await initSphere({ network: "testnet" });
    expect(getSphereOrNull()).toBe(fakeSphere);

    await destroySphere();
    expect(getSphereOrNull()).toBeNull();
    expect(mockDestroy).toHaveBeenCalledOnce();
  });
});

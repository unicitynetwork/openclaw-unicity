import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetSphere = vi.fn();
const mockFetch = vi.fn();
const mockResolveCoinId = vi.fn();
const mockGetCoinSymbol = vi.fn();
const mockGetAvailableSymbols = vi.fn();

// Stub fetch before importing the module
vi.stubGlobal("fetch", mockFetch);

vi.mock("../../src/sphere.js", () => ({
  getSphere: () => mockGetSphere(),
}));

vi.mock("../../src/assets.js", () => ({
  resolveCoinId: (input: string) => mockResolveCoinId(input),
  getCoinSymbol: (name: string) => mockGetCoinSymbol(name),
  getAvailableSymbols: () => mockGetAvailableSymbols(),
}));

const { topUpTool } = await import("../../src/tools/top-up.js");

describe("topUpTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSphere.mockReturnValue({
      identity: { nametag: "@testbot", chainPubkey: "abc123" },
    });
    mockGetAvailableSymbols.mockReturnValue(["UCT", "BTC", "SOL", "ETH"]);
    mockGetCoinSymbol.mockImplementation((name: string) => {
      const symbols: Record<string, string> = {
        unicity: "UCT",
        bitcoin: "BTC",
        solana: "SOL",
        ethereum: "ETH",
        tether: "USDT",
        "usd-coin": "USDC",
        "unicity-usd": "USDU",
        "unicity-eur": "EURU",
        alpha_test: "ALPHT",
      };
      return symbols[name] ?? name.toUpperCase();
    });
  });

  it("has correct name and description", () => {
    expect(topUpTool.name).toBe("uniclaw_top_up");
    expect(topUpTool.description).toContain("faucet");
    expect(topUpTool.description).toContain("testnet");
  });

  it("requests tokens from faucet with correct parameters", async () => {
    mockResolveCoinId.mockReturnValue("unicity");
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    const result = await topUpTool.execute("call-1", { coin: "UCT", amount: 100 });

    expect(mockResolveCoinId).toHaveBeenCalledWith("UCT");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://faucet.unicity.network/api/v1/faucet/request",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unicityId: "testbot", coin: "unicity", amount: 100 }),
      }),
    );
    expect(result.content[0].text).toContain("successful");
    expect(result.content[0].text).toContain("100 UCT");
    expect(result.content[0].text).toContain("@testbot");
  });

  it("handles decimal amounts", async () => {
    mockResolveCoinId.mockReturnValue("bitcoin");
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    await topUpTool.execute("call-2", { coin: "BTC", amount: 0.5 });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ unicityId: "testbot", coin: "bitcoin", amount: 0.5 }),
      }),
    );
  });

  it("resolves coin via resolveCoinId", async () => {
    mockResolveCoinId.mockReturnValue("solana");
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    await topUpTool.execute("call-3", { coin: "sol", amount: 10 });

    expect(mockResolveCoinId).toHaveBeenCalledWith("sol");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"coin":"solana"'),
      }),
    );
  });

  it("throws on unknown coin", async () => {
    mockResolveCoinId.mockReturnValue(null);

    await expect(
      topUpTool.execute("call-4", { coin: "FAKE", amount: 100 }),
    ).rejects.toThrow('Unknown coin "FAKE"');
  });

  it("throws on zero amount", async () => {
    mockResolveCoinId.mockReturnValue("unicity");

    await expect(
      topUpTool.execute("call-5", { coin: "UCT", amount: 0 }),
    ).rejects.toThrow("Amount must be greater than 0");
  });

  it("throws on negative amount", async () => {
    mockResolveCoinId.mockReturnValue("unicity");

    await expect(
      topUpTool.execute("call-6", { coin: "UCT", amount: -10 }),
    ).rejects.toThrow("Amount must be greater than 0");
  });

  it("throws when wallet has no nametag", async () => {
    mockGetSphere.mockReturnValue({
      identity: { chainPubkey: "abc123" },
    });

    await expect(
      topUpTool.execute("call-7", { coin: "UCT", amount: 100 }),
    ).rejects.toThrow("nametag is required");
  });

  it("returns error message on HTTP failure", async () => {
    mockResolveCoinId.mockReturnValue("unicity");
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: () => Promise.resolve("Rate limited"),
    });

    const result = await topUpTool.execute("call-8", { coin: "UCT", amount: 100 });
    expect(result.content[0].text).toContain("failed");
    expect(result.content[0].text).toContain("429");
  });

  it("returns error message when faucet returns success: false", async () => {
    mockResolveCoinId.mockReturnValue("unicity");
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: false, message: "Daily limit reached" }),
    });

    const result = await topUpTool.execute("call-9", { coin: "UCT", amount: 100 });
    expect(result.content[0].text).toContain("failed");
    expect(result.content[0].text).toContain("Daily limit reached");
  });
});

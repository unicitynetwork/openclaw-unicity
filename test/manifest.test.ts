import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/channel-core", () => ({
  defineChannelPluginEntry: (o: { id: string; registerFull?: (api: unknown) => void }) => ({
    id: o.id,
    register: (api: unknown) => o.registerFull?.(api),
  }),
}));
vi.mock("../src/channel.js", () => ({ unicityChannelPlugin: { id: "unicity" } }));
vi.mock("../src/cli.js", () => ({ registerUnicityCli: vi.fn() }));
vi.mock("../src/sphere.js", () => ({
  openGatewayWallet: vi.fn(),
  closeGatewayWallet: vi.fn(),
  getSphereOrNull: () => null,
}));
vi.mock("../src/identity.js", () => ({
  OwnerAuthority: class {},
  setOwnerAuthority: vi.fn(),
  getOwnerAuthority: () => null,
  toXOnly: (pk: string | null | undefined) => {
    const k = (pk ?? "").toLowerCase();
    return /^[0-9a-f]{64}$/.test(k) ? k : /^0[23][0-9a-f]{64}$/.test(k) ? k.slice(2) : null;
  },
}));

const { default: entry } = await import("../src/index.js");
const { ALL_TOOL_NAMES, OWNER_ONLY_TOOL_NAMES } = await import("../src/owner-gate.js");
const { PLUGIN_ID, CHANNEL_ID } = await import("../src/config.js");

const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const manifest = readJson("../openclaw.plugin.json");
const pkg = readJson("../package.json");

type Schema = Record<string, unknown> & { properties?: Record<string, Schema> };

function registeredToolNames(): string[] {
  const names: string[] = [];
  const api = {
    registrationMode: "tool-discovery",
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerTool: (factory: (ctx: unknown) => { name: string } | null, opts: { name: string }) => {
      const tool = factory({ senderIsOwner: true });
      expect(tool?.name).toBe(opts.name);
      names.push(opts.name);
    },
    on: vi.fn(),
  };
  entry.register(api as never);
  return names;
}

/** Every `default` keyword anywhere in a JSON schema. */
function defaultsIn(schema: unknown, path = "$"): string[] {
  if (schema === null || typeof schema !== "object") return [];
  return Object.entries(schema).flatMap(([k, v]) => [
    ...(k === "default" ? [path] : []),
    ...defaultsIn(v, `${path}.${k}`),
  ]);
}

describe("openclaw.plugin.json", () => {
  it("identifies the plugin and its channel consistently with the code and package.json", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(entry.id).toBe(PLUGIN_ID);
    expect(manifest.channels).toEqual([CHANNEL_ID]);
    expect(pkg.openclaw.channel.id).toBe(CHANNEL_ID);
    expect(manifest.activation).toEqual({ onStartup: true });
    expect(manifest.cliCommands).toEqual([{ name: "unicity", description: "Unicity wallet and identity", hasSubcommands: true }]);
  });

  it("declares exactly the tools the entry registers (contracts.tools == ALL_TOOL_NAMES == registered)", () => {
    const declared: string[] = manifest.contracts.tools;
    expect(new Set(declared).size).toBe(declared.length);
    expect([...declared].sort()).toEqual([...ALL_TOOL_NAMES].sort());
    expect(registeredToolNames().sort()).toEqual([...declared].sort());
  });

  it("keeps tool metadata to declared tools, never replay-safe, and marks money/send tools side-effecting", () => {
    const metadata: Record<string, Record<string, unknown>> = manifest.toolMetadata;
    for (const [name, meta] of Object.entries(metadata)) {
      expect(manifest.contracts.tools).toContain(name);
      expect(meta.replaySafe).toBeUndefined();
    }
    for (const name of ["unicity_send_tokens", "unicity_respond_payment_request", "unicity_top_up", "unicity_request_payment", "unicity_send_message"]) {
      expect(metadata[name].sideEffecting).toBe(true);
    }
    expect(OWNER_ONLY_TOOL_NAMES).not.toContain("unicity_list_groups");
  });

  it("plugin configSchema covers every config key with the network enum and default", () => {
    const schema: Schema = manifest.configSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties!).sort()).toEqual(
      [
        "additionalRelays", "allowFrom", "apiKey", "dmPolicy", "groupChat", "nametag", "network", "owner", "ownerPubkeys",
        "strangerToolsAllow", "walletApiUrl",
      ].sort(),
    );
    const network = schema.properties!.network;
    expect(network.enum).toEqual(["testnet2", "mainnet"]);
    expect(network.default).toBe("testnet2");
    expect(schema.properties!.dmPolicy.enum).toEqual(["open", "allowlist", "pairing", "disabled"]);
    expect(defaultsIn(schema.properties!.dmPolicy)).toEqual([]);
    expect(defaultsIn(schema.properties!.allowFrom)).toEqual([]);
    expect(schema.properties!.strangerToolsAllow).toMatchObject({ type: "array", items: { type: "string" } });
    expect(schema.properties!.strangerToolsAllow.description).toMatch(/DANGEROUS/);
    expect(schema.properties!.strangerToolsAllow.description).toMatch(/in groups unicity_list_groups only/);
    // Owners recognized on other channels keep the wallet tools in that channel's group chats (README "The owner").
    expect(schema.properties!.owner.description).not.toMatch(/only in DMs/);
    expect(schema.properties!.owner.description).toMatch(/commands\.ownerAllowFrom.*group chats/);
    expect(defaultsIn(schema.properties!.strangerToolsAllow)).toEqual([]);
    expect(schema.properties!.groupChat.anyOf).toEqual([
      { type: "boolean" },
      expect.objectContaining({ type: "object", properties: { relays: { type: "array", items: { type: "string" } } } }),
    ]);
    expect(manifest.uiHints.apiKey.sensitive).toBe(true);
  });

  it("documents where to get the API key and keeps it optional (messaging-only without it)", () => {
    const schema: Schema & { required?: string[] } = manifest.configSchema;
    expect(schema.required ?? []).not.toContain("apiKey");
    expect(schema.properties!.apiKey).toMatchObject({ type: "string" });
    expect(defaultsIn(schema.properties!.apiKey)).toEqual([]);
    expect(schema.properties!.apiKey.description).toContain("https://sphere.unicity.network");
    expect(manifest.uiHints.apiKey.help).toContain("https://sphere.unicity.network");
  });

  it("channelConfigs.unicity has a strict schema with no defaults", () => {
    const channel = manifest.channelConfigs[CHANNEL_ID];
    expect(channel.label).toBe("Unicity");
    const schema: Schema = channel.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties!).sort()).toEqual(
      ["allowFrom", "dmPolicy", "enabled", "healthMonitor", "name"].sort(),
    );
    expect(schema.properties!.healthMonitor.properties).toEqual({ enabled: { type: "boolean" } });
    expect(defaultsIn(schema)).toEqual([]);
  });

  it("documents that channels.unicity.enabled: false disables the whole plugin", () => {
    const props = (manifest.channelConfigs[CHANNEL_ID].schema as Schema).properties!;
    expect(props.enabled.description).toMatch(/disables the whole openclaw-unicity plugin/);
  });
});

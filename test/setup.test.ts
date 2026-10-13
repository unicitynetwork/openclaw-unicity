import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import type { UnicityConfig } from "../src/config.js";

vi.mock("../src/identity.js", () => ({
  toXOnly: (pk: string | null | undefined) => {
    const k = (pk ?? "").trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(k)) return k;
    if (/^0[23][0-9a-f]{64}$/.test(k)) return k.slice(2);
    return null;
  },
}));

const { applySetupAnswers, collectSetupAnswers, remainingOwnerKeys, staleOwnerEntries } = await import("../src/setup.js");
const { setDataDirForTests } = await import("../src/storage.js");

const KEY = "ab".repeat(32);
const OLD_KEY = "cd".repeat(32);
const PIN_KEY = "ef".repeat(32);

/** A fresh data dir for every test: the setup prompts read owner-pin.json from it. */
let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "unicity-setup-"));
  setDataDirForTests(dataDir);
});
afterEach(() => {
  setDataDirForTests();
  rmSync(dataDir, { recursive: true, force: true });
});

const writePinFile = (content: string) => writeFileSync(join(dataDir, "owner-pin.json"), content);
const pinAlice = (key: string = PIN_KEY) => writePinFile(JSON.stringify({ pins: { alice: { key, pinnedAt: 1 } } }));

const current = (over: Partial<UnicityConfig> = {}): UnicityConfig => ({
  network: "testnet2",
  ownerPubkeys: [],
  groupChat: true,
  warnings: [],
  ...over,
});

type TextParams = Parameters<WizardPrompter["text"]>[0];

/** Prompter answering text prompts in order and the select with `network`; records what it was asked. */
function scriptedPrompter(texts: string[], network: string) {
  const asked: TextParams[] = [];
  const selects: Array<{ initialValue?: unknown; values: unknown[] }> = [];
  const note = vi.fn(async () => undefined);
  const prompter = {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    note,
    text: vi.fn(async (p: TextParams) => {
      asked.push(p);
      return texts.shift() ?? "";
    }),
    select: vi.fn(async (p: { initialValue?: unknown; options: Array<{ value: unknown }> }) => {
      selects.push({ initialValue: p.initialValue, values: p.options.map((o) => o.value) });
      return network;
    }),
    multiselect: vi.fn(),
    confirm: vi.fn(),
    progress: vi.fn(),
  } as unknown as WizardPrompter;
  return { prompter, asked, selects, note };
}

describe("collectSetupAnswers", () => {
  it("normalizes the nametag and a nametag owner", async () => {
    const { prompter, asked, selects } = scriptedPrompter(["@MyBot", " @Alice ", " sk_new "], "testnet2");
    const answers = await collectSetupAnswers(prompter, current({ nametag: "old", owner: "bob" }));
    expect(answers).toEqual({ nametag: "mybot", owner: "alice", network: "testnet2", apiKey: "sk_new" });
    expect(asked[0].initialValue).toBe("old");
    expect(asked[1].initialValue).toBe("bob");
    expect(selects[0]).toEqual({ initialValue: "testnet2", values: ["testnet2", "mainnet"] });
  });

  it("accepts a hex owner key and an empty owner", async () => {
    let s = scriptedPrompter(["mybot", `03${KEY.toUpperCase()}`, "sk_k"], "testnet2");
    expect((await collectSetupAnswers(s.prompter, current())).owner).toBe(`03${KEY}`);
    s = scriptedPrompter(["mybot", "  ", "sk_k"], "testnet2");
    expect((await collectSetupAnswers(s.prompter, current())).owner).toBeUndefined();
  });

  it("accepts an '@'-prefixed public key like the config parser does", async () => {
    const s = scriptedPrompter(["mybot", ` @02${KEY.toUpperCase()} `, "sk_k"], "testnet2");
    expect((await collectSetupAnswers(s.prompter, current())).owner).toBe(`02${KEY}`);
    expect(s.asked[1].validate?.(`@02${KEY}`)).toBeUndefined();
    expect(s.asked[1].validate?.(`@${KEY}`)).toBeUndefined();
  });

  it("explains the command-owner placeholder for a nametag owner only", async () => {
    const named = scriptedPrompter(["mybot", "@Alice", "sk_k"], "testnet2");
    await collectSetupAnswers(named.prompter, current());
    expect(named.note).toHaveBeenCalledWith(expect.stringContaining('"unicity:@alice"'), "Command owner");
    const keyed = scriptedPrompter(["mybot", KEY, "sk_k"], "testnet2");
    await collectSetupAnswers(keyed.prompter, current());
    expect(keyed.note).not.toHaveBeenCalled();
  });

  it("validates nametag and owner input", async () => {
    const { prompter, asked } = scriptedPrompter(["mybot", "", "sk_k"], "testnet2");
    await collectSetupAnswers(prompter, current());
    const [nametag, owner] = asked;
    expect(nametag.validate?.("x")).toMatch(/3-20 characters/);
    expect(nametag.validate?.("bad name!")).toBeDefined();
    expect(nametag.validate?.("@good_bot")).toBeUndefined();
    expect(owner.validate?.("")).toBeUndefined();
    expect(owner.validate?.(KEY)).toBeUndefined();
    expect(owner.validate?.("@alice")).toBeUndefined();
    expect(owner.validate?.("not a key!")).toMatch(/nametag or a 64\/66-character hex/);
  });

  it("rejects invalid answers even from a prompter that does not enforce validate", async () => {
    await expect(collectSetupAnswers(scriptedPrompter(["no way!", "", "sk_k"], "testnet2").prompter, current())).rejects.toThrow(/Invalid nametag/);
    await expect(collectSetupAnswers(scriptedPrompter(["mybot", "PROXY:x", "sk_k"], "testnet2").prompter, current())).rejects.toThrow(/Invalid owner/);
  });

  it("asks for the API key hidden, names where to get it, and requires one", async () => {
    const s = scriptedPrompter(["mybot", "", "  "], "testnet2");
    await expect(collectSetupAnswers(s.prompter, current())).rejects.toThrow(/API key is required.*https:\/\/sphere\.unicity\.network/);
    const apiKey = s.asked[2];
    expect(apiKey.sensitive).toBe(true);
    expect(apiKey.initialValue).toBeUndefined();
    expect(apiKey.message).toContain("https://sphere.unicity.network");
    expect(apiKey.validate?.("")).toMatch(/API key is required/);
    expect(apiKey.validate?.("sk_x")).toBeUndefined();
  });

  it("keeps the configured key on an empty answer when the network stays the same", async () => {
    const s = scriptedPrompter(["mybot", "", ""], "mainnet");
    const answers = await collectSetupAnswers(s.prompter, current({ network: "mainnet", apiKey: "sk_main" }));
    expect(answers).toMatchObject({ network: "mainnet", apiKey: "sk_main" });
    expect(s.asked[2].message).toMatch(/leave empty to keep the configured key/);
    expect(s.asked[2].message).not.toContain("sk_main");
    // Kept by an empty answer, never prefilled: a prefilled prompt would show the key.
    expect(s.asked[2].initialValue).toBeUndefined();
    expect(s.asked[2].placeholder).toBeUndefined();
    expect(s.asked[2].validate?.("")).toBeUndefined();
    const replaced = scriptedPrompter(["mybot", "", "sk_other"], "mainnet");
    expect((await collectSetupAnswers(replaced.prompter, current({ network: "mainnet", apiKey: "sk_main" }))).apiKey).toBe("sk_other");
  });

  it("asks for a new key when the network changes (keys are per network)", async () => {
    const s = scriptedPrompter(["mybot", "", ""], "mainnet");
    await expect(collectSetupAnswers(s.prompter, current({ apiKey: "sk_testnet" }))).rejects.toThrow(/API key is required/);
    expect(s.asked[2].message).not.toMatch(/keep/);
    expect(s.asked[2].validate?.("")).toMatch(/API key is required/);
  });

  it("says that a walletApiUrl override is removed on a network change, and only then", async () => {
    const changed = scriptedPrompter(["mybot", "", "sk_main"], "mainnet");
    await collectSetupAnswers(changed.prompter, current({ walletApiUrl: "https://staging.example" }));
    expect(changed.note).toHaveBeenCalledTimes(1);
    expect(changed.note).toHaveBeenCalledWith(
      expect.stringMatching(
        /walletApiUrl https:\/\/staging\.example was set for testnet2; setup removes it so mainnet uses its default wallet API \(https:\/\/wallet-api\.mainnet\.unicity\.network\)/,
      ),
      "Wallet API URL",
    );
    const same = scriptedPrompter(["mybot", "", "sk_k"], "testnet2");
    await collectSetupAnswers(same.prompter, current({ walletApiUrl: "https://staging.example" }));
    expect(same.note).not.toHaveBeenCalled();
    const unset = scriptedPrompter(["mybot", "", "sk_main"], "mainnet");
    await collectSetupAnswers(unset.prompter, current());
    expect(unset.note).not.toHaveBeenCalled();
  });
});

describe("collectSetupAnswers: replacing a nametag owner", () => {
  it("passes on the key the gateway pinned for the previous owner and says it will be removed", async () => {
    pinAlice();
    const s = scriptedPrompter(["mybot", "@bob", "sk_k"], "testnet2");
    const answers = await collectSetupAnswers(s.prompter, current({ owner: "alice" }));
    expect(answers.previousOwnerPin).toEqual({ owner: "alice", key: PIN_KEY });
    expect(s.note).toHaveBeenCalledWith(expect.stringContaining(`@alice is pinned to ${PIN_KEY}`), "Previous owner");
    // Removing the owner altogether revokes it too.
    const cleared = scriptedPrompter(["mybot", "", "sk_k"], "testnet2");
    expect((await collectSetupAnswers(cleared.prompter, current({ owner: "alice" }))).previousOwnerPin).toEqual({ owner: "alice", key: PIN_KEY });
  });

  it("reads the pin as stored: a 66-hex pin is passed on as its x-only key", async () => {
    pinAlice(`02${PIN_KEY}`);
    const s = scriptedPrompter(["mybot", "@bob", "sk_k"], "testnet2");
    expect((await collectSetupAnswers(s.prompter, current({ owner: "alice" }))).previousOwnerPin).toEqual({ owner: "alice", key: PIN_KEY });
  });

  it("passes nothing, and says nothing, when the owner stays or the new owner is the pinned key", async () => {
    pinAlice();
    const same = scriptedPrompter(["mybot", "@Alice", "sk_k"], "testnet2");
    expect((await collectSetupAnswers(same.prompter, current({ owner: "alice" }))).previousOwnerPin).toBeUndefined();
    const toKey = scriptedPrompter(["mybot", `03${PIN_KEY}`, "sk_k"], "testnet2");
    expect((await collectSetupAnswers(toKey.prompter, current({ owner: "alice" }))).previousOwnerPin).toBeUndefined();
    for (const s of [same, toKey]) expect(s.note).not.toHaveBeenCalledWith(expect.anything(), "Previous owner");
  });

  it("tells the user to remove a key entry by hand when the previous owner has no pin (never pinned, or the file deleted)", async () => {
    pinAlice();
    const unpinned = scriptedPrompter(["mybot", "@carol", "sk_k"], "testnet2");
    expect((await collectSetupAnswers(unpinned.prompter, current({ owner: "dave" }))).previousOwnerPin).toBeUndefined();
    rmSync(join(dataDir, "owner-pin.json"));
    const none = scriptedPrompter(["mybot", "@bob", "sk_k"], "testnet2");
    expect((await collectSetupAnswers(none.prompter, current({ owner: "alice" }))).previousOwnerPin).toBeUndefined();
    for (const [s, name] of [[unpinned, "dave"], [none, "alice"]] as const) {
      expect(s.note).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`No key is pinned for the previous owner @${name} .*"unicity:<key>" entry for @${name}.*remove it yourself`)),
        "Previous owner",
      );
    }
  });

  it("tells the user to remove the key entry by hand when the pin file cannot be read, and still completes", async () => {
    for (const content of ["{not json", JSON.stringify({ pins: [] }), JSON.stringify({ pins: { alice: { key: "nope" } } })]) {
      writePinFile(content);
      const s = scriptedPrompter(["mybot", "@bob", "sk_k"], "testnet2");
      const answers = await collectSetupAnswers(s.prompter, current({ owner: "alice" }));
      expect(answers).toMatchObject({ owner: "bob", apiKey: "sk_k" });
      expect(answers.previousOwnerPin).toBeUndefined();
      expect(s.note).toHaveBeenCalledWith(
        expect.stringMatching(/cannot be read .*"unicity:<key>" entry for @alice to commands\.ownerAllowFrom, remove it yourself/),
        "Previous owner",
      );
    }
  });

  it("does not look up a pin for a key owner (its entry is known from the key itself)", async () => {
    writePinFile("{not json");
    const s = scriptedPrompter(["mybot", "@bob", "sk_k"], "testnet2");
    expect((await collectSetupAnswers(s.prompter, current({ owner: OLD_KEY }))).previousOwnerPin).toBeUndefined();
    expect(s.note).not.toHaveBeenCalledWith(expect.anything(), "Previous owner");
  });
});

describe("ownerPubkeys when setup replaces or removes the owner", () => {
  const EXTRA = "12".repeat(32);
  const EXTRA2 = "34".repeat(32);
  const extraNotes = (note: ReturnType<typeof vi.fn>) =>
    note.mock.calls.filter((c) => c[1] === "Additional owner keys").map((c) => String(c[0]));

  it("lists the keys that keep owner authority, says setup leaves them, and names where to remove them", async () => {
    pinAlice();
    const cases: Array<[string | undefined, string]> = [["alice", "@bob"], ["alice", ""], [OLD_KEY, KEY], [OLD_KEY, "@bob"], ["alice", KEY]];
    for (const [previous, answer] of cases) {
      const s = scriptedPrompter(["mybot", answer, "sk_k"], "testnet2");
      const answers = await collectSetupAnswers(s.prompter, current({ owner: previous, ownerPubkeys: [EXTRA, EXTRA2] }));
      const notes = extraNotes(s.note);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain(`${EXTRA}\n`);
      expect(notes[0]).toContain(EXTRA2);
      expect(notes[0]).toMatch(/keep full owner authority on Unicity, including the wallet tools that send tokens/);
      expect(notes[0]).toMatch(/Setup does not change ownerPubkeys/);
      expect(notes[0]).toContain("plugins.entries.openclaw-unicity.config.ownerPubkeys");
      // Setup only informs; the operator decides: applying the answers leaves ownerPubkeys as it was.
      const cfg = { plugins: { entries: { "openclaw-unicity": { config: { owner: previous, ownerPubkeys: [EXTRA, EXTRA2] } } } } };
      expect(applySetupAnswers(cfg, answers).plugins.entries["openclaw-unicity"].config.ownerPubkeys).toEqual([EXTRA, EXTRA2]);
    }
  });

  it("is shown after the previous-owner note, so it qualifies what that note says was removed", async () => {
    pinAlice();
    const s = scriptedPrompter(["mybot", "@bob", "sk_k"], "testnet2");
    await collectSetupAnswers(s.prompter, current({ owner: "alice", ownerPubkeys: [EXTRA] }));
    expect(s.note.mock.calls.map((c) => c[1])).toEqual(["Command owner", "Previous owner", "Additional owner keys"]);
  });

  it("is not shown when the owner stays, when there was no owner, or when ownerPubkeys is empty", async () => {
    const cases: Array<[Partial<UnicityConfig>, string]> = [
      [{ owner: "alice", ownerPubkeys: [EXTRA] }, "@Alice"],
      [{ owner: `02${OLD_KEY}`, ownerPubkeys: [EXTRA] }, OLD_KEY],
      [{ ownerPubkeys: [EXTRA] }, "@bob"],
      [{ ownerPubkeys: [EXTRA] }, ""],
      [{ owner: "alice", ownerPubkeys: [] }, "@bob"],
    ];
    for (const [over, answer] of cases) {
      const s = scriptedPrompter(["mybot", answer, "sk_k"], "testnet2");
      await collectSetupAnswers(s.prompter, current(over));
      expect(extraNotes(s.note)).toEqual([]);
    }
  });

  it("leaves out a key that becomes the owner itself", async () => {
    const s = scriptedPrompter(["mybot", `03${EXTRA}`, "sk_k"], "testnet2");
    await collectSetupAnswers(s.prompter, current({ owner: OLD_KEY, ownerPubkeys: [EXTRA, EXTRA2] }));
    const notes = extraNotes(s.note);
    expect(notes).toHaveLength(1);
    expect(notes[0]).not.toContain(EXTRA);
    expect(notes[0]).toContain(EXTRA2);
    const only = scriptedPrompter(["mybot", EXTRA, "sk_k"], "testnet2");
    await collectSetupAnswers(only.prompter, current({ owner: OLD_KEY, ownerPubkeys: [EXTRA] }));
    expect(extraNotes(only.note)).toEqual([]);
  });

  it("remainingOwnerKeys: the keys left with owner authority after the change, none without a change", () => {
    const cfg = current({ owner: "alice", ownerPubkeys: [EXTRA, EXTRA2] });
    expect(remainingOwnerKeys(cfg, "bob")).toEqual([EXTRA, EXTRA2]);
    expect(remainingOwnerKeys(cfg, undefined)).toEqual([EXTRA, EXTRA2]);
    expect(remainingOwnerKeys(cfg, `02${EXTRA2}`)).toEqual([EXTRA]);
    expect(remainingOwnerKeys(cfg, "alice")).toEqual([]);
    expect(remainingOwnerKeys(current({ ownerPubkeys: [EXTRA] }), "bob")).toEqual([]);
  });

  it("applySetupAnswers keeps ownerPubkeys as configured when the owner changes or is cleared", () => {
    const cfg = { plugins: { entries: { "openclaw-unicity": { config: { owner: "alice", ownerPubkeys: [EXTRA, `02${EXTRA2}`] } } } } };
    for (const owner of ["bob", undefined]) {
      const next = applySetupAnswers(cfg, { nametag: "mybot", owner, network: "testnet2", apiKey: "sk_k" });
      expect(next.plugins.entries["openclaw-unicity"].config.ownerPubkeys).toEqual([EXTRA, `02${EXTRA2}`]);
    }
  });
});

describe("applySetupAnswers", () => {
  it("returns a new config with the entry enabled and the answers merged", () => {
    const cfg = {
      gateway: { port: 1 },
      plugins: {
        allow: ["x"],
        entries: {
          other: { enabled: true },
          "openclaw-unicity": { enabled: false, hooks: { allowConversationAccess: true }, config: { dmPolicy: "pairing", apiKey: "sk_old" } },
        },
      },
    };
    const before = structuredClone(cfg);
    const next = applySetupAnswers(cfg, { nametag: "mybot", owner: "alice", network: "testnet2", apiKey: "sk_k" });
    expect(cfg).toEqual(before);
    expect(next).not.toBe(cfg);
    expect(next).toEqual({
      gateway: { port: 1 },
      plugins: {
        allow: ["x"],
        entries: {
          other: { enabled: true },
          "openclaw-unicity": {
            enabled: true,
            hooks: { allowConversationAccess: true },
            config: { dmPolicy: "pairing", apiKey: "sk_k", nametag: "mybot", network: "testnet2", owner: "alice" },
          },
        },
      },
      commands: { ownerAllowFrom: ["unicity:@alice"] },
    });
  });

  it("writes a non-matching unicity:@<nametag> placeholder for a nametag owner, so pairing cannot bootstrap a command owner", () => {
    const next = applySetupAnswers(
      { commands: { ownerAllowFrom: ["*", "unicity:*"] } },
      { nametag: "mybot", owner: "alice", network: "testnet2", apiKey: "sk_k" },
    ) as { commands: { ownerAllowFrom: string[] } };
    expect(next.commands.ownerAllowFrom).toEqual(["*", "unicity:*", "unicity:@alice"]);
    const again = applySetupAnswers(next, { nametag: "mybot", owner: "alice", network: "testnet2", apiKey: "sk_k" });
    expect(again.commands).toBe(next.commands);
  });

  it("swaps the owner entry when the owner changes between a nametag and a key", () => {
    const named = {
      plugins: { entries: { "openclaw-unicity": { config: { owner: "alice" } } } },
      commands: { ownerAllowFrom: ["telegram:42", "unicity:@alice"] },
    };
    expect(applySetupAnswers(named, { nametag: "mybot", owner: KEY, network: "testnet2", apiKey: "sk_k" }).commands).toEqual({
      ownerAllowFrom: ["telegram:42", `unicity:${KEY}`],
    });
    expect(applySetupAnswers(named, { nametag: "mybot", owner: "bob", network: "testnet2", apiKey: "sk_k" }).commands).toEqual({
      ownerAllowFrom: ["telegram:42", "unicity:@bob"],
    });
  });

  it("creates the plugin entry in an empty config and drops a cleared owner", () => {
    expect(applySetupAnswers({}, { nametag: "mybot", network: "mainnet", apiKey: "sk_k" })).toEqual({
      plugins: { entries: { "openclaw-unicity": { enabled: true, config: { nametag: "mybot", network: "mainnet", apiKey: "sk_k" } } } },
    });
    const cleared = applySetupAnswers(
      { plugins: { entries: { "openclaw-unicity": { config: { owner: "alice" } } } } },
      { nametag: "mybot", network: "testnet2", apiKey: "sk_k" },
    );
    expect(cleared.plugins.entries["openclaw-unicity"].config).toEqual({ nametag: "mybot", network: "testnet2", apiKey: "sk_k" });
  });

  it("drops a walletApiUrl override when the network changes (it belongs to one network, like the API key)", () => {
    const entry = (config: Record<string, unknown>) => ({ plugins: { entries: { "openclaw-unicity": { config } } } });
    const toMainnet = applySetupAnswers(entry({ network: "testnet2", walletApiUrl: "https://staging.example", dmPolicy: "open" }), {
      nametag: "mybot",
      network: "mainnet",
      apiKey: "sk_main",
    });
    expect(toMainnet.plugins.entries["openclaw-unicity"].config).toEqual({
      network: "mainnet",
      nametag: "mybot",
      apiKey: "sk_main",
      dmPolicy: "open",
    });
    // An unset network is testnet2, as the gateway reads it.
    const fromDefault = applySetupAnswers(entry({ walletApiUrl: "https://staging.example" }), { nametag: "mybot", network: "mainnet", apiKey: "sk_main" });
    expect(fromDefault.plugins.entries["openclaw-unicity"].config).not.toHaveProperty("walletApiUrl");
    const kept = applySetupAnswers(entry({ walletApiUrl: "https://staging.example" }), { nametag: "mybot", network: "testnet2", apiKey: "sk_k" });
    expect(kept.plugins.entries["openclaw-unicity"].config).toMatchObject({ walletApiUrl: "https://staging.example" });
    const keptMainnet = applySetupAnswers(entry({ network: "mainnet", walletApiUrl: "https://w.example" }), {
      nametag: "mybot",
      network: "mainnet",
      apiKey: "sk_main",
    });
    expect(keptMainnet.plugins.entries["openclaw-unicity"].config).toMatchObject({ walletApiUrl: "https://w.example" });
  });

  it("adds a hex owner to commands.ownerAllowFrom as unicity:<x-only>", () => {
    const next = applySetupAnswers(
      { commands: { native: "auto", ownerAllowFrom: ["telegram:42"] } },
      { nametag: "mybot", owner: `02${KEY}`, network: "testnet2", apiKey: "sk_k" },
    ) as { commands: { native: string; ownerAllowFrom: string[] } };
    expect(next.commands).toEqual({ native: "auto", ownerAllowFrom: ["telegram:42", `unicity:${KEY}`] });
  });

  it("does not duplicate an existing owner entry", () => {
    const cfg = { commands: { ownerAllowFrom: [`Unicity:${KEY.toUpperCase()}`] } };
    const next = applySetupAnswers(cfg, { nametag: "mybot", owner: KEY, network: "testnet2", apiKey: "sk_k" });
    expect(next.commands).toBe(cfg.commands);
  });

  it("removes the previous hex owner's entry when the owner changes", () => {
    const cfg = {
      plugins: { entries: { "openclaw-unicity": { config: { owner: OLD_KEY } } } },
      commands: { ownerAllowFrom: [`unicity:${OLD_KEY}`, "telegram:42"] },
    };
    expect(applySetupAnswers(cfg, { nametag: "mybot", owner: KEY, network: "testnet2", apiKey: "sk_k" }).commands).toEqual({
      ownerAllowFrom: ["telegram:42", `unicity:${KEY}`],
    });
    expect(applySetupAnswers(cfg, { nametag: "mybot", owner: "alice", network: "testnet2", apiKey: "sk_k" }).commands).toEqual({
      ownerAllowFrom: ["telegram:42", "unicity:@alice"],
    });
    expect(applySetupAnswers(cfg, { nametag: "mybot", network: "testnet2", apiKey: "sk_k" }).commands).toEqual({
      ownerAllowFrom: ["telegram:42"],
    });
    const unchanged = applySetupAnswers(cfg, { nametag: "mybot", owner: OLD_KEY, network: "testnet2", apiKey: "sk_k" });
    expect(unchanged.commands).toBe(cfg.commands);
  });

  it("removes a previous hex owner's key in either form", () => {
    const cfg = {
      plugins: { entries: { "openclaw-unicity": { config: { owner: `02${OLD_KEY}` } } } },
      commands: { ownerAllowFrom: [`unicity:${OLD_KEY}`, `Unicity:03${OLD_KEY.toUpperCase()}`, "telegram:42"] },
    };
    expect(applySetupAnswers(cfg, { nametag: "mybot", owner: "bob", network: "testnet2", apiKey: "sk_k" }).commands).toEqual({
      ownerAllowFrom: ["telegram:42", "unicity:@bob"],
    });
    // The same key in another spelling is the same owner.
    expect(applySetupAnswers(cfg, { nametag: "mybot", owner: OLD_KEY, network: "testnet2", apiKey: "sk_k" }).commands).toBe(cfg.commands);
  });

  describe("a previous nametag owner's pinned key", () => {
    const cfg = {
      plugins: { entries: { "openclaw-unicity": { config: { owner: "alice" } } } },
      commands: { ownerAllowFrom: ["unicity:@alice", "telegram:42", `unicity:${PIN_KEY}`, `unicity:02${PIN_KEY}`, `unicity:${KEY}`] },
    };
    const pin = { owner: "alice", key: PIN_KEY };

    it("is removed with the placeholder when the owner changes or is cleared", () => {
      const toBob = { nametag: "mybot", owner: "bob", network: "testnet2", apiKey: "sk_k", previousOwnerPin: pin } as const;
      expect(staleOwnerEntries(cfg, toBob)).toEqual(["unicity:@alice", `unicity:${PIN_KEY}`, `unicity:02${PIN_KEY}`]);
      expect(applySetupAnswers(cfg, toBob).commands).toEqual({ ownerAllowFrom: ["telegram:42", `unicity:${KEY}`, "unicity:@bob"] });
      const cleared = { nametag: "mybot", network: "testnet2", apiKey: "sk_k", previousOwnerPin: pin } as const;
      expect(applySetupAnswers(cfg, cleared).commands).toEqual({ ownerAllowFrom: ["telegram:42", `unicity:${KEY}`] });
    });

    it("is kept when it becomes the owner key, when the pin belongs to another owner, or without a pin", () => {
      const toPinnedKey = { nametag: "mybot", owner: `03${PIN_KEY}`, network: "testnet2", apiKey: "sk_k", previousOwnerPin: pin } as const;
      expect(applySetupAnswers(cfg, toPinnedKey).commands).toEqual({
        ownerAllowFrom: ["telegram:42", `unicity:${PIN_KEY}`, `unicity:02${PIN_KEY}`, `unicity:${KEY}`],
      });
      const otherPin = { nametag: "mybot", owner: "bob", network: "testnet2", apiKey: "sk_k", previousOwnerPin: { owner: "carol", key: PIN_KEY } } as const;
      expect(staleOwnerEntries(cfg, otherPin)).toEqual(["unicity:@alice"]);
      expect(staleOwnerEntries(cfg, { nametag: "mybot", owner: "bob", network: "testnet2", apiKey: "sk_k" })).toEqual(["unicity:@alice"]);
    });

    it("is kept while the owner stays the same", () => {
      const same = { nametag: "mybot", owner: "alice", network: "testnet2", apiKey: "sk_k", previousOwnerPin: pin } as const;
      expect(staleOwnerEntries(cfg, same)).toEqual([]);
      expect(applySetupAnswers(cfg, same).commands).toBe(cfg.commands);
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  isGroupId, looksLikeTarget, normalizeNametag, SHORT_GROUP_ID, SLUG_GROUP_ID, VALID_RECIPIENT,
  validateRecipient,
} from "../src/validation.js";

const X_ONLY = "a".repeat(64);
const CHAIN_KEY = `02${"b".repeat(64)}`;

describe("normalizeNametag", () => {
  it("trims, strips one '@' and lowercases", () => {
    expect(normalizeNametag("  @Alice_01 ")).toBe("alice_01");
    expect(normalizeNametag("bob-bot")).toBe("bob-bot");
  });

  it("rejects names the SDK rejects (length 3-20, charset)", () => {
    expect(normalizeNametag("ab")).toBeNull();
    expect(normalizeNametag("a".repeat(21))).toBeNull();
    expect(normalizeNametag("bad name")).toBeNull();
    expect(normalizeNametag("bad@name")).toBeNull();
    expect(normalizeNametag("@@alice")).toBeNull();
    expect(normalizeNametag("")).toBeNull();
    expect(normalizeNametag("@")).toBeNull();
  });

  it("accepts E.164 phone nametags but not free-form phone text", () => {
    expect(normalizeNametag("+14155552671")).toBe("+14155552671");
    expect(normalizeNametag("(415) 555-2671")).toBeNull();
  });
});

describe("VALID_RECIPIENT / validateRecipient", () => {
  it.each(["@alice", "alice", "@Alice", X_ONLY, CHAIN_KEY, `03${"C".repeat(64)}`, `DIRECT://${"0a".repeat(38)}`, "@+14155552671"])(
    "accepts %s",
    (r) => {
      expect(VALID_RECIPIENT.test(r)).toBe(true);
      expect(() => validateRecipient(r)).not.toThrow();
    },
  );

  it.each(["", "ab", "a".repeat(21), `04${"b".repeat(64)}`, "a".repeat(63), "DIRECT://", "direct://abcdefabcdefabcdef", "bad name"])(
    "rejects %s",
    (r) => {
      expect(VALID_RECIPIENT.test(r)).toBe(false);
      expect(() => validateRecipient(r)).toThrow(/Invalid recipient/);
    },
  );

  it("explains that PROXY addresses are gone", () => {
    expect(() => validateRecipient("PROXY:abcdef")).toThrow(/PROXY addresses are not supported/);
  });

  it("trims before validating", () => {
    expect(() => validateRecipient("  @alice  ")).not.toThrow();
  });
});

describe("group ids / looksLikeTarget", () => {
  const cases: Array<[string, boolean]> = [
    ["abc123", true],
    ["a".repeat(20), true],
    [`my-long-group-name-here-x-${"0123456789abcdef"}`, false], // slug > 24
    [`unicity-traders-club-${"0123456789abcdef"}`, true],
    [`group-${"0123456789ABCDEF"}`, false],
    ["a".repeat(21), false],
    ["has space", false],
    ["", false],
  ];

  it("isGroupId accepts short alphanumeric ids and slug-hex ids", () => {
    for (const [id, ok] of cases) expect(isGroupId(id), id).toBe(ok);
  });

  it("splits the two shapes into SLUG_GROUP_ID and SHORT_GROUP_ID", () => {
    const id = `unicity-traders-club-${"0123456789abcdef"}`;
    expect(SLUG_GROUP_ID.test(id)).toBe(true);
    expect(SHORT_GROUP_ID.test(id)).toBe(false);
    expect(SLUG_GROUP_ID.test("abc123")).toBe(false);
    expect(SHORT_GROUP_ID.test("abc123")).toBe(true);
  });

  it("looksLikeTarget accepts recipients and group ids only", () => {
    expect(looksLikeTarget("@alice")).toBe(true);
    expect(looksLikeTarget(X_ONLY)).toBe(true);
    expect(looksLikeTarget(`unicity-traders-club-${"0123456789abcdef"}`)).toBe(true);
    expect(looksLikeTarget("hello world")).toBe(false);
    expect(looksLikeTarget("PROXY:abc")).toBe(false);
  });
});

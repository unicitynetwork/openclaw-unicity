import { describe, it, expect, vi, beforeEach } from "vitest";

const clack = vi.hoisted(() => {
  const CANCEL = Symbol("clack:cancel");
  const spinner = { start: vi.fn(), message: vi.fn(), stop: vi.fn() };
  return {
    CANCEL,
    spinnerInstance: spinner,
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
    confirm: vi.fn(),
    spinner: vi.fn(() => spinner),
    isCancel: (v: unknown) => v === CANCEL,
  };
});

vi.mock("@clack/prompts", () => ({ ...clack, CANCEL_SYMBOL: clack.CANCEL }));

const { createCliPrompter } = await import("../src/cli-prompter.js");
const { WizardCancelledError } = await import("openclaw/plugin-sdk/setup");

beforeEach(() => vi.clearAllMocks());

describe("createCliPrompter (@clack/prompts 1.x)", () => {
  it("wraps the synchronous intro/outro/note in promises", async () => {
    const p = createCliPrompter();
    await expect(p.intro("Unicity setup")).resolves.toBeUndefined();
    await p.outro("done");
    await p.note("body", "title");
    expect(clack.intro).toHaveBeenCalledWith("Unicity setup");
    expect(clack.outro).toHaveBeenCalledWith("done");
    expect(clack.note).toHaveBeenCalledWith("body", "title");
  });

  it("maps text prompts, passing validate an empty string for empty input", async () => {
    clack.text.mockResolvedValue("mybot");
    const validate = vi.fn((v: string) => (v ? undefined : "required"));
    const value = await createCliPrompter().text({ message: "Nametag:", initialValue: "old", placeholder: "bot", validate });
    expect(value).toBe("mybot");
    const opts = clack.text.mock.calls[0][0] as { message: string; initialValue: string; placeholder: string; validate(v?: string): unknown };
    expect(opts).toMatchObject({ message: "Nametag:", initialValue: "old", placeholder: "bot" });
    expect(opts.validate(undefined)).toBe("required");
    expect(validate).toHaveBeenCalledWith("");
    expect(opts.validate("x")).toBeUndefined();
  });

  it("uses a masked prompt for sensitive input, without echoing an initial value", async () => {
    clack.password.mockResolvedValue("sk_secret");
    await expect(createCliPrompter().text({ message: "API key:", initialValue: "sk_old", sensitive: true })).resolves.toBe("sk_secret");
    expect(clack.text).not.toHaveBeenCalled();
    expect(clack.password.mock.calls[0][0]).not.toHaveProperty("initialValue");
  });

  it("maps select, multiselect and confirm options", async () => {
    clack.select.mockResolvedValue("mainnet");
    clack.multiselect.mockResolvedValue(["a"]);
    clack.confirm.mockResolvedValue(false);
    const p = createCliPrompter();
    const options = [{ value: "testnet2", label: "Testnet" }, { value: "mainnet", label: "Mainnet", hint: "real value" }];
    expect(await p.select({ message: "Network:", options, initialValue: "testnet2" })).toBe("mainnet");
    expect(clack.select).toHaveBeenCalledWith({ message: "Network:", options, initialValue: "testnet2" });
    expect(await p.multiselect({ message: "Pick:", options: [{ value: "a", label: "A" }], initialValues: ["a"] })).toEqual(["a"]);
    expect(await p.confirm({ message: "Sure?", initialValue: true, layout: "vertical" })).toBe(false);
    expect(clack.confirm).toHaveBeenCalledWith({ message: "Sure?", initialValue: true, vertical: true });
  });

  it("turns a cancelled prompt into OpenClaw's WizardCancelledError", async () => {
    clack.text.mockResolvedValue(clack.CANCEL);
    clack.password.mockResolvedValue(clack.CANCEL);
    clack.select.mockResolvedValue(clack.CANCEL);
    clack.multiselect.mockResolvedValue(clack.CANCEL);
    clack.confirm.mockResolvedValue(clack.CANCEL);
    const p = createCliPrompter();
    for (const pending of [
      p.text({ message: "x" }),
      p.text({ message: "key", sensitive: true }),
      p.select({ message: "x", options: [] }),
      p.multiselect({ message: "x", options: [] }),
      p.confirm({ message: "x" }),
    ]) {
      await expect(pending).rejects.toBeInstanceOf(WizardCancelledError);
      await expect(pending).rejects.toThrow("Setup cancelled");
    }
  });

  it("drives a spinner for progress", () => {
    const progress = createCliPrompter().progress("Working");
    progress.update("still working");
    progress.stop("done");
    expect(clack.spinnerInstance.start).toHaveBeenCalledWith("Working");
    expect(clack.spinnerInstance.message).toHaveBeenCalledWith("still working");
    expect(clack.spinnerInstance.stop).toHaveBeenCalledWith("done");
  });
});

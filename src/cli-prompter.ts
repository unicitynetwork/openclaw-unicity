/** WizardPrompter adapter over @clack/prompts (1.x) for the `openclaw unicity` CLI. */

import * as clack from "@clack/prompts";
import { WizardCancelledError } from "openclaw/plugin-sdk/setup";
import type { WizardMultiSelectParams, WizardPrompter, WizardSelectParams } from "openclaw/plugin-sdk/setup";

/** clack's Option<T> is a conditional type it does not export; derive it from select(). */
type ClackOption<T> = Parameters<typeof clack.select<T>>[0]["options"][number];

/** A cancelled prompt (ctrl-c, esc) throws WizardCancelledError, as OpenClaw's own prompter does. */
function unlessCancelled<T>(result: T | typeof clack.CANCEL_SYMBOL): T {
  if (clack.isCancel(result)) throw new WizardCancelledError("Setup cancelled");
  return result;
}

export function createCliPrompter(): WizardPrompter {
  return {
    async intro(title) {
      clack.intro(title);
    },
    async outro(message) {
      clack.outro(message);
    },
    async note(message, title) {
      clack.note(message, title);
    },
    async select<T>(params: WizardSelectParams<T>) {
      const result = await clack.select<T>({
        message: params.message,
        options: params.options as ClackOption<T>[],
        initialValue: params.initialValue,
      });
      return unlessCancelled(result);
    },
    async multiselect<T>(params: WizardMultiSelectParams<T>) {
      const result = await clack.multiselect<T>({
        message: params.message,
        options: params.options as ClackOption<T>[],
        initialValues: params.initialValues,
      });
      return unlessCancelled(result);
    },
    async text(params) {
      const validate = params.validate;
      const options = {
        message: params.message,
        signal: params.signal,
        validate: validate ? (value: string | undefined) => validate(value ?? "") : undefined,
      };
      const result = params.sensitive
        ? await clack.password(options)
        : await clack.text({ ...options, initialValue: params.initialValue, placeholder: params.placeholder });
      return unlessCancelled(result);
    },
    async confirm(params) {
      const result = await clack.confirm({
        message: params.message,
        initialValue: params.initialValue,
        vertical: params.layout === "vertical",
      });
      return unlessCancelled(result);
    },
    progress(label) {
      const spinner = clack.spinner();
      spinner.start(label);
      return {
        update: (message) => spinner.message(message),
        stop: (message) => spinner.stop(message),
      };
    },
  };
}

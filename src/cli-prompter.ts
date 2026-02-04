/** WizardPrompter adapter wrapping @clack/prompts for CLI use. */

import * as clack from "@clack/prompts";
import type { WizardPrompter } from "openclaw/plugin-sdk";

export function createCliPrompter(): WizardPrompter {
  return {
    async intro() { /* handled externally */ },
    async outro() { /* handled externally */ },
    async note(message: string, title?: string) {
      clack.note(message, title);
    },
    async select<T>(params: { message: string; options: Array<{ value: T; label: string; hint?: string }>; initialValue?: T }): Promise<T> {
      const result = await clack.select({
        message: params.message,
        options: params.options,
        initialValue: params.initialValue,
      });
      if (clack.isCancel(result)) {
        throw new Error("Setup cancelled");
      }
      return result as T;
    },
    async multiselect<T>(params: { message: string; options: Array<{ value: T; label: string }>; initialValues?: T[] }): Promise<T[]> {
      const result = await clack.multiselect({
        message: params.message,
        options: params.options,
        initialValues: params.initialValues,
      });
      if (clack.isCancel(result)) {
        throw new Error("Setup cancelled");
      }
      return result as T[];
    },
    async text(params: { message: string; initialValue?: string; placeholder?: string; validate?: (value: string) => string | undefined }): Promise<string> {
      const result = await clack.text({
        message: params.message,
        initialValue: params.initialValue,
        placeholder: params.placeholder,
        validate: params.validate,
      });
      if (clack.isCancel(result)) {
        throw new Error("Setup cancelled");
      }
      return result as string;
    },
    async confirm(params: { message: string; initialValue?: boolean }): Promise<boolean> {
      const result = await clack.confirm({
        message: params.message,
        initialValue: params.initialValue,
      });
      if (clack.isCancel(result)) {
        throw new Error("Setup cancelled");
      }
      return result as boolean;
    },
    progress(label: string) {
      const spinner = clack.spinner();
      spinner.start(label);
      return {
        update(message: string) { spinner.message(message); },
        stop(message?: string) { spinner.stop(message); },
      };
    },
  };
}

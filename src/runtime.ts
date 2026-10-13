/** Holds the PluginRuntime captured by defineChannelPluginEntry({ setRuntime }) and the shared logger shape. */

import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";

export type UnicityLogger = {
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
  debug?(m: string): void;
};

let runtime: PluginRuntime | null = null;

export function setUnicityRuntime(rt: PluginRuntime): void {
  runtime = rt;
}

export function getUnicityRuntime(): PluginRuntime {
  if (!runtime) throw new Error("[unicity] plugin runtime not initialized");
  return runtime;
}

export function getUnicityRuntimeOrNull(): PluginRuntime | null {
  return runtime;
}

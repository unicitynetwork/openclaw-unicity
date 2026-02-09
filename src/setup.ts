/** Shared interactive setup logic for Unicity plugin configuration. */

import type { WizardPrompter } from "openclaw/plugin-sdk";
import { NAMETAG_REGEX } from "./validation.js";

export type SetupRuntime = {
  loadConfig: () => Record<string, unknown>;
  writeConfigFile: (cfg: Record<string, unknown>) => Promise<void>;
};

export async function runInteractiveSetup(
  prompter: WizardPrompter,
  runtime: SetupRuntime,
): Promise<void> {
  const nametag = await prompter.text({
    message: "Choose a nametag for your bot:",
    placeholder: "mybot",
    validate: (value: string) => {
      const v = value.replace(/^@/, "").trim();
      if (!v) return "Nametag is required";
      if (!NAMETAG_REGEX.test(v)) return "Nametag must start with a letter and contain only letters, numbers, hyphens, or underscores (max 32 chars)";
      return undefined;
    },
  });

  const owner = await prompter.text({
    message: "Your nametag (owner, optional):",
    placeholder: "leave empty if no owner",
  });

  const network = await prompter.select({
    message: "Network:",
    options: [
      { value: "testnet", label: "testnet" },
      { value: "mainnet", label: "mainnet" },
    ],
    initialValue: "testnet",
  });

  const fullConfig = runtime.loadConfig() as Record<string, unknown>;

  // Ensure plugins.entries.unicity.config exists
  const plugins = (fullConfig.plugins ?? {}) as Record<string, unknown>;
  const entries = (plugins.entries ?? {}) as Record<string, unknown>;
  const unicityEntry = (entries.unicity ?? {}) as Record<string, unknown>;
  const existingPluginConfig = (unicityEntry.config ?? {}) as Record<string, unknown>;

  const cleanNametag = (nametag as string).replace(/^@/, "").trim();
  const cleanOwner = (owner as string).replace(/^@/, "").trim() || undefined;

  const updatedPluginConfig = {
    ...existingPluginConfig,
    nametag: cleanNametag,
    ...(cleanOwner ? { owner: cleanOwner } : {}),
    network: network as string,
  };

  // Remove owner key if empty
  if (!cleanOwner) {
    delete updatedPluginConfig.owner;
  }

  const updatedConfig = {
    ...fullConfig,
    plugins: {
      ...plugins,
      entries: {
        ...entries,
        unicity: {
          ...unicityEntry,
          enabled: true,
          config: updatedPluginConfig,
        },
      },
    },
  };

  await runtime.writeConfigFile(updatedConfig);
}

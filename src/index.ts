/** Uniclaw — Unicity identity + DMs plugin for OpenClaw. */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveUniclawConfig } from "./config.js";
import { initSphere, getSphereOrNull, destroySphere, getGeneratedMnemonic } from "./sphere.js";
import {
  uniclawChannelPlugin,
  setUnicityRuntime,
  setActiveSphere,
} from "./channel.js";
import { sendMessageTool } from "./tools/send-message.js";

const plugin = {
  id: "uniclaw",
  name: "Uniclaw",
  description: "Unicity wallet identity and Nostr DMs via Sphere SDK",

  register(api: OpenClawPluginApi) {
    const cfg = resolveUniclawConfig(api.pluginConfig);

    // Store runtime for the channel plugin to use
    setUnicityRuntime(api.runtime);

    // Channel
    api.registerChannel({ plugin: uniclawChannelPlugin });

    // Tool
    api.registerTool(sendMessageTool, { name: "uniclaw_send_message", optional: true });

    // Service — start Sphere before gateway starts accounts
    api.registerService({
      id: "uniclaw",
      async start() {
        const result = await initSphere(cfg, api.logger);
        setActiveSphere(result.sphere);

        if (result.created && result.generatedMnemonic) {
          api.logger.warn(
            `[uniclaw] New wallet created. Save your mnemonic:\n  ${result.generatedMnemonic}`,
          );
        }

        const identity = result.sphere.identity;
        api.logger.info(
          `[uniclaw] Identity: ${identity?.nametag ?? identity?.publicKey?.slice(0, 16) ?? "unknown"}`,
        );
      },
      async stop() {
        setActiveSphere(null);
        await destroySphere();
      },
    });

    // Inject identity context before agent runs
    api.on("before_agent_start", () => {
      const sphere = getSphereOrNull();
      if (!sphere) return;
      const identity = sphere.identity;
      const lines = [
        "## Unicity Identity",
        identity?.nametag ? `Nametag: ${identity.nametag}` : null,
        identity?.publicKey ? `Public key: ${identity.publicKey}` : null,
        identity?.address ? `Address: ${identity.address}` : null,
        "You can send DMs using the uniclaw_send_message tool.",
      ].filter(Boolean);
      return { prependContext: lines.join("\n") };
    });

    // CLI commands
    api.registerCli(
      ({ program, logger }) => {
        const cmd = program.command("uniclaw").description("Unicity wallet and identity");

        cmd
          .command("init")
          .description("Initialize wallet and mint nametag")
          .action(async () => {
            const result = await initSphere(cfg);
            if (result.created) {
              logger.info("Wallet created.");
              if (result.generatedMnemonic) {
                logger.warn(`Save your mnemonic:\n  ${result.generatedMnemonic}`);
              }
            } else {
              logger.info("Wallet already exists.");
            }
            const identity = result.sphere.identity;
            logger.info(`Public key: ${identity?.publicKey ?? "n/a"}`);
            logger.info(`Address: ${identity?.address ?? "n/a"}`);
            logger.info(`Nametag: ${identity?.nametag ?? "none"}`);
            await destroySphere();
          });

        cmd
          .command("status")
          .description("Show identity, nametag, and relay status")
          .action(async () => {
            const result = await initSphere(cfg);
            const sphere = result.sphere;
            const identity = sphere.identity;
            logger.info(`Network: ${cfg.network ?? "testnet"}`);
            logger.info(`Public key: ${identity?.publicKey ?? "n/a"}`);
            logger.info(`Address: ${identity?.address ?? "n/a"}`);
            logger.info(`Nametag: ${identity?.nametag ?? "none"}`);
            const mnemonic = getGeneratedMnemonic();
            if (mnemonic) {
              logger.info(`Mnemonic (first init only): ${mnemonic}`);
            }
            await destroySphere();
          });
      },
      { commands: ["uniclaw"] },
    );
  },
};

export default plugin;

/**
 * `openclaw unicity …` CLI. Registered from registerCliMetadata; api.runtime is read only inside actions.
 * Commands that open the wallet refuse while the gateway holds the wallet lock (two writers would corrupt wallet.json).
 */

import type { DirectMessage } from "@unicitylabs/sphere-sdk";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { API_KEY_HINT, readPluginConfig, type UnicityConfig } from "./config.js";
import { NameVerifier, toXOnly } from "./identity.js";
import { readLockHolder, WalletLockedError, type LockInfo } from "./lock.js";
import { openCliWallet } from "./sphere.js";
import { MNEMONIC_PATH, readGatewayStatus, walletExists, type GatewayStatus } from "./storage.js";
import { dmText, quoteLines } from "./text.js";
import { errorMessage } from "./util.js";
import { validateRecipient } from "./validation.js";

export const UNICITY_CLI_DESCRIPTOR = {
  name: "unicity",
  description: "Unicity wallet and identity",
  hasSubcommands: true,
} as const;

type CliWallet = Awaited<ReturnType<typeof openCliWallet>>;

function describeHolder(h: LockInfo): string {
  return `pid ${h.pid} on ${h.host}, since ${new Date(h.acquiredAt).toISOString()}`;
}

/**
 * An expected, user-facing refusal. OpenClaw's CLI failure handler prints only a generic "The CLI command failed."
 * for errors thrown by plugin actions, so refusals are logged by the action itself (see `guard`).
 */
export class CliRefusal extends Error {}

/**
 * OpenClaw's WizardCancelledError, thrown by the setup prompter when the user cancels a prompt. Matched by name so this
 * module (loaded with the plugin) does not load the setup SDK; only the lazily imported prompter does.
 */
const isWizardCancel = (err: unknown) => err instanceof Error && err.name === "WizardCancelledError";

/**
 * Runs an action, turning a CliRefusal into a logged message and exit code 1, and a cancelled prompt into a notice
 * and exit code 1 (as OpenClaw's own wizards exit). Other errors are logged and rethrown.
 */
function guard<A extends unknown[]>(logger: PluginLogger, command: string, action: (...args: A) => Promise<void>) {
  return async (...args: A): Promise<void> => {
    try {
      await action(...args);
    } catch (err) {
      if (err instanceof CliRefusal) {
        logger.error(err.message);
        process.exitCode = 1;
        return;
      }
      if (isWizardCancel(err)) {
        logger.info(`'openclaw unicity ${command}' cancelled; nothing was written.`);
        process.exitCode = 1;
        return;
      }
      logger.error(`'openclaw unicity ${command}' failed: ${errorMessage(err)}`);
      throw err;
    }
  };
}

function gatewayRunningError(holder: LockInfo, command: string): CliRefusal {
  const alternative = command === "send" ? " or ask the agent to send it" : "";
  return new CliRefusal(
    `The OpenClaw gateway is running and owns the Unicity wallet (${describeHolder(holder)}). ` +
      `'openclaw unicity ${command}' cannot open the wallet at the same time; stop the gateway first${alternative}. ` +
      "'openclaw unicity status' works while the gateway runs.",
  );
}

/** Opens the wallet for a CLI command, refusing (with a clear message) while another process holds it. */
async function openWalletForCommand(cfg: UnicityConfig, logger: PluginLogger, command: string): Promise<CliWallet> {
  try {
    return await openCliWallet(cfg, logger, command);
  } catch (err) {
    if (!(err instanceof WalletLockedError)) throw err;
    if (err.holder.role === "gateway") throw gatewayRunningError(err.holder, command);
    throw new CliRefusal(`The Unicity wallet is busy (${err.message}). Try again when that command has finished.`);
  }
}

function requireWallet(): void {
  if (!walletExists()) throw new CliRefusal("No Unicity wallet yet. Run 'openclaw unicity init' or start the gateway.");
}

type PrintedIdentity = { network: string; nametag?: string | null; chainPubkey?: string | null; directAddress?: string | null };

/** Identity lines shared by `init`/`status` (opened wallet) and `status` while the gateway runs (its published status). */
function printIdentity(logger: PluginLogger, id: PrintedIdentity): void {
  logger.info(`Network: ${id.network}`);
  logger.info(`Nametag: ${id.nametag ? `@${id.nametag}` : "none"}`);
  logger.info(`Public key: ${id.chainPubkey ?? "n/a"}`);
  logger.info(`Address: ${id.directAddress ?? "n/a"}`);
}

/** The gateway status file, only when the current lock holder wrote it (a crashed earlier run may have left its own). */
function publishedStatus(holder: LockInfo): GatewayStatus | null {
  const status = readGatewayStatus();
  return status && status.pid === holder.pid && status.startedAt >= holder.acquiredAt ? status : null;
}

/** Resolves with null on the first SIGINT/SIGTERM, or with the reason when the wallet lock is lost first. */
function untilInterruptedOrLost(lost: Promise<string>): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (reason: string | null) => {
      process.off("SIGINT", interrupted);
      process.off("SIGTERM", interrupted);
      resolve(reason);
    };
    const interrupted = () => done(null);
    process.on("SIGINT", interrupted);
    process.on("SIGTERM", interrupted);
    void lost.then(done);
  });
}

/** Payments line for `status`: only the gateway's wallet can have payments (CLI commands open it messaging-only). */
function paymentsLine(enabled: boolean): string {
  return enabled ? "Payments: enabled" : `Payments: disabled (no API key); ${API_KEY_HINT}`;
}

export function registerUnicityCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program, config, logger }) => {
      const root = program.command(UNICITY_CLI_DESCRIPTOR.name).description(UNICITY_CLI_DESCRIPTOR.description);
      const pluginConfig = () => {
        const cfg = readPluginConfig(config);
        for (const w of cfg.warnings) logger.warn(w);
        return cfg;
      };

      root
        .command("setup")
        .description("Interactive setup for nametag, owner, network and API key (config only)")
        .action(guard(logger, "setup", async () => {
          const { createCliPrompter } = await import("./cli-prompter.js");
          const { applySetupAnswers, collectSetupAnswers, remainingOwnerKeys, staleOwnerEntries } = await import("./setup.js");
          const prompter = createCliPrompter();
          await prompter.intro("Unicity setup");
          const answers = await collectSetupAnswers(prompter, pluginConfig());
          // Both read from the config as written, which may have changed on disk while setup prompted.
          let removed: string[] = [];
          let remaining: string[] = [];
          const written = await api.runtime.config.mutateConfigFile({
            afterWrite: { mode: "auto" },
            mutate(draft) {
              removed = staleOwnerEntries(draft, answers);
              remaining = remainingOwnerKeys(readPluginConfig(draft), answers.owner);
              Object.assign(draft, applySetupAnswers(draft, answers));
            },
          });
          const revoked = removed.length > 0
            ? ` Removed the previous owner from commands.ownerAllowFrom: ${removed.map((e) => JSON.stringify(e)).join(", ")}.`
            : "";
          const kept = remaining.length > 0
            ? ` ownerPubkeys is unchanged; these keys still have full owner authority: ${remaining.join(", ")}.`
            : "";
          await prompter.outro(
            `Saved to ${written.path}.${revoked}${kept} A running gateway reloads plugin config on its own; ` +
              "otherwise start it with 'openclaw gateway start'.",
          );
        }));

      root
        .command("init")
        .description("Create the wallet if needed and show its identity")
        .action(guard(logger, "init", async () => {
          const cfg = pluginConfig();
          const wallet = await openWalletForCommand(cfg, logger, "init");
          try {
            if (wallet.created) {
              logger.info("Wallet created.");
              logger.info(`Mnemonic backup saved to ${MNEMONIC_PATH} (keep it secret).`);
            } else {
              logger.info("Wallet already exists.");
            }
            printIdentity(logger, { network: cfg.network, ...wallet.sphere.identity });
            const nametag = wallet.sphere.identity?.nametag?.replace(/^@/, "");
            if (cfg.nametag && nametag !== cfg.nametag) {
              logger.warn(`The config asks for nametag @${cfg.nametag}, but the wallet's nametag is ${nametag ? `@${nametag}` : "not set"} (see the log above).`);
            }
          } finally {
            await wallet.close();
          }
        }));

      root
        .command("status")
        .description("Show the wallet identity and whether payments are enabled (read from the gateway while it runs)")
        .action(guard(logger, "status", async () => {
          const holder = readLockHolder();
          if (holder?.role === "gateway") {
            logger.info(`Gateway is running and owns the wallet (${describeHolder(holder)}).`);
            const status = publishedStatus(holder);
            if (!status) {
              logger.info("The gateway has not published its wallet status yet (the wallet may still be starting).");
              return;
            }
            printIdentity(logger, status);
            logger.info(paymentsLine(status.hasPayments));
            return;
          }
          requireWallet();
          const cfg = pluginConfig();
          const wallet = await openWalletForCommand(cfg, logger, "status");
          try {
            printIdentity(logger, { network: cfg.network, ...wallet.sphere.identity });
            logger.info(cfg.apiKey ? "Payments: API key set (the gateway enables payments with it)" : paymentsLine(false));
          } finally {
            await wallet.close();
          }
        }));

      root
        .command("send")
        .description("Send a DM to a @nametag or public key")
        .argument("<to>", "Recipient @nametag, public key or DIRECT:// address")
        .argument("<message>", "Message text")
        .action(guard(logger, "send", async (to: string, message: string) => {
          const recipient = to.trim();
          try {
            validateRecipient(recipient);
          } catch (err) {
            throw new CliRefusal((err as Error).message);
          }
          requireWallet();
          const wallet = await openWalletForCommand(pluginConfig(), logger, "send");
          try {
            const dm = await wallet.sphere.communications.sendDM(recipient, message);
            logger.info(`Sent to ${recipient} (id: ${dm.id}).`);
          } finally {
            await wallet.close();
          }
        }));

      root
        .command("listen")
        .description("Print incoming DMs until ctrl-c")
        .action(guard(logger, "listen", async () => {
          requireWallet();
          // Taken before the (slow) open so DMs arriving meanwhile count as live; DM timestamps have 1 s resolution.
          const startedAt = Math.floor(Date.now() / 1000) * 1000;
          const wallet = await openWalletForCommand(pluginConfig(), logger, "listen");
          const sphere = wallet.sphere;
          const ownKey = toXOnly(sphere.identity?.chainPubkey);
          const names = new NameVerifier(() => sphere);
          let printed = Promise.resolve();
          const onMessage = (msg: DirectMessage) => {
            const sender = toXOnly(msg.senderPubkey);
            // onDirectMessage replays the cached history (including our own sent DMs) before live messages.
            if (!sender || sender === ownKey || msg.timestamp < startedAt) return;
            const label = names
              .verify(msg.senderNametag, sender)
              .then((r) => names.label(r, sender))
              .catch(() => sender);
            // The SDK passes a sender's JSON-wrapped `text` on as is, so it can be null or an array.
            const text = dmText(msg.content);
            // Name lookups finish in any order; print in arrival order. The text goes below the header as quoted lines
            // (no control or bidi characters), so a message cannot print a line that looks like another DM's header.
            printed = printed.then(async () => logger.info(`[DM from ${await label}]:\n${quoteLines(text, "  > ")}`));
          };
          let unsubscribe: (() => void) | undefined;
          let lost: string | null;
          try {
            unsubscribe = sphere.communications.onDirectMessage(onMessage);
            logger.info(`Listening as ${sphere.identity?.nametag ? `@${sphere.identity.nametag}` : (ownKey ?? "unknown")} (ctrl-c to stop)...`);
            lost = await untilInterruptedOrLost(wallet.lost);
          } finally {
            unsubscribe?.();
            await wallet.close();
          }
          if (lost !== null) {
            throw new CliRefusal(`Stopped listening: another process took over the Unicity wallet (lock lost: ${lost}).`);
          }
        }));
    },
    { descriptors: [UNICITY_CLI_DESCRIPTOR] },
  );
}

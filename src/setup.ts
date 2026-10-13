/**
 * Setup shared by `openclaw unicity setup` and the channel setup wizard: prompts (collectSetupAnswers) and a pure
 * config transform (applySetupAnswers). Neither touches the plugin runtime or the wallet; the prompts only read the
 * owner pin file.
 */

import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import {
  API_KEY_URL, CHANNEL_ID, NETWORK_DEFAULTS, PLUGIN_ID, normalizeOwner, resolveUnicityConfig, type UnicityConfig,
  type UnicityNetwork,
} from "./config.js";
import { toXOnly } from "./identity.js";
import { OWNER_PIN_PATH, readJsonFileStrict, resolveDataDir } from "./storage.js";
import { errorMessage } from "./util.js";
import { normalizeNametag } from "./validation.js";

export type SetupAnswers = {
  nametag: string;
  owner?: string;
  network: UnicityNetwork;
  apiKey: string;
  /** The key the gateway pinned for the previous nametag owner, when setup replaces that owner. */
  previousOwnerPin?: { owner: string; key: string };
};

/**
 * The gateway API key, required. Entered hidden; on a re-run with the same network an empty answer keeps the configured
 * key (keys are per network, so a network change asks for a new one).
 */
async function promptApiKey(prompter: WizardPrompter, network: UnicityNetwork, current: UnicityConfig): Promise<string> {
  const kept = network === current.network ? current.apiKey : undefined;
  const answer = await prompter.text({
    message: kept
      ? `Unicity API key for ${network} (from ${API_KEY_URL}; leave empty to keep the configured key):`
      : `Unicity API key for ${network} (required for payments; get one at ${API_KEY_URL}):`,
    sensitive: true,
    validate: (v) => (v.trim() || kept ? undefined : `An API key is required. Get one at ${API_KEY_URL}.`),
  });
  const apiKey = answer.trim() || kept;
  if (!apiKey) throw new Error(`An API key is required. Get one at ${API_KEY_URL}.`);
  return apiKey;
}

export async function collectSetupAnswers(prompter: WizardPrompter, current: UnicityConfig): Promise<SetupAnswers> {
  const nametag = await prompter.text({
    message: "Nametag for your agent:",
    placeholder: "mybot",
    initialValue: current.nametag,
    validate: (v) =>
      normalizeNametag(v) ? undefined : "Nametags are 3-20 characters: letters, digits, '-' or '_' (a leading @ is fine).",
  });
  const owner = await prompter.text({
    message: "Owner: your @nametag or public key (leave empty for none):",
    placeholder: "@alice",
    initialValue: current.owner,
    validate: (v) =>
      !v.trim() || normalizeOwner(v) ? undefined : "Enter a @nametag or a 64/66-character hex public key.",
  });
  const network = await prompter.select<UnicityNetwork>({
    message: "Network:",
    initialValue: current.network,
    options: [
      { value: "testnet2", label: "Testnet", hint: "test tokens can be minted with unicity_top_up" },
      { value: "mainnet", label: "Mainnet", hint: "real value" },
    ],
  });
  if (current.walletApiUrl && network !== current.network) {
    await prompter.note(
      `walletApiUrl ${current.walletApiUrl} was set for ${current.network}; setup removes it so ${network} uses its ` +
        `default wallet API (${NETWORK_DEFAULTS[network].walletApiUrl}). Set it again in ` +
        `plugins.entries.${PLUGIN_ID}.config if you need an override.`,
      "Wallet API URL",
    );
  }
  const apiKey = await promptApiKey(prompter, network, current);
  const tag = normalizeNametag(nametag);
  if (!tag) throw new Error(`Invalid nametag "${nametag}".`);
  const ownerValue = owner.trim() ? normalizeOwner(owner) : undefined;
  if (ownerValue === null) throw new Error(`Invalid owner "${owner}".`);
  if (ownerValue && !toXOnly(ownerValue)) {
    await prompter.note(
      `Setup adds the placeholder "${ownerEntry(ownerValue)}" to commands.ownerAllowFrom so that approving a pairing ` +
        "code can never make a stranger an OpenClaw command owner. Once the gateway has pinned the owner's key " +
        `(log line "Owner @${ownerValue} pinned to <key>"), replace it with "${CHANNEL_ID}:<key>" to give the owner ` +
        "OpenClaw command access over Unicity.",
      "Command owner",
    );
  }
  const previousOwnerPin = await previousOwnerPinFor(prompter, current.owner, ownerValue);
  const remaining = remainingOwnerKeys(current, ownerValue);
  if (remaining.length > 0) {
    await prompter.note(
      `ownerPubkeys still lists:\n${remaining.map((k) => `  ${k}\n`).join("")}` +
        "These keys keep full owner authority on Unicity, including the wallet tools that send tokens, and while no " +
        "other owner key is known (no owner, or a nametag owner not pinned yet) owner notices go to the first of them. " +
        "Setup does not change ownerPubkeys: if these keys belonged to the previous owner, remove them from " +
        `plugins.entries.${PLUGIN_ID}.config.ownerPubkeys.`,
      "Additional owner keys",
    );
  }
  return { nametag: tag, owner: ownerValue, network, apiKey, ...(previousOwnerPin ? { previousOwnerPin } : {}) };
}

/**
 * The ownerPubkeys keys that keep owner authority when setup replaces or removes the configured owner with `owner`:
 * setup never edits ownerPubkeys, and cannot tell the previous owner's keys from a co-owner's. The new owner's own key
 * is left out. Empty when the owner does not change (or there was none).
 */
export function remainingOwnerKeys(current: UnicityConfig, owner: string | undefined): string[] {
  if (!current.owner || (owner && ownerEntry(owner) === ownerEntry(current.owner))) return [];
  const ownerKey = owner ? toXOnly(owner) : null;
  return current.ownerPubkeys.filter((k) => k !== ownerKey);
}

/**
 * The key pinned for owner nametag `name` in owner-pin.json, or null when it has none. Read only: the wallet is never
 * opened. Throws when the file cannot be read or parsed, or its entry for `name` holds no valid key.
 */
function readOwnerPin(name: string): string | null {
  resolveDataDir();
  const file = readJsonFileStrict<unknown>(OWNER_PIN_PATH, { pins: {} });
  const pins = file !== null && typeof file === "object" ? (file as { pins?: unknown }).pins : undefined;
  if (pins === null || typeof pins !== "object" || Array.isArray(pins)) throw new Error('not a {"pins": {...}} object');
  if (!Object.hasOwn(pins, name)) return null;
  const entry: unknown = (pins as Record<string, unknown>)[name];
  const raw = entry !== null && typeof entry === "object" ? (entry as { key?: unknown }).key : undefined;
  const key = typeof raw === "string" ? toXOnly(raw) : null;
  if (!key) throw new Error(`the pin for @${name} holds no valid key`);
  return key;
}

/**
 * When setup replaces a nametag owner (`previous`), the key the gateway pinned for it: an entry the operator added for
 * that key (`unicity:<key>`, as the setup note suggests) must go too, or the former owner stays an OpenClaw command
 * owner. Tells the user what happens, including when the pin cannot be read.
 */
async function previousOwnerPinFor(
  prompter: WizardPrompter,
  previous: string | undefined,
  next: string | undefined,
): Promise<SetupAnswers["previousOwnerPin"]> {
  if (!previous || toXOnly(previous) || (next && ownerEntry(next) === ownerEntry(previous))) return undefined;
  const removeByHand =
    `If you added a "${CHANNEL_ID}:<key>" entry for @${previous} to commands.ownerAllowFrom, remove it yourself.`;
  let key: string | null;
  try {
    key = readOwnerPin(previous);
  } catch (err) {
    await prompter.note(
      `The owner pin file ${OWNER_PIN_PATH} cannot be read (${errorMessage(err)}), so setup cannot tell which key ` +
        `@${previous} was pinned to. ${removeByHand}`,
      "Previous owner",
    );
    return undefined;
  }
  if (!key) {
    await prompter.note(`No key is pinned for the previous owner @${previous} in ${OWNER_PIN_PATH}. ${removeByHand}`, "Previous owner");
    return undefined;
  }
  if (next && toXOnly(next) === key) return undefined;
  await prompter.note(
    `The previous owner @${previous} is pinned to ${key}. Setup removes any "${CHANNEL_ID}:<key>" entry for that key ` +
      "from commands.ownerAllowFrom, so the previous owner is no longer an OpenClaw command owner.",
    "Previous owner",
  );
  return { owner: previous, key };
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * commands.ownerAllowFrom entry for a configured owner: `unicity:<x-only key>` for a key; for a nametag the sentinel
 * `unicity:@<nametag>`, which never matches a sender key but still counts as a configured command owner, so
 * `openclaw pairing approve` cannot bootstrap an approved stranger into the command-owner slot.
 */
function ownerEntry(owner: string): string {
  const key = toXOnly(owner);
  return `${CHANNEL_ID}:${key ?? `@${owner}`}`;
}

const pluginEntryConfig = (root: Record<string, unknown>): Record<string, unknown> =>
  asRecord(asRecord(asRecord(asRecord(root.plugins).entries)[PLUGIN_ID]).config);

const ownerAllowFrom = (root: Record<string, unknown>): unknown[] => {
  const list = asRecord(root.commands).ownerAllowFrom;
  return Array.isArray(list) ? list : [];
};

/** The x-only key of a `unicity:<64/66-hex>` command-owner entry, else null. */
function entryKey(entry: unknown): string | null {
  const e = String(entry).trim();
  const prefix = `${CHANNEL_ID}:`;
  return e.toLowerCase().startsWith(prefix) ? toXOnly(e.slice(prefix.length)) : null;
}

/**
 * The commands.ownerAllowFrom entries applySetupAnswers removes: when the owner changes, the previous owner's entry
 * (see ownerEntry) and every `unicity:<key>` entry (x-only or 66-hex) for the previous owner's key, which for a nametag
 * owner is answers.previousOwnerPin. A key that stays the owner's is kept.
 */
export function staleOwnerEntries(fullConfig: object, answers: SetupAnswers): string[] {
  const root = fullConfig as Record<string, unknown>;
  const raw = pluginEntryConfig(root).owner;
  const previous = typeof raw === "string" ? normalizeOwner(raw) : null;
  const wanted = answers.owner ? ownerEntry(answers.owner) : null;
  if (!previous || ownerEntry(previous) === wanted) return [];
  const pin = answers.previousOwnerPin;
  const previousKey = toXOnly(previous) ?? (pin && pin.owner === previous ? pin.key : null);
  const keptKey = answers.owner ? toXOnly(answers.owner) : null;
  const stale = (e: unknown) =>
    String(e).trim().toLowerCase() === ownerEntry(previous) ||
    (!!previousKey && previousKey !== keptKey && entryKey(e) === previousKey);
  return ownerAllowFrom(root).filter(stale).map(String);
}

/**
 * Returns a new config with the plugin entry enabled and the answers merged into its config. A walletApiUrl override
 * belongs to one network, like the API key, so a network change drops it. The owner is also added to
 * commands.ownerAllowFrom (see ownerEntry); when the owner changes, the previous owner's entries are removed so it is no
 * longer a command owner (see staleOwnerEntries). ownerPubkeys is left as configured (see remainingOwnerKeys).
 */
export function applySetupAnswers<C extends object>(fullConfig: C, answers: SetupAnswers): C {
  const root = fullConfig as Record<string, unknown>;
  const plugins = asRecord(root.plugins);
  const entries = asRecord(plugins.entries);
  const entry = asRecord(entries[PLUGIN_ID]);
  const previous = asRecord(entry.config);

  const config: Record<string, unknown> = { ...previous, nametag: answers.nametag, network: answers.network, apiKey: answers.apiKey };
  if (resolveUnicityConfig(previous).network !== answers.network) delete config.walletApiUrl;
  if (answers.owner) config.owner = answers.owner;
  else delete config.owner;

  const next: Record<string, unknown> = {
    ...root,
    plugins: { ...plugins, entries: { ...entries, [PLUGIN_ID]: { ...entry, enabled: true, config } } },
  };

  const wanted = answers.owner ? ownerEntry(answers.owner) : null;
  const stale = new Set(staleOwnerEntries(root, answers));
  const commands = asRecord(root.commands);
  const current = ownerAllowFrom(root);
  const kept = stale.size > 0 ? current.filter((e) => !stale.has(String(e))) : current;
  const added = wanted && !kept.some((e) => String(e).trim().toLowerCase() === wanted) ? [wanted] : [];
  if (kept.length !== current.length || added.length > 0) next.commands = { ...commands, ownerAllowFrom: [...kept, ...added] };

  return next as C;
}

# Unicity wallet plugin for [OpenClaw](https://github.com/openclaw/openclaw) agents

<p align="center">
  <img src="logo.png" alt="Unicity" width="300" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@unicitylabs/openclaw-unicity"><img src="https://img.shields.io/npm/v/@unicitylabs/openclaw-unicity" alt="npm version" /></a>
  <a href="https://github.com/unicitynetwork/openclaw-unicity/blob/main/LICENSE"><img src="https://img.shields.io/github/license/unicitynetwork/openclaw-unicity" alt="license" /></a>
  <a href="https://deepwiki.com/unicitynetwork/openclaw-unicity"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
</p>

---

**Unicity** is an [OpenClaw](https://github.com/openclaw/openclaw) plugin that gives your AI agent its own Unicity wallet: a `@nametag` identity, encrypted direct messages over Unicity's Nostr relays, NIP-29 group chats, and token payments, powered by the [Unicity Sphere SDK](https://github.com/unicitylabs/sphere-sdk).

## Features

- **Wallet identity**: generates a wallet on first start (mnemonic backup on disk) and registers your chosen `@nametag`
- **Encrypted DMs**: an OpenClaw channel (`unicity`) for inbound and outbound direct messages
- **Group chat**: create, join and talk in public and private NIP-29 groups
- **Payments** (with an API key): balances, tokens, history, transfers, payment requests, and test-token minting on testnet2
- **Owner model enforced in code**: wallet tools work only for the authenticated owner (in the owner's Unicity DMs, or on another channel for a sender OpenClaw recognizes as owner); every other Unicity turn gets a minimal tool allowlist, whatever the model is told
- **DM access control**: `open`, `allowlist`, `pairing` or `disabled`
- **Setup and CLI**: `openclaw unicity setup`, the onboarding wizard, and `openclaw unicity init | status | send | listen`

## Requirements

- Node.js 24.16+ (24.x) or 26.1+, the same range as OpenClaw
- OpenClaw 2026.10.2 or newer. Older OpenClaw does not check the plugin's minimum host version: it installs the plugin but cannot load it.
- A Unicity API key for payments, from [sphere.unicity.network](https://sphere.unicity.network). Without one the agent runs messaging-only.

## Quick start

### 1. Install the plugin

```bash
openclaw plugins install @unicitylabs/openclaw-unicity
```

The package comes from npm rather than ClawHub, so OpenClaw first asks you to confirm the source, then to approve the plugin's capabilities (a channel, agent tools, hooks and a CLI command). In a non-interactive script, review the package first, then pass both flags:

```bash
openclaw plugins install npm:@unicitylabs/openclaw-unicity --force --accept-capabilities
```

`--force` confirms the npm source (and overwrites an existing install). Update with `openclaw plugins update openclaw-unicity`.

### 2. Get an API key

Get a Unicity API key for your network at [sphere.unicity.network](https://sphere.unicity.network). The plugin ships none.

### 3. Configure it

```bash
openclaw unicity setup
```

This asks for the agent's nametag, the owner (your `@nametag` or public key), the network and the API key (entered hidden; on a re-run for the same network, an empty answer keeps the configured key), then writes the plugin config and a `commands.ownerAllowFrom` entry for the owner (see [The owner](#the-owner)). Cancelling at any prompt (ctrl-c) writes nothing. `openclaw onboard` and `openclaw channels add unicity` run the same questions.

### 4. Start the gateway

```bash
openclaw gateway start
```

On first start the plugin creates the wallet, saves the mnemonic to `mnemonic.txt` in its [data directory](#data-storage) (`~/.openclaw/unicity/` by default; mode 0600; back it up, the gateway logs the full path), registers the nametag and DMs the owner a greeting. If the wallet cannot open (no network yet, or a CLI command holds the wallet), the gateway keeps retrying with backoff (5 s doubling up to 5 min) instead of giving up.

## Configuration

Plugin settings live in OpenClaw's config file (`~/.openclaw/openclaw.json` by default; `openclaw config file` prints the one in use):

```json5
{
  "plugins": {
    "entries": {
      "openclaw-unicity": {
        "enabled": true,
        "config": {
          "network": "testnet2",          // testnet2 (default) | mainnet
          "nametag": "my-agent",          // the agent's @nametag
          "owner": "alice",               // owner nametag (no @) or 64/66-hex public key
          "ownerPubkeys": [],             // extra owner keys (64/66-hex), optional
          "apiKey": "sk_…",               // from https://sphere.unicity.network; without it: messaging-only
          "walletApiUrl": "https://…",    // optional override of this network's wallet API
          "additionalRelays": [],         // optional extra Nostr relays for DMs
          "groupChat": true,              // true | false (no group traffic at all) | { "relays": ["wss://…"] }
          "dmPolicy": "allowlist",        // open (default) | allowlist | pairing | disabled
          "allowFrom": ["@bob", "02ab…"], // nametags or public keys; with "open", any entry other than "*" makes it an allowlist
          "strangerToolsAllow": []        // extra tools for non-owner turns; dangerous, see Security
        }
      }
    }
  },
  "commands": {
    "ownerAllowFrom": ["unicity:<owner x-only public key>"]  // see "The owner"
  }
}
```

`channels.unicity` accepts `enabled`, `name`, `dmPolicy`, `allowFrom` and `healthMonitor`; its `dmPolicy` and `allowFrom` override the plugin-level values when set. Everything about the wallet is plugin config.

`channels.unicity.enabled: false` disables the **whole plugin**, not only the channel: OpenClaw then neither opens the wallet nor registers the wallet tools.

### Networks

| Network | Payments | Notes |
|---------|----------|-------|
| `testnet2` (default) | with `apiKey` | Test tokens are minted with `unicity_top_up`. |
| `mainnet` | with `apiKey` | `unicity_top_up` is unavailable. |

An API key belongs to one network; get it at [sphere.unicity.network](https://sphere.unicity.network). So does a `walletApiUrl` override: when you switch networks, `openclaw unicity setup` asks for the new network's key and removes the override. Without `apiKey` the wallet runs **messaging-only** on either network: DMs and groups work; payment tools answer that payments are disabled and how to enable them; no payment notices arrive; the gateway logs a warning and `openclaw unicity status` says so.

## Security model

### The owner

The owner is the human who controls the agent and its wallet. Ownership comes only from authenticated public keys, never from a nametag that a sender claims:

- `owner` as a **public key** (64-hex x-only or 66-hex chain key) is used directly.
- `owner` as a **nametag** is resolved on first start, checked, and **pinned** (trust on first use) in `owner-pin.json` in the [data directory](#data-storage); the gateway logs `Owner @alice pinned to <key>`. Until the pin is saved the nametag owner is not recognized: if `owner-pin.json` cannot be written, the gateway logs an error and tries again at its next owner lookup (at most once a minute: when the wallet or the channel starts, or when a DM, group message, transfer or payment request arrives). If the nametag later resolves to a different key, the plugin keeps the pinned key and logs an error; delete the pin file to re-pin deliberately. If the pin file cannot be read or parsed, the plugin does not re-pin either: a nametag owner is not recognized (owner keys given as `owner` or in `ownerPubkeys` still are), and the gateway logs an error, until you repair or delete the file and restart the gateway.
- `ownerPubkeys` adds more trusted owner keys, for example when your client signs DMs with a key other than the one your nametag publishes.

On the Unicity channel only these keys make someone the owner. OpenClaw's own owner flag (`commands.ownerAllowFrom`) is not trusted there, so a mistaken or pairing-created entry cannot unlock the wallet.

**`commands.ownerAllowFrom`.** `openclaw unicity setup` adds the owner to OpenClaw's command owners: `unicity:<x-only key>` for a key owner, or the placeholder `unicity:@<nametag>` for a nametag owner. The placeholder matches nobody, but it counts as a configured command owner, which keeps [pairing](#dm-policy) safe. Once the gateway has pinned a nametag owner's key, replace the placeholder with `unicity:<key>` to give the owner OpenClaw command access (slash commands, owner-only core tools) over Unicity. Note that as soon as `commands.ownerAllowFrom` lists anyone, OpenClaw lets only the listed owners run most commands on **every** channel, so add your other accounts too, for example `telegram:<id>`; owners on other channels are also recognized by the wallet tools this way. When you change or remove the owner, setup also removes the previous owner's entries: the placeholder or key entry it wrote, and every `unicity:<key>` entry (64- or 66-hex) for the previous owner's key. For a nametag owner that is the key pinned in `owner-pin.json`, which setup reads without opening the wallet and names before writing; `openclaw unicity setup` also lists the entries it removed. If the pin file cannot be read or holds no pin for the previous owner (for example because you deleted it), setup says so; then remove any `unicity:<key>` entry for the previous owner yourself. Setup does not change `ownerPubkeys`: after the owner changes or is removed, every key listed there keeps full owner authority on Unicity, including the wallet tools that send tokens, and owner notices go to the first of them while no other owner key is known. Setup lists those keys in a note when the owner changes or is removed (`openclaw unicity setup` repeats them when it finishes); remove the previous owner's keys from `ownerPubkeys` yourself.

**An owner recognized on another channel gets the wallet tools in that channel's group chats too**, not only in DMs. There the other members' messages are part of the same conversation and can steer the owner's turn, for example into a payment, and what the wallet tools return (balances, history) lands in a chat everyone reads. If the agent is in groups with other people on such a channel, deny the wallet tools there with that channel's per-group tool policy (`tools: { deny: ["unicity_*"] }` on those groups, see OpenClaw's group tool restrictions) and use the wallet from a DM.

### What is enforced

- **Owner-only tools** (all wallet tools except `unicity_list_groups` and `unicity_request_payment`) work only in the owner's Unicity DMs, and for senders OpenClaw recognizes as owner on other channels (in their DMs and group chats alike, see above). They are not offered to any other turn, and a `before_tool_call` gate blocks them per call and fails closed when the host cannot identify the requester. This does not depend on the model following instructions.
- **Every other Unicity turn gets an allowlist**: DMs from anyone but the owner and every incoming transfer or payment request turn can use only `unicity_request_payment` and `unicity_list_groups`; **every Unicity group turn (the owner's included)** only `unicity_list_groups`. Both also get anything listed in `strangerToolsAllow`. OpenClaw's core tools (exec, files, sessions, the `message` tool, …) are unavailable on those turns, so a stranger cannot talk the agent into reading the mnemonic or messaging people.
- **`strangerToolsAllow`** (plugin config) is the escape hatch for that allowlist. Anything listed there is available to anyone who can message the agent: never add exec, file-system, sessions or `message` tools. Owner-only `unicity_*` tools stay blocked even if listed: entries that would select one (its name, a wildcard such as `*` or `unicity_*`, `group:plugins` or the plugin id) are ignored, so list the extra tools by name. In groups `unicity_request_payment` stays blocked the same way.
- **Sending as the agent is owner-only on every channel**: for anyone but the owner, OpenClaw's `message` tool sends through Unicity only back to that person's own Unicity DM conversation or key. That rules out sends from other channels, from group turns, and from internal runs in a Unicity session (Control UI chat, `sessions_send`). The check counts a `channel` parameter as another channel only when it names one enabled under `channels`; anything else counts as the run's own channel, which is where OpenClaw sends when it cannot resolve the name.
- Non-owners may use `unicity_request_payment` only to request payment **from themselves**, and only in DMs: the recipient is forced to the sender's authenticated key. In a group the sender's key is only the relay's word, so the tool is not offered there. A recipient given as a `@nametag`, 64-hex key or `DIRECT://` address must have a self-consistent published binding (its chain key belongs to the key that signed it), so a forged binding cannot redirect the request; a 66-hex chain key is used exactly as given. Requests asked for this way are kept apart from the owner's own in the local list of sent requests, so a flood of them cannot push the owner's records out, and `unicity_list_payment_requests` marks them as asked for by the payer.
- **Commands**: group messages, incoming transfers and payment requests are never interpreted as commands, whatever `commands.allowFrom` says. A stranger's DM can use OpenClaw's non-owner commands and directives only when `commands.allowFrom` admits that sender on `unicity` (by key, by a wildcard, or through the global `"*"` default); the plugin itself never marks a non-owner's DM as command-authorized. Owner-only commands need `commands.ownerAllowFrom`.
- Incoming transfers and payment requests never get owner tools, even when the owner sent them; their memo text is untrusted. The plugin never pays a request on its own. Only the plugin's own transfer turns report a payment, and on them the agent is told that tokens still pending verification or failing it are not payment. On DM and group turns it is told that a message claiming a payment proves nothing, even one that copies a notice such as `[Payment received] …` word for word, and every line in a non-owner's DM or a group message that contains the opening of such a notice reaches it marked as the sender's text. This relies on the model following its instructions; non-owner turns cannot look up the balance to check a claim.
- A nametag another user claims is shown as theirs only when it resolves to their key: in owner notices and DM labels, and in the payment-request tools and the transaction history as `@alice (verified, <key>)` (a lookup that takes longer than 5 seconds counts as unverified). Otherwise it is labelled an unverified claim, which anyone can forge. When the owner names a requester instead of giving a request id, the agent is told to pay only a request whose name is verified, and otherwise to ask for the request id from the owner's notice. Group names are chosen by group creators and are treated as untrusted text. OpenClaw gets only the group id as a group conversation's label, because it shows group session titles in the system prompt of the agent's main session. The main session can still read group transcripts with `sessions_history`; that text is untrusted too.
- DMs from admitted non-owners are forwarded to the owner as a quoted block, so they cannot pass for plugin notices.

### Groups

- **Group messages are authenticated only by the group relay**: the SDK does not verify NIP-29 event signatures, and everyone in a group shares one conversation. That is why Unicity group turns, the owner's own group messages included, can use only `unicity_list_groups` (public groups only): financial and all other wallet tools, payment requests and commands are blocked in Unicity groups (for group chats on other channels, see [The owner](#the-owner)). The agent still recognizes the owner conversationally there; ask for wallet actions in a DM.
- **Every group has its own session** (`agent:<agent id>:unicity:group:<group id>`), whatever the global `session.groupScope` says. A binding that routes a Unicity group into another session (`bindings[].session.groupScope: "main"`) is refused: the agent does not answer in that group, and the gateway logs a warning.
- **DMs from anyone but the owner stay in the sender's own DM session too**, and so do incoming transfers and payment requests from them, whatever the global `session.dmScope` says. A binding that routes them into the agent's main session (`bindings[].session.dmScope: "main"` on a binding they match, such as one for the whole `unicity` channel) is refused: they get no turn, not even after you change the binding, and their DMs are not forwarded to you (you are still told about their transfers and payment requests); the gateway logs a warning once per channel start. A binding that matches only the owner's key may pin the owner's DMs to the main session.
- **The agent only answers in groups the owner sanctioned**: groups it created or joined through its tools (at the owner's request in a DM). Any NIP-29 group admin can add the agent's key to a group; such a group is ignored, and the owner gets one DM about it (recorded once it is delivered). To accept it, ask the agent in a DM to join it; to get rid of it, ask it to leave. Once the agent leaves a group, is kicked from it, or the group is deleted, the approval is gone: if an admin adds the agent back, the group is ignored again and you get a new DM about it.
- `dmPolicy` does not apply to groups. `groupChat: false` turns group chat off entirely.

### DM policy

| `dmPolicy` | Who can DM the agent |
|------------|----------------------|
| `open` (default) | Anyone. Unknown senders get the non-owner allowlist above (and use model time; their DMs are forwarded to you). With `allowFrom` entries other than `"*"` it behaves like `allowlist`. |
| `allowlist` | The owner and senders in `allowFrom`. |
| `pairing` | The owner, `allowFrom`, and senders you approved. Unknown senders get a pairing code and you get an access request; approve it with `openclaw pairing approve unicity <CODE>`. |
| `disabled` | Nobody, including the owner. DMs that arrive meanwhile are not answered once DMs are enabled again either. |

`dmPolicy` also decides whether an incoming transfer's or payment request's memo reaches the agent as a turn; the owner is notified either way. Public keys in `allowFrom` are matched exactly; nametags are resolved to keys (a nametag binding can change, so prefer keys). When the plugin cannot tell whether a sender is admitted, because a nametag lookup failed or timed out with no key known for that nametag from the last hour, the pairing store could not be read, or the sender may be a nametag owner whose key is not known yet (with keys in `ownerPubkeys`, only a sender claiming the owner's nametag counts as that), it neither answers the DM nor records it as handled, and sends no pairing code. The gateway logs a warning, and the DM is decided again when the Unicity channel restarts or the plugin reloads (not after a gateway restart, see below). A transfer or payment request from such a sender gets no turn; you are still notified.

DM timestamps are set by the sender, and relays deliver recent DMs again whenever the wallet reconnects. A relay can also serve a DM again under a new event id (nothing verifies that id), so the plugin identifies a DM by its authenticated sender, its timestamp and its text, never by the event id. As a result, identical DMs from the same sender within the same second count as one. The plugin does not answer a DM that is delivered again: it records the DMs it handled in `event-state.json`, and when it drops old records it keeps the time up to which DMs were handled (overall and per sender), so an older DM delivered again is skipped. After a gateway restart, DMs dated before the start are not answered at all.

A DM dated more than 5 minutes ahead of the gateway's clock is ignored and recorded as handled, so it does not run later once the clock catches up. When that record is dropped, every DM from that sender dated up to that date is skipped from then on: the dropped DM, and also correctly dated DMs the sender sends before that date comes. The skip reaches at most 7 days past the DM's arrival, so a DM dated further ahead than that is covered only while its record is kept.

**If the plugin cannot write `event-state.json`** (a full disk, a read-only directory), **it stops answering DMs until it can.** A DM's turn runs only after its record is written, so nothing is processed twice; a stranger's DM is forwarded to you only along with its turn. The gateway logs an error (once per channel start). The DMs that arrive meanwhile are answered once the file can be written again **and** the Unicity channel restarts or the plugin reloads; waiting is not enough, because the running wallet ignores a relay delivering the same DM again. To restart only the channel, run `openclaw gateway call channels.stop --params '{"channel":"unicity"}'`, then the same call with `channels.start`. Do not restart the gateway for this: DMs dated before its start are not answered (see above), so those DMs would be lost. DMs that get no turn (from senders `dmPolicy` does not admit, dated too far ahead, or pairing requests) are still handled meanwhile, but the plugin remembers them only until it reloads: after a reload such a DM can be handled again, and one dated too far ahead runs once the clock has caught up with it.

> **Pairing needs a command owner.** When `commands.ownerAllowFrom` names no command owner (an entry other than `"*"` or `"<channel>:*"`), OpenClaw makes the first sender you approve with `openclaw pairing approve` a command owner. The plugin therefore **pauses pairing** in that state: unknown senders get no code, and you get a DM explaining how to set `commands.ownerAllowFrom`. `openclaw unicity setup` writes such an entry for you.

### Prompt context on other channels (optional)

On Unicity turns the plugin puts the wallet identity and the owner/stranger rules into the system prompt itself. To also give the owner's turns on **other** channels the wallet identity, grant the plugin conversation access:

```json5
{ "plugins": { "entries": { "openclaw-unicity": { "hooks": { "allowConversationAccess": true } } } } }
```

Nothing security-relevant depends on this grant.

## CLI

| Command | What it does |
|---------|--------------|
| `openclaw unicity setup` | Interactive config (nametag, owner, network, API key) and the owner's `commands.ownerAllowFrom` entry. Config only; never opens the wallet; never prints the key. Cancelling writes nothing (it exits with code 1). |
| `openclaw unicity init` | Creates the wallet if needed, applies the configured nametag (registering it if needed, on a new HD address when the current one already has another nametag) and prints the identity. |
| `openclaw unicity status` | Prints the identity and whether payments are enabled. While the gateway runs it reports what the running gateway published, without opening the wallet (or says the gateway is still starting). |
| `openclaw unicity send <to> <message>` | Sends a DM. |
| `openclaw unicity listen` | Prints incoming DMs until ctrl-c, each message's text as quoted lines below its sender (control and bidi characters replaced), so a message cannot print a line that looks like another DM. Stops with an error if another process takes over the wallet lock. |

Only one process may use the wallet at a time. `init`, `send` and `listen` refuse with an explanation while the gateway is running; stop the gateway first (or ask the agent to send the message). `status`, `send` and `listen` open the wallet as it is: they never register a nametag or switch addresses, and only warn when the configured nametag differs. `init` or the next gateway start applies it.

## Agent tools

| Tool | Description | Who |
|------|-------------|-----|
| `unicity_send_message` | Send an encrypted DM to a `@nametag` or public key | owner |
| `unicity_get_balance` | Token balances, optionally for one coin | owner |
| `unicity_list_tokens` | Individual tokens | owner |
| `unicity_get_transaction_history` | Recent sent, received and minted transactions, plus transfers still settling (not yet in the history) | owner |
| `unicity_send_tokens` | Send tokens (duplicate guard below) | owner |
| `unicity_request_payment` | Send a payment request | owner; others only to themselves, in DMs |
| `unicity_list_payment_requests` | Incoming requests, and requests the agent sent | owner |
| `unicity_respond_payment_request` | Pay or decline an incoming request (duplicate guard below) | owner |
| `unicity_top_up` | Mint test tokens (testnet2 only) | owner |
| `unicity_create_public_group` | Create a public NIP-29 group | owner |
| `unicity_create_private_group` | Create a private group and DM the join code to invitees | owner |
| `unicity_join_group` | Join a group (private groups need a join code) | owner |
| `unicity_leave_group` | Leave a group | owner |
| `unicity_list_groups` | List joined groups or discover public ones | anyone (non-owners see public groups only) |
| `unicity_send_group_message` | Post to a joined group | owner |

"Owner" means the owner's Unicity DMs, or a sender OpenClaw recognizes as owner on another channel (`commands.ownerAllowFrom`), including that sender's messages in that channel's group chats. A Unicity group turn is never an owner turn. Recipients are a `@nametag`, a 64-hex public key, a 66-hex chain public key, or a `DIRECT://` address; `PROXY:` addresses are not accepted. Payment tools need `apiKey` (see [Networks](#networks)).

Money tools never report a send that may have gone through as a failure: if the outcome is uncertain they say so and tell the agent not to retry. This includes the rest of a partly completed payment: unless that remainder provably never left the wallet, its outcome is reported as unknown.

A transfer missing from the transaction history does **not** show that nothing was paid: the wallet adds a SENT row only after a transfer completes, and only best effort, so a transfer still in progress, or one whose completion failed, may never appear there. `unicity_get_transaction_history` lists transfers still in progress apart, as still settling; a SENT row or a settling transfer to the payee confirms the money went out, but their absence proves nothing. After an uncertain payment the agent is told to tell the owner that the wallet cannot rule out an earlier payment and that only the recipient can confirm what arrived, and to pay again (`allowDuplicate: true`) only if the owner confirms knowing that.

**Duplicate guard.** `allowDuplicate: true` (for when the owner confirms) overrides every refusal below.

- `unicity_send_tokens` refuses a send identical to an earlier one (same coin, amount and payee, whichever spelling of the payee: `@nametag`, 64/66-hex key or `DIRECT://`) within 15 minutes, or while the earlier one is still pending in the wallet. To match the spellings it looks up the payee's key first; when that lookup fails or times out, the send is refused and nothing is sent.
- An earlier send whose outcome is unresolved and has no transfer to look up blocks for 24 hours, and so does a completed send whose delivery to the recipient was still pending while the wallet's pending transfers cannot be read. After a partial send, the identical full amount stays refused, and so does re-sending only a remainder whose outcome is unknown.
- `unicity_respond_payment_request` refuses to pay a request again within 30 days of an earlier attempt to pay it that did not cleanly fail, and while an earlier attempt is unresolved (with no time limit). `unicity_list_payment_requests` puts a WARNING on each pending request with a recorded attempt.
- Paying a request sends its coin and amount to the requester, so the two guards also block each other: `unicity_send_tokens` treats a payment of a request as an earlier send of that coin and amount to the requester (under the rules for sends above), and `unicity_respond_payment_request` refuses to pay a request while a send of the same coin and amount to the requester would be refused as identical.

The tools are in OpenClaw's `messaging` tool profile and in `full`. For other profiles add them with `tools.alsoAllow: ["openclaw-unicity"]`.

## Data storage

The plugin keeps its files in `unicity/` inside OpenClaw's state directory, so every OpenClaw profile has its own wallet: `~/.openclaw/unicity/` by default, `~/.openclaw-<name>/unicity/` with `--profile <name>`, `~/.openclaw-dev/unicity/` with `--dev`, and `$OPENCLAW_STATE_DIR/unicity/` when that is set (`OPENCLAW_HOME` moves the default like the rest of OpenClaw's state). On a hosted deploy keep the state directory on a persistent volume, as OpenClaw's hosting guides do with `OPENCLAW_STATE_DIR`; otherwise a redeploy starts a new, empty wallet, and the old one can only be restored from its mnemonic.

| File (in `<state dir>/unicity/`) | Contents |
|------|----------|
| `mnemonic.txt` | Mnemonic backup (mode 0600) |
| `wallet.json` | Wallet state |
| `wallet.lock` | Lock held by the process that has the wallet open |
| `owner-pin.json` | Pinned owner key (when `owner` is a nametag). While it is unreadable or corrupt a nametag owner is not recognized; repair or delete it, then restart the gateway (deleted, the owner is pinned again) |
| `groups-approved.json` | Groups the owner sanctioned, and groups the owner was told about. While it is unreadable no group is answered; stop the gateway, then repair or remove it (removed, ask the agent to join its groups again) |
| `gateway-status.json` | Identity published by the running gateway for `openclaw unicity status` |
| `payment-ledger.json`, `outgoing-requests.json` | Payment bookkeeping |
| `event-state.json` | Which DMs, transfers and payment requests were already handled, so a restart or a relay delivering them again does not handle them again (for DMs, beyond the most recent records, the time up to which they were handled, overall and per sender). **Never delete or edit it while the gateway runs.** While it is unreadable no DM is answered (the owner's included) and the gateway logs a warning for each; stop the gateway, then repair or remove it. While it cannot be written, no DM is answered either; the DMs that arrive meanwhile are answered after it can be written again and the Unicity channel restarts or the plugin reloads, not after a gateway restart (see [DM policy](#dm-policy)) |
| `wallet-api-device.json` | Wallet API device id |

A lock left behind by a crashed process is reclaimed automatically: after 12 s when its process is gone, when its process id now belongs to another program (Linux and macOS compare process start times), when it predates the last reboot, and otherwise (Windows, or another host or container sharing the directory) after it has stopped being refreshed for more than two minutes. If a command keeps reporting a holder that is not an OpenClaw process, stop the gateway and delete `wallet.lock` from the data directory. Do not share this directory over NFS or other network file systems.

## Development

```bash
npm ci                # .npmrc sets ignore-scripts=true; dependency install scripts never run
npm run lint
npm run typecheck     # src/ and the e2e harness
npm test
npm run build         # compiles src/ to dist/
npm run pack:local    # build, then npm pack
```

`ignore-scripts` also skips npm lifecycle scripts such as `prepack`, so `npm pack` and `npm publish` would ship whatever `dist/` is on disk. Use `npm run pack:local` for a local tarball, and never run `npm pack` or `npm publish` directly. Releases go through `.github/workflows/publish.yml`, which builds from a clean checkout; publish with an explicit `version` input.

OpenClaw is a dev dependency here. Its install scripts never run, but the unit tests import a few `openclaw/plugin-sdk` runtime helper modules (for example `openclaw/plugin-sdk/error-runtime`), so `npm test` executes some OpenClaw code. The end-to-end harness runs a real gateway inside Docker:

```bash
npm run test:e2e:docker   # builds test/e2e/docker, installs the packed plugin into OpenClaw there (Docker host, ~10 min)
npm run test:e2e          # SDK-level end-to-end tests against testnet2 (network required; excludes the Docker suite)
```

## License

[MIT](LICENSE)

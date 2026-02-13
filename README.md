# Unicity wallet plugin for [OpenClaw](https://github.com/openclaw/openclaw) agents

<p align="center">
  <img src="logo.png" alt="Unicity" width="300" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@unicitylabs/openclaw-unicity"><img src="https://img.shields.io/npm/v/@unicitylabs/openclaw-unicity" alt="npm version" /></a>
  <a href="https://github.com/unicitynetwork/openclaw-unicity/blob/main/LICENSE"><img src="https://img.shields.io/github/license/unicitynetwork/openclaw-unicity" alt="license" /></a>
</p>

---

**Unicity** is an [OpenClaw](https://github.com/openclaw/openclaw) plugin that gives your AI agent a Unicity wallet identity and the ability to send and receive encrypted direct messages over Unicity's private Nostr relay network, powered by the [Unicity Sphere SDK](https://github.com/unicitylabs/sphere-sdk).

## Features

- **Wallet identity** — Auto-generates a Unicity wallet on first run (BIP-32 HD wallet with mnemonic backup)
- **Nametag minting** — Register a human-readable `@nametag` for your agent on the Unicity network
- **Encrypted DMs** — Send and receive direct messages over Unicity's private Nostr relays
- **Token management** — Send/receive tokens, check balances, view transaction history
- **Payment requests** — Request payments from other users, accept/reject/pay incoming requests
- **Faucet top-up** — Request test tokens on testnet via built-in faucet tool
- **Group chat** — Create and join NIP-29 group chats (public and private), exchange messages, manage membership
- **Agent tools** — 15 tools for messaging, wallet operations, payments, and group chat (see [Agent Tools](#agent-tools))
- **OpenClaw channel** — Full channel plugin with inbound/outbound message handling, group chat support, status reporting, and DM access control
- **Interactive setup** — `openclaw unicity setup` wizard and `openclaw onboard` integration
- **CLI commands** — `openclaw unicity init`, `status`, `send`, and `listen` for wallet management

## Quick Start

### 1. Install the plugin

```bash
openclaw plugins install @unicitylabs/openclaw-unicity
```

To update to the latest version later:

```bash
openclaw plugins update openclaw-unicity
```

### 2. Run interactive setup

```bash
openclaw unicity setup
```

This walks you through choosing a nametag, owner, and network, then writes the config for you.

Alternatively, Unicity integrates with OpenClaw's onboarding wizard:

```bash
openclaw onboard
```

### 3. Start the gateway

```bash
openclaw gateway start
```

On first start, Unicity auto-generates a wallet and mints your chosen nametag. The mnemonic backup is saved to `~/.openclaw/unicity/mnemonic.txt` (owner-only permissions).

That's it. Your agent can now send and receive encrypted DMs on the Unicity network.

## Manual Configuration

If you prefer to edit config directly, add to `~/.openclaw/openclaw.json`:

```json5
{
  "plugins": {
    "entries": {
      "openclaw-unicity": {
        "enabled": true,
        "config": {
          "nametag": "my-agent",        // Optional: register a @nametag
          "owner": "alice",             // Nametag or pubkey of the trusted human owner
          "network": "testnet",         // testnet (default) | mainnet | dev
          "additionalRelays": [         // Optional: extra Nostr relays
            "wss://custom-relay.example.com"
          ],
          "groupChat": true,             // true (default) | false | { "relays": ["wss://..."] }
          "dmPolicy": "open",            // open | pairing | allowlist | disabled
          "allowFrom": ["@trusted-user"] // Required when dmPolicy is "allowlist"
        }
      }
    }
  }
}
```

Config changes take effect on the next gateway restart — no need to reinstall the plugin.

### Owner trust model

The `owner` field identifies the human who controls the agent. When set:

- **Only the owner** can give the agent commands, change its behavior, or instruct it to perform actions via DMs.
- **Anyone else** can chat with the agent — negotiate deals, discuss topics, ask questions — but the agent will not follow operational commands from non-owner senders.
- Owner matching works by nametag or public key (case-insensitive, `@` prefix optional).

## CLI Commands

### Interactive setup

```bash
openclaw unicity setup
```

Prompts for nametag, owner, and network, then writes the config file. Run this once to get started, or re-run to change settings.

### Initialize wallet

```bash
openclaw unicity init
```

Creates a new wallet (if one doesn't exist), displays the public key and address, and mints the configured nametag. The mnemonic is automatically saved to `~/.openclaw/unicity/mnemonic.txt` (owner-only permissions).

### Check status

```bash
openclaw unicity status
```

Shows network, public key, address, and nametag.

## Agent Tools

Once the plugin is loaded, the agent has access to the following tools:

### Messaging

| Tool | Description |
|------|-------------|
| `unicity_send_message` | Send an encrypted DM to a nametag or public key |

### Wallet & Balances

| Tool | Description |
|------|-------------|
| `unicity_get_balance` | Check token balances (optionally filtered by coin) |
| `unicity_list_tokens` | List individual tokens with status and creation time |
| `unicity_get_transaction_history` | View recent transactions (sent/received) |

### Transfers & Payments

| Tool | Description |
|------|-------------|
| `unicity_send_tokens` | Transfer tokens to a recipient (requires owner instruction) |
| `unicity_request_payment` | Send a payment request to another user |
| `unicity_list_payment_requests` | View incoming/outgoing payment requests |
| `unicity_respond_payment_request` | Pay, accept, or reject a payment request |
| `unicity_top_up` | Request test tokens from the faucet (testnet only) |

### Group Chat

| Tool | Description |
|------|-------------|
| `unicity_create_public_group` | Create a public NIP-29 group chat (anyone can discover and join) |
| `unicity_create_private_group` | Create a private group and optionally DM invite codes to specified recipients |
| `unicity_join_group` | Join a group (invite code required for private groups) |
| `unicity_leave_group` | Leave a group |
| `unicity_list_groups` | List joined groups or discover available public groups |
| `unicity_send_group_message` | Send a message to a group chat |

Recipients can be specified as a `@nametag` or a 64-character hex public key.

**Examples:**

> "Send a message to @alice saying hello"
>
> "What's my balance?"
>
> "Send 100 UCT to @bob for the pizza"
>
> "Top up 50 USDU from the faucet"
>
> "Create a public group called 'Trading Floor'"
>
> "Create a private group called 'Strategy' and invite @alice and @bob"
>
> "List my groups"

### Receive messages

When the gateway is running, incoming DMs, token transfers, payment requests, and group messages are automatically routed to the agent's reply pipeline. The agent receives the event, processes it, and replies are delivered back as encrypted DMs or group messages.

### Group chat behavior

- The agent only responds in groups when **mentioned** (not to every message)
- **Financial tools are blocked** in group context — no token transfers, payment responses, or faucet top-ups from group messages
- The agent **notifies the owner via DM** when it joins, leaves, or is kicked from a group
- Private groups require an invite code; `unicity_create_private_group` can auto-DM the code to specified invitees

## Architecture

```
┌─────────────────────────────────────────────────┐
│  OpenClaw Gateway                               │
│                                                 │
│  ┌────────────┐   ┌──────────┐   ┌───────────┐  │
│  │  Unicity   │──▶│  Sphere  │──▶│  Unicity  │  │
│  │  Plugin    │◀──│  SDK     │◀──│  Relays   │  │
│  └────────────┘   └──────────┘   └───────────┘  │
│       │                                         │
│       ▼                                         │
│  ┌───────────┐                                  │
│  │  Agent    │                                  │
│  │  Pipeline │                                  │
│  └───────────┘                                  │
└─────────────────────────────────────────────────┘
```

- **Plugin service** starts the Sphere SDK, creates/loads the wallet, and connects to Unicity relays
- **Gateway adapter** listens for inbound DMs, token transfers, payment requests, and group messages, dispatching them through OpenClaw's reply pipeline
- **Outbound adapter** delivers agent replies as encrypted DMs or group messages (auto-routed by target)
- **Agent tools** (15 tools) allow the agent to send messages, manage tokens, handle payments, and participate in group chats

## Data Storage

| Path | Contents |
|------|----------|
| `~/.openclaw/unicity/` | Wallet data (keys, state) |
| `~/.openclaw/unicity/mnemonic.txt` | Mnemonic backup (mode 0600) |
| `~/.openclaw/unicity/tokens/` | Token storage |
| `~/.openclaw/unicity/trustbase.json` | Cached BFT trustbase (auto-downloaded) |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `UNICITY_TRUSTBASE_URL` | Override the BFT trustbase download URL | GitHub raw URL |
| `UNICITY_FAUCET_URL` | Override the faucet API endpoint | `https://faucet.unicity.network/api/v1/faucet/request` |

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run E2E tests (requires network, skipped in CI)
npm run test:e2e

# Lint
npm run lint
```

## Project Structure

```
unicity/
├── src/
│   ├── index.ts              # Plugin entry point & registration
│   ├── config.ts             # Configuration schema & validation
│   ├── validation.ts         # Shared validation (nametag regex, recipient format)
│   ├── sphere.ts             # Sphere SDK singleton lifecycle
│   ├── channel.ts            # Channel plugin (9 adapters + onboarding)
│   ├── assets.ts             # Asset registry & decimal conversion
│   ├── setup.ts              # Interactive setup wizard
│   ├── cli-prompter.ts       # WizardPrompter adapter for CLI
│   ├── resources/
│   │   └── unicity-ids.testnet.json  # Fungible asset metadata
│   └── tools/
│       ├── send-message.ts           # Send encrypted DMs
│       ├── get-balance.ts            # Check wallet balances
│       ├── list-tokens.ts            # List individual tokens
│       ├── get-transaction-history.ts # View transaction history
│       ├── send-tokens.ts            # Transfer tokens
│       ├── request-payment.ts        # Request payment from a user
│       ├── list-payment-requests.ts  # View payment requests
│       ├── respond-payment-request.ts # Pay/accept/reject requests
│       ├── top-up.ts                 # Testnet faucet
│       ├── create-public-group.ts    # Create public NIP-29 group
│       ├── create-private-group.ts   # Create private group + invite
│       ├── join-group.ts             # Join a group
│       ├── leave-group.ts            # Leave a group
│       ├── list-groups.ts            # List joined/available groups
│       └── send-group-message.ts     # Send message to a group
├── test/
│   ├── config.test.ts
│   ├── assets.test.ts
│   ├── sphere.test.ts
│   ├── sphere.integration.test.ts
│   ├── channel.test.ts
│   ├── index.test.ts
│   ├── tools/                # One test file per tool
│   └── e2e/
│       └── wallet.test.ts    # End-to-end wallet + DM + transfer tests
├── openclaw.plugin.json      # Plugin manifest
├── package.json
├── vitest.config.ts
├── vitest.e2e.config.ts
├── LICENSE
└── README.md
```

## License

[MIT](LICENSE)

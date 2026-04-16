# telegram-topics

A Claude Code [channel plugin](https://code.claude.com/docs/en/channels) that routes each project to its own [Telegram Forum Topic](https://telegram.org/blog/topics-in-groups-collectible-usernames#topics-in-groups).

Unlike the official Telegram plugin — which funnels every Claude Code session into a single flat chat — `telegram-topics` creates one topic per project directory. Messages in each topic reach only the Claude Code instance running in the corresponding project. Replies, reactions, attachments, and permission prompts all route back to the correct topic.

## Features

- **One topic per project.** `/Users/amir/Development/my-api` gets its own Forum Topic, separate from `/Users/amir/Development/web-app`.
- **Same capabilities as the official Telegram plugin.** Reply, react, download attachments, edit messages, permission relay, sender allowlists, pairing flow.
- **Auto-managed daemon.** A single long-lived process owns the bot and serves all local Claude Code sessions over a Unix socket. Auto-starts on first session, idles out after the last one disconnects.
- **Self-healing across updates.** When you `/plugin update`, the shim detects a stale daemon from the old cache path and restarts it.

## How it works

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Claude Code  │  │ Claude Code  │  │ Claude Code  │
│  (my-api)    │  │  (web-app)   │  │  (cli-tool)  │
│   ┌──────┐   │  │   ┌──────┐   │  │   ┌──────┐   │
│   │ Shim │   │  │   │ Shim │   │  │   │ Shim │   │
│   └──┬───┘   │  │   └──┬───┘   │  │   └──┬───┘   │
└──────┼───────┘  └──────┼───────┘  └──────┼───────┘
       │    Unix socket  │                 │
       └────────┬────────┘─────────────────┘
                │
         ┌──────┴──────┐
         │   Daemon    │────── Telegram Bot API
         │  (grammy)   │       (getUpdates long poll)
         └──────┬──────┘
                │
    ┌───────────┴───────────┐
    │  Telegram Supergroup  │
    │  (Forum Topics on)    │
    ├───────────────────────┤
    │  my-api               │
    │  web-app              │
    │  cli-tool             │
    └───────────────────────┘
```

- **Shim** (`shim.ts`): small MCP server spawned by each Claude Code session. Registers its project directory with the daemon, relays tool calls and inbound messages.
- **Daemon** (`daemon.ts`): long-lived background process. Owns the bot, polls Telegram, manages topics, routes between topics and shims.
- **State**: everything lives under `~/.claude/channels/telegram-topics/`.

## Install

This plugin isn't on Anthropic's approved allowlist, so it runs under the development flag.

```bash
# Add the marketplace (one-time)
/plugin marketplace add wilfoa/claude-plugins

# Install
/plugin install telegram-topics@wilfoa-plugins
/reload-plugins
```

## Setup

Setup has two phases:

- **One-time setup** (§1–5): create the bot, the supergroup, the chat ID, save them to Claude Code, pair your Telegram account. Do this exactly once per machine.
- **Per-project setup** (§6): `cd` into the project and run Claude Code with the channel flag. The topic is created on first connect. Optionally rename it.

### One-time setup

#### 1. Create a Telegram bot

Message [@BotFather](https://t.me/BotFather), run `/newbot`, pick a display name and a unique username ending in `bot`. Copy the token it returns.

> **Important:** if you also run the official Telegram plugin, use a **different bot token** for `telegram-topics`. Telegram allows only one `getUpdates` poller per token; two daemons on the same token will throw `409 Conflict` forever.

#### 2. Create the supergroup with Topics enabled

- New Group → add any member (you can remove them later)
- Convert to supergroup (Edit group → "Chat History for New Members: Visible")
- Turn on **Topics** (Edit group → Topics)
- Add your bot to the group
- Promote the bot to admin with **Manage Topics** + **Post Messages** permissions

#### 3. Get the supergroup chat ID

Forward any message from your supergroup to [@userinfobot](https://t.me/userinfobot). It returns the chat ID — a negative integer like `-1001234567890`.

#### 4. Save the token and chat ID

In Claude Code (any directory):

```
/telegram-topics:configure <your-bot-token>
/telegram-topics:configure chat -1001234567890
```

Both are stored under `~/.claude/channels/telegram-topics/` and shared across every project on this machine.

#### 5. Pair your Telegram account

Start a Claude Code session in any project directory:

```bash
cd ~/Development/anywhere
claude --dangerously-load-development-channels plugin:telegram-topics@wilfoa-plugins
```

This auto-creates a Forum Topic for that project. In Telegram, open the new topic and send any message (e.g. "hi"). The bot replies with a 6-character pairing code.

Back in Claude Code:

```
/telegram-topics:pair <code>
/telegram-topics:access policy allowlist
```

Your Telegram user ID is now on the allowlist and the pairing window is closed. **You only pair once per Telegram account, not per project.** Every future topic for every future project will route messages from the same user straight through.

### Per-project setup

For each new project directory:

```bash
cd ~/Development/my-project
claude --dangerously-load-development-channels plugin:telegram-topics@wilfoa-plugins
```

The flag is required because the plugin isn't on Anthropic's approved allowlist. Do **not** also pass `--channels plugin:...` — the dangerous flag replaces it for dev plugins.

On first connect, the daemon:
- Creates a Forum Topic named `my-project` (the directory basename)
- Stores the mapping in `~/.claude/channels/telegram-topics/topics.json`

That's it. Send a message in the new topic and Claude Code in that directory picks it up.

#### Custom topic name

The default topic name is `basename(cwd)`. To override it, `cd` into the project **before** its first session and run:

```
/telegram-topics:configure topic "General Dev"
```

This writes to `~/.claude/channels/telegram-topics/labels.json`. On the next Claude Code session with `--channels`, the daemon creates the topic with that name (or renames an existing one via `editForumTopic`).

## Plugin commands

| Command | Purpose |
|---------|---------|
| `/telegram-topics:configure` (no args) | Show status: token set, chat ID, topics, labels, daemon status |
| `/telegram-topics:configure <token>` | Save the bot token to `.env` |
| `/telegram-topics:configure clear` | Remove the stored token |
| `/telegram-topics:configure chat <id>` | Set the supergroup chat ID |
| `/telegram-topics:configure topic <name>` | Set a custom topic name for the current project |
| `/telegram-topics:help` | Show command list and the first-run checklist |
| `/telegram-topics:pair <code>` | Approve a pairing code (shortcut) |
| `/telegram-topics:access pair <code>` | Same, via the access skill |
| `/telegram-topics:access deny <code>` | Reject a pending pairing code |
| `/telegram-topics:access allow <senderId>` | Manually add a Telegram user to the allowlist |
| `/telegram-topics:access remove <senderId>` | Remove a user from the allowlist |
| `/telegram-topics:access policy <mode>` | `pairing`, `allowlist`, or `disabled` |
| `/telegram-topics:project list` | List all registered projects and their topics |
| `/telegram-topics:daemon status` | Show daemon PID, uptime, and plugin version |
| `/telegram-topics:daemon stop` | Kill the daemon |
| `/telegram-topics:daemon restart` | Kill the daemon; next session auto-spawns a fresh one |
| `/telegram-topics:daemon log` | Tail the daemon log for debugging |

## State files

All under `~/.claude/channels/telegram-topics/`:

| File | Written by | Contents |
|------|-----------|----------|
| `.env` | configure skill | `CLAUDE_TELEGRAM_TOPICS_BOT_TOKEN=<token>` |
| `access.json` | access skill + daemon | `chatId`, `dmPolicy`, `allowFrom[]`, `pending{}` |
| `topics.json` | daemon only | `{ [projectPath]: { topicId, topicName } }` — actual Telegram state |
| `labels.json` | configure skill only | `{ [projectPath]: label }` — user's preferred topic names |
| `daemon.pid` | daemon | PID of the running daemon |
| `daemon.sock` | daemon | Unix socket |
| `daemon.log` | daemon | stdout + stderr |
| `approved/` | access skill | Temporary pairing confirmation files |
| `inbox/` | daemon | Downloaded attachments |

**Why two files for topics?** `topics.json` tracks what Telegram has (daemon-owned). `labels.json` tracks what the user wants (skill-owned). Keeping them separate means the skill can request a rename without making the daemon think the rename already happened.

## Inbound message format

What Claude sees when you send a message in a topic:

```xml
<channel source="telegram-topics"
  chat_id="-1001234567890"
  message_id="42"
  user="alice"
  user_id="12345"
  ts="2026-04-16T10:30:00Z">
  fix the auth bug
</channel>
```

For photo or document attachments, additional meta fields appear: `image_path`, `attachment_file_id`, `attachment_kind`, `attachment_size`, `attachment_mime`, `attachment_name`.

## Permission relay

When Claude wants to use a tool that needs approval (Bash, Write, Edit), Claude Code normally shows a local terminal dialog. With permission relay, the same prompt is also posted to your topic with inline buttons:

```
🔐 Permission: Bash
[ See more ]  [ ✅ Allow ]  [ ❌ Deny ]
```

Tap "See more" for the full description and input preview. Tap Allow/Deny to answer remotely. You can also reply with plain text: `yes abcde` or `no abcde` (where `abcde` is the five-letter request ID).

The local terminal dialog stays open; whichever answer arrives first wins.

## Troubleshooting

**"not on the approved channels allowlist" at startup.**
You forgot `--dangerously-load-development-channels`. Add the flag, and remove any redundant `--channels plugin:telegram-topics@...`.

**Messages reach the topic but Claude doesn't see them.**
Check `/telegram-topics:daemon log`:
- `routing topic=N → NO SHIM` → no Claude Code session is connected to this topic; restart Claude Code in the project directory
- `gate result for X = drop` → your user ID isn't in the allowlist; run `/telegram-topics:access pair <code>` or `/telegram-topics:access allow <id>`
- `drop — chat X != configured Y` → your `chatId` in `access.json` doesn't match the supergroup

**Repeated `409 Conflict, retrying` in the log.**
Another process is polling the same bot token. Usually a stale daemon (fixed automatically on the next session since the shim detects stale cache paths and kills them). If it persists:
```
/telegram-topics:daemon stop
```
Also check for the official Telegram plugin using the same token (it shouldn't — each plugin needs its own bot).

**Topic name doesn't match what I set.**
The rename happens when a shim reconnects. Exit Claude Code and restart the session — the daemon will call `editForumTopic` to apply the new name.

**Daemon doesn't start / socket never appears.**
Check `~/.claude/channels/telegram-topics/daemon.log` for errors. Common causes: missing token, invalid chat ID (must be a negative supergroup ID), or the bot isn't actually in the group.

## Running alongside the official Telegram plugin

You can — but **use a different bot token for each**. Telegram allows only one `getUpdates` consumer per token. Running both plugins against the same bot will cause 409 Conflict on whichever started second.

## Development

Tests (protocol parser, state management, gate logic):

```bash
bun test
```

The plugin has no integration tests — exercise it end-to-end against a real bot and supergroup.

## Repository

- Plugin source: https://github.com/wilfoa/claude-telegram-topics
- Marketplace: https://github.com/wilfoa/claude-plugins

## License

Apache-2.0

---
name: configure
description: Set up the Telegram Topics channel — save the bot token, configure the supergroup chat ID, set topic names, or get the launch recipe for a secondary same-project instance. Use when the user pastes a bot token, asks to configure Telegram Topics, wants to check channel status, or needs to run a second Claude session in the same directory with its own topic.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
  - Bash(kill *)
---

# /telegram-topics:configure — Channel Setup

Manages bot token, supergroup chat ID, and per-project topic names.
State lives in `~/.claude/channels/telegram-topics/`.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status

Read state files and show a complete picture:

1. **Token** — check `~/.claude/channels/telegram-topics/.env` for
   `CLAUDE_TELEGRAM_TOPICS_BOT_TOKEN`. Show set/not-set; if set, show first
   10 chars masked (`123456789:...`).

2. **Chat ID** — read `~/.claude/channels/telegram-topics/access.json` for
   `chatId`. Show set/not-set.

3. **Topics** — read `~/.claude/channels/telegram-topics/topics.json`. List
   project paths and their topic names (these are what the daemon has actually
   created in Telegram).

4. **Labels** — read `~/.claude/channels/telegram-topics/labels.json`. List
   any user-configured label overrides. A label set here but not yet reflected
   in `topics.json` means the rename is pending a session restart.

5. **Access** — read `access.json`. Show DM policy, allowed senders count.

6. **Daemon** — check `~/.claude/channels/telegram-topics/daemon.pid`. If
   present, check if process is alive via `kill -0 <pid>`.

7. **What next** — guide based on state. Pairing is required: default
   `dmPolicy` is `pairing`, and the gate drops every message from a sender
   who isn't in `allowFrom`. Until the user pairs, nothing reaches Claude.
   - No token → "Run `/telegram-topics:configure <token>` with the token from BotFather."
   - No chat ID → "Run `/telegram-topics:configure chat <id>` with your supergroup's chat ID (negative number)."
   - Token + chat ID set, `allowFrom` empty → full remaining flow:
     1. Start Claude Code in a project with `--dangerously-load-development-channels plugin:telegram-topics@wilfoa-plugins`.
     2. In Telegram, send any message in the new topic. The bot replies with a 6-character pairing code.
     3. Run `/telegram-topics:pair <code>` to add your Telegram user to the allowlist.
     4. Run `/telegram-topics:access policy allowlist` to close the pairing window.
   - Paired (`allowFrom` non-empty) but `dmPolicy` still `pairing` → "Lock down with `/telegram-topics:access policy allowlist`."
   - Fully configured and locked down → "You're set. Start a session in any project with `--dangerously-load-development-channels plugin:telegram-topics@wilfoa-plugins`."

### `<token>` — save bot token

If `$ARGUMENTS` looks like a bot token (digits, colon, alphanumeric string):

1. `mkdir -p ~/.claude/channels/telegram-topics`
2. Read existing `.env` if present; update/add the `CLAUDE_TELEGRAM_TOPICS_BOT_TOKEN=` line.
3. Write back. `chmod 600 ~/.claude/channels/telegram-topics/.env`.
4. Confirm and show status.
5. Note: "Token changes need a session restart or `/reload-plugins`."

### `clear` — remove token

Delete the `CLAUDE_TELEGRAM_TOPICS_BOT_TOKEN=` line from `.env`.

### `chat <chat_id>` — set supergroup chat ID

1. Read `~/.claude/channels/telegram-topics/access.json` (create default if missing).
2. If `<chat_id>` is `auto`, tell the user:
   "Send any message in the supergroup. The daemon will detect the chat ID on next startup.
   For now, you'll need to find the chat ID manually. Send a message in the group,
   then use @userinfobot or check the bot's getUpdates for the chat.id value."
3. If `<chat_id>` is a number (possibly negative), set `chatId` to that string in access.json.
4. Write back.
5. Note: "Chat ID changes need a daemon restart."

### `instance <name>` — run a second Claude Code session in the same project, with its own topic

The plugin keys topics by `projectPath`. Two Claude Code sessions in the same directory therefore compete for the same topic, and the newer one evicts the older (see README "Two-session same-project"). To run a genuine second instance with its own independent topic, launch Claude Code with `TELEGRAM_TOPICS_INSTANCE` set.

This dispatch does **not** persist anything — it only prints the launch recipe, since the env var is a per-shell concept. If `$ARGUMENTS` is `instance` (no name), list currently-registered instance topics for the cwd and reprint the recipe.

1. Read `$ARGUMENTS`. Parse off the leading `instance ` prefix; treat the remainder as `<name>`. If the remainder is empty:
   - Read `topics.json` and list entries whose key starts with `${cwd}#`. Show the instance names and topic IDs.
   - Print the launch recipe (step 3 below) with `<name>` as a placeholder.
2. If `<name>` is given, validate: lowercase alphanumerics + dashes/underscores, 1–20 chars. Reject anything else — it becomes part of the topic name that Telegram has to accept.
3. Print, verbatim:
   > Start the secondary session from a fresh terminal in this directory:
   > ```
   > TELEGRAM_TOPICS_INSTANCE=<name> claude --dangerously-load-development-channels plugin:telegram-topics@wilfoa-plugins
   > ```
   > On first connect it will create a new topic named `<basename-of-cwd> (<name>)` (or `<label-from-configure-topic> (<name>)` if you've set a custom label for this project). Your other session's topic is untouched.
   >
   > To remove the instance topic later, run `/telegram-topics:project remove <basename-of-cwd> (<name>)` (or use the full `<cwd>#<name>` path).

### `topic <name>` — set topic name for current project

The user's preferred label lives in a **separate `labels.json` file** (not `topics.json`).
This keeps it independent of the daemon's tracked state. If the skill wrote to `topics.json`
directly, the daemon would see the name already matches and skip the `editForumTopic` call,
so the actual Telegram topic would never rename.

1. Read `~/.claude/channels/telegram-topics/labels.json` (create `{}` if missing).
2. Get the current working directory path (this is the key).
3. Set `labels[cwd] = "<name>"`.
4. Write back with `chmod 600`.
5. Confirm: "Topic label for this project set to '<name>'. It will be created or renamed on next session restart."

Note: the rename happens when the shim next connects to the daemon (i.e. next Claude Code
session with `--channels`). If Claude Code is currently running, exit and restart for the
change to take effect.

---

## Implementation notes

- The channels dir might not exist yet. Missing file = not configured, not an error.
- Token format: digits + colon + alphanumeric. Don't reject tokens that look unusual.
- Chat IDs for supergroups are negative numbers (e.g., `-1001234567890`). Store as string.
- The server reads `.env` once at boot. Token changes need a restart. Say so after saving.

---
name: configure
description: Set up the Telegram Topics channel — save the bot token, configure the supergroup chat ID, and set topic names. Use when the user pastes a bot token, asks to configure Telegram Topics, or wants to check channel status.
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
   project paths and their topic names.

4. **Access** — read `access.json`. Show DM policy, allowed senders count.

5. **Daemon** — check `~/.claude/channels/telegram-topics/daemon.pid`. If
   present, check if process is alive via `kill -0 <pid>`.

6. **What next** — guide based on state:
   - No token → "Run `/telegram-topics:configure <token>` with the token from BotFather."
   - No chat ID → "Run `/telegram-topics:configure chat auto` after adding the bot to your supergroup."
   - Ready → "Start with `claude --channels plugin:telegram-topics@...`"

Push toward lockdown after pairing is complete.

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

### `topic <name>` — set topic name for current project

1. Read `~/.claude/channels/telegram-topics/topics.json` (create `{}` if missing).
2. Get current working directory path.
3. Set or update the entry for cwd. If existing, preserve `topicId` and only update `topicName`.
   If no entry exists, set `topicId` to 0 (will be created on next connect).
4. Write back.
5. Confirm: "Topic name for this project set to '<name>'. It will be created/renamed on next connect."

---

## Implementation notes

- The channels dir might not exist yet. Missing file = not configured, not an error.
- Token format: digits + colon + alphanumeric. Don't reject tokens that look unusual.
- Chat IDs for supergroups are negative numbers (e.g., `-1001234567890`). Store as string.
- The server reads `.env` once at boot. Token changes need a restart. Say so after saving.

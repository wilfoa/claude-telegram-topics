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
  - Bash(bun *)
  - mcp__telegram-topics__rename_topic
  - mcp__plugin_telegram-topics_telegram-topics__rename_topic
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

### `instance [<name>]` — list or plan a secondary session in the same project

Auto-suffix is the default behavior: the first bare-cwd session gets the primary topic, the second is auto-assigned `${cwd}#2`, etc. This dispatch is **only** useful when you want a stable, human-chosen name (`TELEGRAM_TOPICS_INSTANCE=exp`) instead of an integer. It does not persist anything — the env var is a per-shell concept.

1. Read `$ARGUMENTS`. Parse off the leading `instance ` prefix; treat the remainder as `<name>`.
2. If the remainder is empty:
   - Read `topics.json` and list entries whose key starts with `${cwd}#`. Group them:
     - **Named** (suffix does not match `^[1-9]\d*$`): show suffix and topicId.
     - **Integer (auto-suffix)** (suffix matches): show as `#N` with topicId.
   - Mention which of these are currently held by an active shim if that info is easily derivable, otherwise just list them from `topics.json`.
   - Then print the launch recipe (step 4) with `<name>` as a placeholder, noting the env var is only needed for *named* instances.
3. If `<name>` is given, validate: lowercase alphanumerics + dashes/underscores, 1–20 chars, and must NOT match `^[1-9]\d*$` (pure integers are reserved for auto-suffix). Reject anything else.
4. Print, verbatim:
   > If you just need a second session, just launch Claude Code normally in the same directory — you'll automatically get a `(#2)` topic. This command is for when you want a *stable named* instance instead:
   >
   > ```
   > TELEGRAM_TOPICS_INSTANCE=<name> claude --dangerously-load-development-channels plugin:telegram-topics@wilfoa-plugins
   > ```
   >
   > Registers as `<baseLabel> (<name>)` under `<cwd>#<name>`. Named instances don't consume integer slots — your other sessions keep their auto-assigned numbers.
   >
   > To remove the named topic later: `/telegram-topics:project remove <cwd>#<name>`.

### `topic "<name>" [--instance <inst>]` — rename the topic (live, no restart needed)

The rename goes through the **shim's `rename_topic` MCP tool**, which targets this
session's OWN registered topic. That matters for auto-suffixed sessions: if the
daemon auto-suffixed this shim to `#2`, a rename with no `--instance` must target
`${cwd}#2` — not the primary `${cwd}` topic that a different session holds. Using
the MCP tool puts the shim (which knows its effective projectPath) in charge of
that decision, instead of the skill guessing from `${cwd}`. The shim also
persists the preferred label to `labels.json` for future sessions.

Parse `$ARGUMENTS`:
- The new name is a quoted or bare string (e.g. `topic "My Project"` or `topic proj`).
- Optional flag `--instance <inst>`. Values:
  - `1` → the bare cwd (primary slot).
  - `2`, `3`, … → an integer auto-suffix slot `${cwd}#<n>`.
  - Any other string (`foo`, `exp`, …) → a named instance `${cwd}#<name>`.
  - Omit → the shim renames its own topic (whatever slot it was registered on).

Steps:

1. Validate the name: non-empty, ≤ 128 chars (Telegram's topic name cap). Reject if it contains control characters. (The MCP tool also validates, but giving the user a helpful error before a tool call is nicer.)
2. Call the shim's `rename_topic` MCP tool (tool name looks like `mcp__telegram-topics__rename_topic` — use whichever variant Claude Code surfaces):
   - `name`: the new name (string).
   - `instance`: the string passed to `--instance`, or omit the arg if no flag was given.
3. Report the tool's result text to the user. On success it ends with `label also saved to labels.json`; on failure (Telegram error) the label is saved anyway so the preference applies on the next session.

Notes:
- **No manual `labels.json` write from the skill.** The MCP tool handles persistence. Writing `labels.json` from the skill separately would race with the shim and create duplicate entries.
- If the daemon isn't yet connected (e.g. the shim just launched and the socket connect is still in flight), the tool returns an error — retry after a moment.
- To rename a topic for a project directory you are *not* currently running Claude Code in, use the standalone helper directly:
  ```bash
  bun "${CLAUDE_PLUGIN_ROOT}/rename-topic.ts" "/abs/path/to/project" "New Name"
  ```
  This path is strictly for admin/offline use — the MCP tool is the right default.

---

## Implementation notes

- The channels dir might not exist yet. Missing file = not configured, not an error.
- Token format: digits + colon + alphanumeric. Don't reject tokens that look unusual.
- Chat IDs for supergroups are negative numbers (e.g., `-1001234567890`). Store as string.
- The server reads `.env` once at boot. Token changes need a restart. Say so after saving.

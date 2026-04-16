#!/usr/bin/env bun
/**
 * Daemon for telegram-topics channel plugin.
 *
 * Long-lived process that:
 *   - Runs a grammy bot polling Telegram for messages in Forum Topics
 *   - Listens on a Unix socket for shim connections (one per Claude Code session)
 *   - Routes inbound Telegram messages to the correct shim by topic ID
 *   - Executes tool calls (reply, react, download, edit) on behalf of shims
 *   - Relays permission requests/verdicts between shims and Telegram
 *   - Manages Forum Topic lifecycle (create/reuse per project)
 *
 * State lives under ~/.claude/channels/telegram-topics/ (configurable via
 * TELEGRAM_TOPICS_STATE_DIR env var).
 */

import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, realpathSync, existsSync, unlinkSync } from 'fs'
import { join, extname, sep } from 'path'

import {
  type ShimMessage,
  type DaemonMessage,
  type RegisteredMessage,
  type InboundMessage,
  type ToolResultMessage,
  type PermissionVerdictForwardMessage,
  type ErrorMessage,
  parseMessages,
  serialize,
} from './protocol'

import {
  DEFAULT_STATE_DIR,
  loadAccess,
  saveAccess,
  loadTopics,
  saveTopics,
  loadToken,
  writePid,
  clearPid,
  type Access,
  type TopicEntry,
  type TopicMap,
} from './state'

import { gate, pruneExpired, PERMISSION_REPLY_RE } from './gate'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.TELEGRAM_TOPICS_STATE_DIR ?? DEFAULT_STATE_DIR
const SOCKET_PATH = join(STATE_DIR, 'daemon.sock')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const INBOX_DIR = join(STATE_DIR, 'inbox')

const TOKEN = loadToken(STATE_DIR) ?? process.env.CLAUDE_TELEGRAM_TOPICS_BOT_TOKEN

if (!TOKEN) {
  process.stderr.write(
    `telegram-topics daemon: bot token required\n` +
    `  set CLAUDE_TELEGRAM_TOPICS_BOT_TOKEN in ${join(STATE_DIR, '.env')}\n` +
    `  format: CLAUDE_TELEGRAM_TOPICS_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

const access = loadAccess(STATE_DIR)
if (!access.chatId) {
  process.stderr.write(
    `telegram-topics daemon: chatId not set in ${join(STATE_DIR, 'access.json')}\n` +
    `  Set it to your supergroup (forum) chat ID.\n` +
    `  Use /telegram-topics:configure to set up.\n`,
  )
  process.exit(1)
}
const CHAT_ID = access.chatId

// ---------------------------------------------------------------------------
// Safety nets
// ---------------------------------------------------------------------------

process.on('unhandledRejection', err => {
  process.stderr.write(`telegram-topics daemon: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`telegram-topics daemon: uncaught exception: ${err}\n`)
})

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
writePid(process.pid, STATE_DIR)

let shuttingDown = false
let botUsername = ''

/** Map from topicId to the shim socket that owns it. */
const shimsByTopic = new Map<number, ShimSocket>()

/** Map from topicId to projectPath (reverse lookup). */
const topicToProject = new Map<number, string>()

/** Pending permission details for "See more" expansion, keyed by requestId. */
const pendingPermissions = new Map<string, { toolName: string; description: string; inputPreview: string }>()

/** Rate limit for "no active session" replies per topic (once per 5 min). */
const noSessionReplyTimes = new Map<number, number>()
const NO_SESSION_COOLDOWN_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Shim socket type
// ---------------------------------------------------------------------------

type ShimSocket = {
  socket: import('bun').Socket<{ buffer: string }>
  topicId: number | null
  projectPath: string | null
}

const connectedShims = new Set<ShimSocket>()

// ---------------------------------------------------------------------------
// Idle shutdown
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = 60_000
let idleTimer: ReturnType<typeof setTimeout> | null = null

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function startIdleTimer(): void {
  resetIdleTimer()
  idleTimer = setTimeout(() => {
    if (connectedShims.size === 0) {
      process.stderr.write('telegram-topics daemon: idle timeout, shutting down\n')
      shutdown()
    }
  }, IDLE_TIMEOUT_MS)
  idleTimer.unref()
}

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------

const bot = new Bot(TOKEN)

// ---------------------------------------------------------------------------
// Text chunking (Telegram 4096 char limit)
// ---------------------------------------------------------------------------

const MAX_CHUNK = 4096

function chunkText(text: string, limit = MAX_CHUNK): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    // Prefer paragraph boundary, then line, then space, then hard cut
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ---------------------------------------------------------------------------
// File type helpers
// ---------------------------------------------------------------------------

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

function assertSendable(f: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch {
    return // statSync will fail properly; or STATE_DIR absent -> nothing to leak
  }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

// Sanitize filenames from Telegram
function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

// ---------------------------------------------------------------------------
// Topic CRUD
// ---------------------------------------------------------------------------

async function ensureTopic(projectPath: string, topicLabel: string): Promise<TopicEntry> {
  const topics = loadTopics(STATE_DIR)

  // Reuse existing topic for this project
  if (topics[projectPath]) {
    const entry = topics[projectPath]
    // Rename if label changed
    if (entry.topicName !== topicLabel) {
      try {
        await bot.api.raw.editForumTopic({
          chat_id: CHAT_ID,
          message_thread_id: entry.topicId,
          name: topicLabel,
        })
        entry.topicName = topicLabel
        saveTopics(topics, STATE_DIR)
      } catch (err) {
        process.stderr.write(`telegram-topics daemon: failed to rename topic: ${err}\n`)
      }
    }
    return entry
  }

  // Create new forum topic
  const result = await bot.api.raw.createForumTopic({
    chat_id: CHAT_ID,
    name: topicLabel,
  })

  const entry: TopicEntry = {
    topicId: result.message_thread_id,
    topicName: topicLabel,
  }
  topics[projectPath] = entry
  saveTopics(topics, STATE_DIR)
  return entry
}

// ---------------------------------------------------------------------------
// Send helpers (used by tool_call handler)
// ---------------------------------------------------------------------------

function sendToShim(shim: ShimSocket, msg: DaemonMessage): void {
  try {
    shim.socket.write(serialize(msg))
  } catch (err) {
    process.stderr.write(`telegram-topics daemon: failed to write to shim: ${err}\n`)
  }
}

function findShimByTopic(topicId: number): ShimSocket | undefined {
  return shimsByTopic.get(topicId)
}

// ---------------------------------------------------------------------------
// Shim message handler
// ---------------------------------------------------------------------------

async function handleShimMessage(shim: ShimSocket, msg: ShimMessage): Promise<void> {
  switch (msg.type) {
    case 'register': {
      try {
        const entry = await ensureTopic(msg.projectPath, msg.topicLabel)
        shim.topicId = entry.topicId
        shim.projectPath = msg.projectPath

        // Evict previous shim for this topic if any
        const prev = shimsByTopic.get(entry.topicId)
        if (prev && prev !== shim) {
          sendToShim(prev, { type: 'error', message: 'replaced by new session' })
        }

        shimsByTopic.set(entry.topicId, shim)
        topicToProject.set(entry.topicId, msg.projectPath)
        resetIdleTimer()

        const registered: RegisteredMessage = {
          type: 'registered',
          topicId: entry.topicId,
          topicName: entry.topicName,
        }
        sendToShim(shim, registered)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        sendToShim(shim, { type: 'error', message: `register failed: ${errMsg}` })
      }
      break
    }

    case 'tool_call': {
      try {
        const result = await executeToolCall(shim, msg.tool, msg.args)
        const toolResult: ToolResultMessage = {
          type: 'tool_result',
          callId: msg.callId,
          result,
        }
        sendToShim(shim, toolResult)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const toolResult: ToolResultMessage = {
          type: 'tool_result',
          callId: msg.callId,
          result: { content: [{ type: 'text', text: `${msg.tool} failed: ${errMsg}` }], isError: true },
        }
        sendToShim(shim, toolResult)
      }
      break
    }

    case 'forward_permission_request': {
      if (shim.topicId == null) {
        sendToShim(shim, { type: 'error', message: 'not registered, cannot forward permission request' })
        break
      }
      pendingPermissions.set(msg.requestId, {
        toolName: msg.toolName,
        description: msg.description,
        inputPreview: msg.inputPreview,
      })
      const text = `\u{1F510} Permission: ${msg.toolName}`
      const keyboard = new InlineKeyboard()
        .text('See more', `perm:more:${msg.requestId}`)
        .text('\u2705 Allow', `perm:allow:${msg.requestId}`)
        .text('\u274C Deny', `perm:deny:${msg.requestId}`)
      try {
        await bot.api.sendMessage(CHAT_ID, text, {
          message_thread_id: shim.topicId,
          reply_markup: keyboard,
        })
      } catch (err) {
        process.stderr.write(`telegram-topics daemon: failed to send permission request: ${err}\n`)
      }
      break
    }

    case 'permission_verdict': {
      // This is a verdict from the shim back. In our architecture the shim doesn't
      // produce verdicts — the daemon does. Ignore.
      break
    }

    default: {
      process.stderr.write(`telegram-topics daemon: unknown shim message type: ${(msg as { type: string }).type}\n`)
    }
  }
}

// ---------------------------------------------------------------------------
// Tool call execution
// ---------------------------------------------------------------------------

async function executeToolCall(
  shim: ShimSocket,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  if (shim.topicId == null) {
    return { content: [{ type: 'text', text: 'not registered — call register first' }], isError: true }
  }
  const topicId = shim.topicId

  switch (tool) {
    case 'reply': {
      const text = args.text as string
      const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
      const files = (args.files as string[] | undefined) ?? []
      const format = (args.format as string | undefined) ?? 'text'
      const parseMode = format === 'markdownv2' ? 'MarkdownV2' as const : undefined

      for (const f of files) {
        assertSendable(f)
        const st = statSync(f)
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
        }
      }

      const chunks = chunkText(text)
      const sentIds: number[] = []

      try {
        for (let i = 0; i < chunks.length; i++) {
          const shouldReplyTo = reply_to != null && i === 0
          const sent = await bot.api.sendMessage(CHAT_ID, chunks[i], {
            message_thread_id: topicId,
            ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
            ...(parseMode ? { parse_mode: parseMode } : {}),
          })
          sentIds.push(sent.message_id)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
      }

      // Files as separate messages
      for (const f of files) {
        const ext = extname(f).toLowerCase()
        const input = new InputFile(f)
        const opts = {
          message_thread_id: topicId,
          ...(reply_to != null ? { reply_parameters: { message_id: reply_to } } : {}),
        }
        if (PHOTO_EXTS.has(ext)) {
          const sent = await bot.api.sendPhoto(CHAT_ID, input, opts)
          sentIds.push(sent.message_id)
        } else {
          const sent = await bot.api.sendDocument(CHAT_ID, input, opts)
          sentIds.push(sent.message_id)
        }
      }

      const result = sentIds.length === 1
        ? `sent (id: ${sentIds[0]})`
        : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
      return { content: [{ type: 'text', text: result }] }
    }

    case 'react': {
      await bot.api.setMessageReaction(CHAT_ID, Number(args.message_id), [
        { type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] },
      ])
      return { content: [{ type: 'text', text: 'reacted' }] }
    }

    case 'download_attachment': {
      const file_id = args.file_id as string
      const file = await bot.api.getFile(file_id)
      if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
      const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
      const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return { content: [{ type: 'text', text: path }] }
    }

    case 'edit_message': {
      const editFormat = (args.format as string | undefined) ?? 'text'
      const editParseMode = editFormat === 'markdownv2' ? 'MarkdownV2' as const : undefined
      const edited = await bot.api.editMessageText(
        CHAT_ID,
        Number(args.message_id),
        args.text as string,
        ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
      )
      const id = typeof edited === 'object' ? edited.message_id : args.message_id
      return { content: [{ type: 'text', text: `edited (id: ${id})` }] }
    }

    default:
      return { content: [{ type: 'text', text: `unknown tool: ${tool}` }], isError: true }
  }
}

// ---------------------------------------------------------------------------
// Inbound Telegram message routing
// ---------------------------------------------------------------------------

async function handleInbound(ctx: Context): Promise<void> {
  const msg = ctx.message
  if (!msg) return

  const threadId = msg.message_thread_id
  const from = ctx.from
  if (!from) return

  const senderId = String(from.id)
  const chatId = String(ctx.chat!.id)
  const chatType = ctx.chat?.type

  // --- DM handling (commands, pairing) ---
  if (chatType === 'private') {
    await handleDM(ctx)
    return
  }

  // --- Group/supergroup handling ---
  // Only handle messages in our configured chat
  if (chatId !== CHAT_ID) return

  // Only handle messages in topics (with message_thread_id)
  if (threadId == null) return

  // Gate the sender
  const currentAccess = loadAccess(STATE_DIR)
  const pruned = pruneExpired(currentAccess)
  if (pruned) saveAccess(currentAccess, STATE_DIR)

  const gateResult = gate(senderId, currentAccess)

  if (gateResult.action === 'drop') return

  if (gateResult.action === 'pair') {
    saveAccess(currentAccess, STATE_DIR)
    const lead = gateResult.isResend ? 'Still pending' : 'Pairing required'
    await bot.api.sendMessage(CHAT_ID, `${lead} \u2014 run in Claude Code:\n\n/telegram-topics:access pair ${gateResult.code}`, {
      message_thread_id: threadId,
    }).catch(() => {})
    return
  }

  // Sender is allowed — route to shim
  const shim = findShimByTopic(threadId)
  if (!shim) {
    // Rate-limited "no active session" reply
    const now = Date.now()
    const lastReply = noSessionReplyTimes.get(threadId) ?? 0
    if (now - lastReply > NO_SESSION_COOLDOWN_MS) {
      noSessionReplyTimes.set(threadId, now)
      await bot.api.sendMessage(CHAT_ID, 'No active Claude Code session for this topic.', {
        message_thread_id: threadId,
      }).catch(() => {})
    }
    return
  }

  const text = msg.text ?? msg.caption ?? ''

  // Check for permission verdict FIRST
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch) {
    const requestId = permMatch[2]!.toLowerCase()
    const behavior = permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' as const : 'deny' as const
    const verdict: PermissionVerdictForwardMessage = {
      type: 'permission_verdict_forward',
      requestId,
      behavior,
    }
    sendToShim(shim, verdict)
    // React with checkmark/cross
    const emoji = behavior === 'allow' ? '\u2705' : '\u274C'
    void bot.api.setMessageReaction(CHAT_ID, msg.message_id, [
      { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
    ]).catch(() => {})
    return
  }

  // Build meta
  const meta: Record<string, string> = {
    chat_id: chatId,
    message_id: String(msg.message_id),
    user: from.username ?? String(from.id),
    user_id: String(from.id),
    ts: new Date(msg.date * 1000).toISOString(),
  }

  // Handle photo: eager download to inbox
  if (msg.photo && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1]
    try {
      const file = await bot.api.getFile(best.file_id)
      if (file.file_path) {
        const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
        const res = await fetch(url)
        const buf = Buffer.from(await res.arrayBuffer())
        const ext = file.file_path.split('.').pop() ?? 'jpg'
        const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
        mkdirSync(INBOX_DIR, { recursive: true })
        writeFileSync(path, buf)
        meta.image_path = path
      }
    } catch (err) {
      process.stderr.write(`telegram-topics daemon: photo download failed: ${err}\n`)
    }
  }

  // Handle document attachment metadata
  if (msg.document) {
    const doc = msg.document
    meta.attachment_kind = 'document'
    meta.attachment_file_id = doc.file_id
    if (doc.file_size != null) meta.attachment_size = String(doc.file_size)
    if (doc.mime_type) meta.attachment_mime = doc.mime_type
    const name = safeName(doc.file_name)
    if (name) meta.attachment_name = name
  }

  // Send typing indicator
  void bot.api.sendChatAction(CHAT_ID, 'typing', { message_thread_id: threadId }).catch(() => {})

  const inbound: InboundMessage = {
    type: 'inbound',
    content: text || (msg.photo ? '(photo)' : msg.document ? `(document: ${safeName(msg.document.file_name) ?? 'file'})` : '(message)'),
    meta,
  }
  sendToShim(shim, inbound)
}

// ---------------------------------------------------------------------------
// DM handling (commands, pairing)
// ---------------------------------------------------------------------------

async function handleDM(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? ''

  // /start command
  if (text.startsWith('/start')) {
    const currentAccess = loadAccess(STATE_DIR)
    if (currentAccess.dmPolicy === 'disabled') {
      await ctx.reply("This bot isn't accepting new connections.")
      return
    }
    await ctx.reply(
      `This bot bridges Telegram to Claude Code sessions via Forum Topics.\n\n` +
      `To pair:\n` +
      `1. DM me anything \u2014 you'll get a 6-char code\n` +
      `2. In Claude Code: /telegram-topics:access pair <code>\n\n` +
      `After that, your messages in topics reach the session.`,
    )
    return
  }

  // /status command
  if (text.startsWith('/status')) {
    const from = ctx.from
    if (!from) return
    const senderId = String(from.id)
    const currentAccess = loadAccess(STATE_DIR)

    if (currentAccess.allowFrom.includes(senderId)) {
      const name = from.username ? `@${from.username}` : senderId
      await ctx.reply(`Paired as ${name}.`)
      return
    }

    for (const [code, p] of Object.entries(currentAccess.pending)) {
      if (p.senderId === senderId) {
        await ctx.reply(`Pending pairing \u2014 run in Claude Code:\n\n/telegram-topics:access pair ${code}`)
        return
      }
    }

    await ctx.reply('Not paired. Send me a message to get a pairing code.')
    return
  }

  // /help command
  if (text.startsWith('/help')) {
    await ctx.reply(
      `Messages you send in forum topics route to a paired Claude Code session. ` +
      `Text and photos are forwarded; replies and reactions come back.\n\n` +
      `/start \u2014 pairing instructions\n` +
      `/status \u2014 check your pairing state`,
    )
    return
  }

  // Non-command DM — gate for pairing
  const from = ctx.from
  if (!from) return
  const senderId = String(from.id)

  const currentAccess = loadAccess(STATE_DIR)
  const pruned = pruneExpired(currentAccess)
  if (pruned) saveAccess(currentAccess, STATE_DIR)

  const gateResult = gate(senderId, currentAccess)

  if (gateResult.action === 'drop') return

  if (gateResult.action === 'pair') {
    saveAccess(currentAccess, STATE_DIR)
    const lead = gateResult.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`${lead} \u2014 run in Claude Code:\n\n/telegram-topics:access pair ${gateResult.code}`)
    return
  }

  // Allowed sender in DM — but we don't route DMs, only topic messages.
  await ctx.reply('Messages in DMs are not routed. Send your message in the appropriate forum topic.')
}

// ---------------------------------------------------------------------------
// Callback query handler (permission buttons)
// ---------------------------------------------------------------------------

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data
  const m = /^perm:(allow|deny|more):(.+)$/.exec(data)
  if (!m) {
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  const currentAccess = loadAccess(STATE_DIR)
  const senderId = String(ctx.from.id)
  if (!currentAccess.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const [, behavior, requestId] = m

  if (behavior === 'more') {
    const details = pendingPermissions.get(requestId)
    if (!details) {
      await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
      return
    }
    const { toolName, description, inputPreview } = details
    let prettyInput: string
    try {
      prettyInput = JSON.stringify(JSON.parse(inputPreview), null, 2)
    } catch {
      prettyInput = inputPreview
    }
    const expanded =
      `\u{1F510} Permission: ${toolName}\n\n` +
      `tool_name: ${toolName}\n` +
      `description: ${description}\n` +
      `input_preview:\n${prettyInput}`
    const keyboard = new InlineKeyboard()
      .text('\u2705 Allow', `perm:allow:${requestId}`)
      .text('\u274C Deny', `perm:deny:${requestId}`)
    await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }

  // Allow or Deny
  const threadId = ctx.callbackQuery.message?.message_thread_id
  if (threadId != null) {
    const shim = findShimByTopic(threadId)
    if (shim) {
      const verdict: PermissionVerdictForwardMessage = {
        type: 'permission_verdict_forward',
        requestId,
        behavior: behavior as 'allow' | 'deny',
      }
      sendToShim(shim, verdict)
    }
  }

  pendingPermissions.delete(requestId)
  const label = behavior === 'allow' ? '\u2705 Allowed' : '\u274C Denied'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  // Replace buttons with outcome
  const cbMsg = ctx.callbackQuery.message
  if (cbMsg && 'text' in cbMsg && cbMsg.text) {
    await ctx.editMessageText(`${cbMsg.text}\n\n${label}`).catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Telegram message handlers
// ---------------------------------------------------------------------------

bot.on('message:text', async ctx => {
  await handleInbound(ctx)
})

bot.on('message:photo', async ctx => {
  await handleInbound(ctx)
})

bot.on('message:document', async ctx => {
  await handleInbound(ctx)
})

// Prevent polling from stopping on handler errors
bot.catch(err => {
  process.stderr.write(`telegram-topics daemon: handler error (polling continues): ${err.error}\n`)
})

// ---------------------------------------------------------------------------
// Approvals polling (same as official plugin)
// ---------------------------------------------------------------------------

function checkApprovals(): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch {
    return
  }
  if (files.length === 0) return

  for (const senderId of files) {
    if (senderId.startsWith('.')) continue
    const file = join(APPROVED_DIR, senderId)
    void bot.api.sendMessage(senderId, 'Paired! Say hi to Claude in the forum topics.').then(
      () => rmSync(file, { force: true }),
      err => {
        process.stderr.write(`telegram-topics daemon: failed to send approval confirm: ${err}\n`)
        rmSync(file, { force: true })
      },
    )
  }
}

const approvalInterval = setInterval(checkApprovals, 5000)
approvalInterval.unref()

// ---------------------------------------------------------------------------
// Unix socket server
// ---------------------------------------------------------------------------

function cleanupSocket(): void {
  try { unlinkSync(SOCKET_PATH) } catch {}
}

// Clean up stale socket
cleanupSocket()
mkdirSync(join(STATE_DIR), { recursive: true, mode: 0o700 })

const socketServer = Bun.listen<{ buffer: string }>({
  unix: SOCKET_PATH,
  socket: {
    open(socket) {
      socket.data = { buffer: '' }
      const shim: ShimSocket = { socket, topicId: null, projectPath: null }
      connectedShims.add(shim)
      // Store the shim reference on the socket data for lookup in other handlers.
      // Bun socket data is typed as { buffer: string }, but we stash extra info
      // via a side Map.
      shimBySocket.set(socket, shim)
      resetIdleTimer()
      process.stderr.write(`telegram-topics daemon: shim connected (total: ${connectedShims.size})\n`)
    },

    data(socket, data) {
      const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
      socket.data.buffer += raw

      const { messages, remainder } = parseMessages<ShimMessage>(socket.data.buffer)
      socket.data.buffer = remainder

      const shim = shimBySocket.get(socket)
      if (!shim) return

      for (const msg of messages) {
        void handleShimMessage(shim, msg).catch(err => {
          process.stderr.write(`telegram-topics daemon: shim message handler error: ${err}\n`)
          sendToShim(shim, { type: 'error', message: `internal error: ${err}` })
        })
      }
    },

    close(socket) {
      const shim = shimBySocket.get(socket)
      if (shim) {
        if (shim.topicId != null) {
          shimsByTopic.delete(shim.topicId)
        }
        connectedShims.delete(shim)
        shimBySocket.delete(socket)
        process.stderr.write(`telegram-topics daemon: shim disconnected (total: ${connectedShims.size})\n`)
        if (connectedShims.size === 0) {
          startIdleTimer()
        }
      }
    },

    error(socket, error) {
      process.stderr.write(`telegram-topics daemon: socket error: ${error}\n`)
    },
  },
})

// Side map: Bun socket -> ShimSocket (Bun's socket.data is typed and we
// can't add arbitrary fields without changing the generic param).
const shimBySocket = new Map<import('bun').Socket<{ buffer: string }>, ShimSocket>()

process.stderr.write(`telegram-topics daemon: listening on ${SOCKET_PATH}\n`)

// ---------------------------------------------------------------------------
// Clean shutdown
// ---------------------------------------------------------------------------

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('telegram-topics daemon: shutting down\n')

  // Stop idle timer
  resetIdleTimer()

  // Close socket server
  try { socketServer.stop(true) } catch {}
  cleanupSocket()

  // Clear PID
  clearPid(STATE_DIR)

  // Clear intervals
  clearInterval(approvalInterval)

  // Stop bot — force exit after 2s
  setTimeout(() => process.exit(0), 2000).unref()
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

// Orphan watchdog: detect parent chain breakage
const bootPpid = process.ppid
const orphanWatchdog = setInterval(() => {
  const orphaned =
    (process.platform !== 'win32' && process.ppid !== bootPpid) ||
    process.stdin.destroyed ||
    process.stdin.readableEnded
  if (orphaned) shutdown()
}, 5000)
orphanWatchdog.unref()

// ---------------------------------------------------------------------------
// Bot polling with retry/backoff
// ---------------------------------------------------------------------------

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          attempt = 0
          botUsername = info.username
          process.stderr.write(`telegram-topics daemon: polling as @${info.username}\n`)
          void bot.api.setMyCommands(
            [
              { command: 'start', description: 'Welcome and setup guide' },
              { command: 'help', description: 'What this bot can do' },
              { command: 'status', description: 'Check your pairing status' },
            ],
            { scope: { type: 'all_private_chats' } },
          ).catch(() => {})
        },
      })
      return // bot.stop() was called — clean exit
    } catch (err) {
      if (shuttingDown) return
      if (err instanceof Error && err.message === 'Aborted delay') return
      const is409 = err instanceof GrammyError && err.error_code === 409
      if (is409 && attempt >= 8) {
        process.stderr.write(
          `telegram-topics daemon: 409 Conflict persists after ${attempt} attempts \u2014 ` +
          `another poller is holding the bot token. Exiting.\n`,
        )
        shutdown()
        return
      }
      const delay = Math.min(1000 * attempt, 15000)
      const detail = is409
        ? `409 Conflict${attempt === 1 ? ' \u2014 another instance is polling' : ''}`
        : `polling error: ${err}`
      process.stderr.write(`telegram-topics daemon: ${detail}, retrying in ${delay / 1000}s\n`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
})()

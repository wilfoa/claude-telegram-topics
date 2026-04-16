/**
 * Persistent state management for telegram-topics.
 * All state lives under ~/.claude/channels/telegram-topics/.
 * Every function accepts an optional stateDir override for testing.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export const DEFAULT_STATE_DIR = join(homedir(), '.claude', 'channels', 'telegram-topics')

// --- Access ---

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  pending: Record<string, PendingEntry>
  chatId?: string  // supergroup chat ID
}

export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], pending: {} }
}

export function loadAccess(stateDir = DEFAULT_STATE_DIR): Access {
  const file = join(stateDir, 'access.json')
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      pending: parsed.pending ?? {},
      chatId: parsed.chatId,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
    return defaultAccess()
  }
}

export function saveAccess(access: Access, stateDir = DEFAULT_STATE_DIR): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, 'access.json')
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

// --- Topics ---

export type TopicEntry = {
  topicId: number
  topicName: string
}

export type TopicMap = Record<string, TopicEntry>

export function loadTopics(stateDir = DEFAULT_STATE_DIR): TopicMap {
  const file = join(stateDir, 'topics.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as TopicMap
  } catch {
    return {}
  }
}

export function saveTopics(topics: TopicMap, stateDir = DEFAULT_STATE_DIR): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, 'topics.json')
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(topics, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

// --- Token (.env) ---

export function loadToken(stateDir = DEFAULT_STATE_DIR): string | undefined {
  const file = join(stateDir, '.env')
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^CLAUDE_TELEGRAM_TOPICS_BOT_TOKEN=(.+)$/)
      if (m) return m[1]
    }
  } catch {}
  return undefined
}

export function saveToken(token: string, stateDir = DEFAULT_STATE_DIR): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, '.env')
  let lines: string[] = []
  try {
    lines = readFileSync(file, 'utf8').split('\n')
  } catch {}
  const idx = lines.findIndex(l => l.startsWith('CLAUDE_TELEGRAM_TOPICS_BOT_TOKEN='))
  const entry = `CLAUDE_TELEGRAM_TOPICS_BOT_TOKEN=${token}`
  if (idx >= 0) {
    lines[idx] = entry
  } else {
    lines.push(entry)
  }
  // Remove trailing empty lines, add one final newline
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
}

export function clearToken(stateDir = DEFAULT_STATE_DIR): void {
  const file = join(stateDir, '.env')
  try {
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter(l => !l.startsWith('CLAUDE_TELEGRAM_TOPICS_BOT_TOKEN='))
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    if (lines.length === 0) {
      rmSync(file, { force: true })
    } else {
      writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
    }
  } catch {}
}

// --- PID ---

export function readPid(stateDir = DEFAULT_STATE_DIR): number | undefined {
  try {
    const raw = readFileSync(join(stateDir, 'daemon.pid'), 'utf8').trim()
    const pid = parseInt(raw, 10)
    return isNaN(pid) ? undefined : pid
  } catch {
    return undefined
  }
}

export function writePid(pid: number, stateDir = DEFAULT_STATE_DIR): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(stateDir, 'daemon.pid'), String(pid), { mode: 0o644 })
}

export function clearPid(stateDir = DEFAULT_STATE_DIR): void {
  try { rmSync(join(stateDir, 'daemon.pid'), { force: true }) } catch {}
}

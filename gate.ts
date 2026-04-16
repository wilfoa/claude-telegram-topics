/**
 * Sender gate — pure logic, no I/O.
 * Decides whether to deliver, drop, or pair based on Access state.
 * Mutates the Access object in-place when creating pending entries.
 */

import { randomBytes } from 'crypto'
import type { Access } from './state'

export type GateResult =
  | { action: 'deliver' }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

const PAIRING_TTL_MS = 60 * 60 * 1000 // 1 hour
const MAX_PENDING = 3
const MAX_REPLIES = 2

export function gate(senderId: string, access: Access): GateResult {
  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  if (access.allowFrom.includes(senderId)) return { action: 'deliver' }

  if (access.dmPolicy === 'allowlist') return { action: 'drop' }

  // pairing mode — check for existing code for this sender
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      if (p.replies >= MAX_REPLIES) return { action: 'drop' }
      p.replies++
      return { action: 'pair', code, isResend: true }
    }
  }

  // Cap pending entries
  if (Object.keys(access.pending).length >= MAX_PENDING) return { action: 'drop' }

  // Generate new pairing code
  const code = randomBytes(3).toString('hex') // 6 hex chars
  const now = Date.now()
  access.pending[code] = {
    senderId,
    chatId: senderId, // for DMs, chatId == senderId
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
    replies: 1,
  }
  return { action: 'pair', code, isResend: false }
}

/** Remove expired pending entries. Returns true if any were removed. */
export function pruneExpired(access: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.expiresAt < now) {
      delete access.pending[code]
      changed = true
    }
  }
  return changed
}

/**
 * Permission verdict regex.
 * Matches "yes xxxxx" / "no xxxxx" where xxxxx is 5 lowercase letters (no 'l').
 * Case-insensitive for phone autocorrect.
 */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

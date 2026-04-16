import { describe, expect, test } from 'bun:test'
import { gate, pruneExpired, type GateResult } from './gate'
import { defaultAccess, type Access } from './state'

function makeAccess(overrides: Partial<Access> = {}): Access {
  return { ...defaultAccess(), ...overrides }
}

describe('gate', () => {
  test('drops when dmPolicy is disabled', () => {
    const access = makeAccess({ dmPolicy: 'disabled' })
    const result = gate('sender1', access)
    expect(result.action).toBe('drop')
  })

  test('delivers for allowlisted sender', () => {
    const access = makeAccess({ dmPolicy: 'allowlist', allowFrom: ['sender1'] })
    const result = gate('sender1', access)
    expect(result.action).toBe('deliver')
  })

  test('drops non-allowlisted sender in allowlist mode', () => {
    const access = makeAccess({ dmPolicy: 'allowlist', allowFrom: ['sender1'] })
    const result = gate('sender2', access)
    expect(result.action).toBe('drop')
  })

  test('generates pairing code for unknown sender in pairing mode', () => {
    const access = makeAccess({ dmPolicy: 'pairing' })
    const result = gate('sender1', access)
    expect(result.action).toBe('pair')
    if (result.action === 'pair') {
      expect(result.code).toHaveLength(6)
      expect(result.isResend).toBe(false)
      expect(Object.keys(access.pending)).toHaveLength(1)
    }
  })

  test('resends existing code for sender with pending pairing', () => {
    const access = makeAccess({
      dmPolicy: 'pairing',
      pending: {
        'abc123': {
          senderId: 'sender1',
          chatId: 'chat1',
          createdAt: Date.now(),
          expiresAt: Date.now() + 3600000,
          replies: 1,
        },
      },
    })
    const result = gate('sender1', access)
    expect(result.action).toBe('pair')
    if (result.action === 'pair') {
      expect(result.code).toBe('abc123')
      expect(result.isResend).toBe(true)
    }
  })

  test('drops sender after 2 pairing replies', () => {
    const access = makeAccess({
      dmPolicy: 'pairing',
      pending: {
        'abc123': {
          senderId: 'sender1',
          chatId: 'chat1',
          createdAt: Date.now(),
          expiresAt: Date.now() + 3600000,
          replies: 2,
        },
      },
    })
    const result = gate('sender1', access)
    expect(result.action).toBe('drop')
  })

  test('caps pending at 3', () => {
    const now = Date.now()
    const access = makeAccess({
      dmPolicy: 'pairing',
      pending: {
        'aaa111': { senderId: 's1', chatId: 'c1', createdAt: now, expiresAt: now + 3600000, replies: 1 },
        'bbb222': { senderId: 's2', chatId: 'c2', createdAt: now, expiresAt: now + 3600000, replies: 1 },
        'ccc333': { senderId: 's3', chatId: 'c3', createdAt: now, expiresAt: now + 3600000, replies: 1 },
      },
    })
    const result = gate('sender4', access)
    expect(result.action).toBe('drop')
  })
})

describe('pruneExpired', () => {
  test('removes expired entries', () => {
    const access = makeAccess({
      pending: {
        'old': { senderId: 's1', chatId: 'c1', createdAt: 0, expiresAt: 1, replies: 1 },
        'new': { senderId: 's2', chatId: 'c2', createdAt: Date.now(), expiresAt: Date.now() + 3600000, replies: 1 },
      },
    })
    const changed = pruneExpired(access)
    expect(changed).toBe(true)
    expect(Object.keys(access.pending)).toEqual(['new'])
  })

  test('returns false when nothing expired', () => {
    const access = makeAccess({
      pending: {
        'new': { senderId: 's1', chatId: 'c1', createdAt: Date.now(), expiresAt: Date.now() + 3600000, replies: 1 },
      },
    })
    expect(pruneExpired(access)).toBe(false)
  })
})

import { describe, expect, test } from 'bun:test'
import { parseMessages, serialize } from './protocol'
import type { ShimMessage, DaemonMessage } from './protocol'

describe('parseMessages', () => {
  test('parses complete messages', () => {
    const input = '{"type":"register","projectPath":"/a","topicLabel":"a"}\n{"type":"error","message":"x"}\n'
    const { messages, remainder } = parseMessages<ShimMessage | DaemonMessage>(input)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ type: 'register', projectPath: '/a', topicLabel: 'a' })
    expect(messages[1]).toEqual({ type: 'error', message: 'x' })
    expect(remainder).toBe('')
  })

  test('returns incomplete data as remainder', () => {
    const input = '{"type":"register","projectPa'
    const { messages, remainder } = parseMessages(input)
    expect(messages).toHaveLength(0)
    expect(remainder).toBe('{"type":"register","projectPa')
  })

  test('handles mixed complete and incomplete', () => {
    const input = '{"type":"error","message":"ok"}\n{"type":"re'
    const { messages, remainder } = parseMessages<DaemonMessage>(input)
    expect(messages).toHaveLength(1)
    expect(remainder).toBe('{"type":"re')
  })

  test('skips blank lines', () => {
    const input = '\n\n{"type":"error","message":"x"}\n\n'
    const { messages, remainder } = parseMessages<DaemonMessage>(input)
    expect(messages).toHaveLength(1)
    expect(remainder).toBe('')
  })
})

describe('serialize', () => {
  test('produces newline-terminated JSON', () => {
    const msg: ShimMessage = { type: 'register', projectPath: '/a', topicLabel: 'a' }
    const out = serialize(msg)
    expect(out.endsWith('\n')).toBe(true)
    expect(JSON.parse(out.trim())).toEqual(msg)
  })
})

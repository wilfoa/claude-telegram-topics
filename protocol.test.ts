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

// ---------------------------------------------------------------------------
// Integration-level: the parse/serialize pair must survive realistic stream
// conditions (fragmented delivery, large payloads, malformed frames mixed
// with valid ones). This is what the daemon/shim socket code relies on.
// ---------------------------------------------------------------------------

describe('protocol round-trip', () => {
  test('serialize + parseMessages is idempotent over many message types', () => {
    const originals: (ShimMessage | DaemonMessage)[] = [
      { type: 'register', projectPath: '/p', topicLabel: 'lbl' },
      { type: 'tool_call', callId: 'c1', tool: 'reply', args: { text: 'hi', files: ['/a.png'] } },
      { type: 'registered', topicId: 42, topicName: 'n', projectPath: '/p' },
      { type: 'inbound', content: 'hello world', meta: { user: 'a', user_id: '1' } },
      { type: 'tool_result', callId: 'c1', result: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'error', message: 'oh no' },
      { type: 'permission_request', requestId: 'r1', toolName: 'Bash', description: 'ls', inputPreview: '$ ls' },
      { type: 'permission_verdict_forward', requestId: 'r1', behavior: 'allow' },
    ]
    const wire = originals.map(serialize).join('')
    const { messages, remainder } = parseMessages<ShimMessage | DaemonMessage>(wire)
    expect(remainder).toBe('')
    expect(messages).toEqual(originals)
  })

  test('byte-at-a-time delivery reconstructs the full stream', () => {
    const msgs: DaemonMessage[] = [
      { type: 'registered', topicId: 1, topicName: 'one', projectPath: '/one' },
      { type: 'inbound', content: 'x'.repeat(200), meta: { k: 'v' } },
      { type: 'error', message: 'boom' },
    ]
    const wire = msgs.map(serialize).join('')

    let buffer = ''
    const collected: DaemonMessage[] = []
    for (const ch of wire) {
      buffer += ch
      const { messages, remainder } = parseMessages<DaemonMessage>(buffer)
      collected.push(...messages)
      buffer = remainder
    }
    expect(buffer).toBe('')
    expect(collected).toEqual(msgs)
  })

  test('large payload (1 MB content) round-trips in one frame', () => {
    const huge: DaemonMessage = { type: 'inbound', content: 'A'.repeat(1_000_000), meta: {} }
    const wire = serialize(huge)
    // Split the wire arbitrarily — single newline still terminates.
    const mid = Math.floor(wire.length / 2)
    const chunk1 = wire.slice(0, mid)
    const chunk2 = wire.slice(mid)
    const { messages: m1, remainder: r1 } = parseMessages<DaemonMessage>(chunk1)
    expect(m1).toEqual([])
    const { messages: m2, remainder: r2 } = parseMessages<DaemonMessage>(r1 + chunk2)
    expect(r2).toBe('')
    expect(m2).toHaveLength(1)
    expect(m2[0]).toEqual(huge)
  })

  test('malformed JSON between valid frames is skipped without losing neighbors', () => {
    const valid1 = serialize({ type: 'error', message: 'a' })
    const valid2 = serialize({ type: 'error', message: 'b' })
    const malformed = '{not-json at all}\n'
    const wire = valid1 + malformed + valid2
    const { messages, remainder } = parseMessages<DaemonMessage>(wire)
    expect(remainder).toBe('')
    expect(messages).toEqual([
      { type: 'error', message: 'a' },
      { type: 'error', message: 'b' },
    ])
  })

  test('messages containing embedded newlines in string fields round-trip via JSON escaping', () => {
    const msg: DaemonMessage = {
      type: 'inbound',
      content: 'line1\nline2\nline3',
      meta: { text: 'has\nnewline' },
    }
    const wire = serialize(msg)
    // Only ONE real newline on the wire — the terminator.
    expect(wire.match(/\n/g)?.length).toBe(1)
    const { messages, remainder } = parseMessages<DaemonMessage>(wire)
    expect(remainder).toBe('')
    expect(messages).toEqual([msg])
  })

  test('unicode content survives round-trip', () => {
    const msg: DaemonMessage = {
      type: 'inbound',
      content: 'Hello שלום 你好 🌍 — em-dash and ✨ emoji',
      meta: { user: 'тест' },
    }
    const { messages } = parseMessages<DaemonMessage>(serialize(msg))
    expect(messages).toEqual([msg])
  })

  test('interleaved partial + complete messages across three buffers', () => {
    const a = serialize({ type: 'error', message: 'first' })
    const b = serialize({ type: 'error', message: 'second' })
    const c = serialize({ type: 'error', message: 'third' })
    // Chunk 1: full a + first half of b
    // Chunk 2: second half of b + first half of c
    // Chunk 3: rest of c
    const midB = Math.floor(b.length / 2)
    const midC = Math.floor(c.length / 2)
    const chunks = [
      a + b.slice(0, midB),
      b.slice(midB) + c.slice(0, midC),
      c.slice(midC),
    ]
    let buffer = ''
    const out: DaemonMessage[] = []
    for (const ch of chunks) {
      buffer += ch
      const { messages, remainder } = parseMessages<DaemonMessage>(buffer)
      out.push(...messages)
      buffer = remainder
    }
    expect(buffer).toBe('')
    expect(out.map(m => (m as { message: string }).message)).toEqual(['first', 'second', 'third'])
  })
})

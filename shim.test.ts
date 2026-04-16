import { describe, expect, test } from 'bun:test'
import { parseDaemonsFromPs, selectDaemonToKeep } from './shim'

describe('parseDaemonsFromPs', () => {
  test('picks out telegram-topics daemon processes', () => {
    const psOut = [
      '  123 bun run /Users/a/.claude/plugins/cache/wilfoa-plugins/telegram-topics/0.0.9/daemon.ts',
      '  456 bun run /Users/a/.claude/plugins/cache/wilfoa-plugins/telegram-topics/0.0.10/daemon.ts',
      '  789 bun run /Users/a/Development/telegram-topics/daemon.ts',
      '  999 node some-other-thing.js',
    ].join('\n')
    const out = parseDaemonsFromPs(psOut, 1)
    expect(out.map(d => d.pid).sort()).toEqual([123, 456, 789])
  })

  test('excludes the shim process itself', () => {
    const psOut = '  777 bun run /cache/telegram-topics/0.0.10/shim.ts'
    expect(parseDaemonsFromPs(psOut, 1)).toEqual([])
  })

  test('excludes the caller pid', () => {
    const psOut = [
      '  111 bun run /cache/telegram-topics/0.0.10/daemon.ts',
      '  222 bun run /cache/telegram-topics/0.0.10/daemon.ts',
    ].join('\n')
    const out = parseDaemonsFromPs(psOut, 111)
    expect(out.map(d => d.pid)).toEqual([222])
  })

  test('ignores blank / malformed lines', () => {
    const psOut = [
      '',
      '  not a pid here',
      '  12 bun run /cache/telegram-topics/0.0.10/daemon.ts',
    ].join('\n')
    expect(parseDaemonsFromPs(psOut, 1).map(d => d.pid)).toEqual([12])
  })

  test('rejects unrelated bun daemon.ts paths', () => {
    // daemon.ts exists under a path that does not contain telegram-topics
    const psOut = '  33 bun run /Users/a/other-project/daemon.ts'
    expect(parseDaemonsFromPs(psOut, 1)).toEqual([])
  })
})

describe('selectDaemonToKeep', () => {
  const EXPECTED = '/cache/telegram-topics/0.0.10/daemon.ts'

  test('returns null when no daemon matches the expected path', () => {
    const daemons = [
      { pid: 1, cmdline: 'bun run /cache/telegram-topics/0.0.9/daemon.ts' },
      { pid: 2, cmdline: 'bun run /Users/a/Development/telegram-topics/daemon.ts' },
    ]
    expect(selectDaemonToKeep(daemons, EXPECTED, undefined)).toBeNull()
  })

  test('prefers the tracked pid when it matches expected path', () => {
    const daemons = [
      { pid: 10, cmdline: `bun run ${EXPECTED}` },
      { pid: 20, cmdline: `bun run ${EXPECTED}` },
    ]
    expect(selectDaemonToKeep(daemons, EXPECTED, 10)).toBe(10)
  })

  test('falls back to highest pid when tracked pid is not present', () => {
    const daemons = [
      { pid: 10, cmdline: `bun run ${EXPECTED}` },
      { pid: 30, cmdline: `bun run ${EXPECTED}` },
      { pid: 20, cmdline: `bun run ${EXPECTED}` },
    ]
    expect(selectDaemonToKeep(daemons, EXPECTED, 999)).toBe(30)
  })

  test('ignores tracked pid when it points to a non-matching daemon', () => {
    const daemons = [
      { pid: 10, cmdline: 'bun run /cache/telegram-topics/0.0.9/daemon.ts' },
      { pid: 20, cmdline: `bun run ${EXPECTED}` },
    ]
    expect(selectDaemonToKeep(daemons, EXPECTED, 10)).toBe(20)
  })

  test('returns null when daemon list is empty', () => {
    expect(selectDaemonToKeep([], EXPECTED, undefined)).toBeNull()
  })
})

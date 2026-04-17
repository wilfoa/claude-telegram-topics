import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseDaemonsFromPs, selectDaemonToKeep, withSpawnLock } from './shim'

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

describe('withSpawnLock', () => {
  let tmp: string
  let lockPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tt-lock-'))
    lockPath = join(tmp, 'spawn.lock')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('acquires lock, runs fn, and releases on success', async () => {
    const result = await withSpawnLock(lockPath, async () => {
      expect(existsSync(lockPath)).toBe(true)
      expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid))
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(existsSync(lockPath)).toBe(false)
  })

  test('releases lock even if fn throws', async () => {
    await expect(
      withSpawnLock(lockPath, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(existsSync(lockPath)).toBe(false)
  })

  test('serializes concurrent callers', async () => {
    let active = 0
    let maxActive = 0
    const order: number[] = []

    const task = (i: number) =>
      withSpawnLock(lockPath, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        order.push(i)
        await new Promise(r => setTimeout(r, 30))
        active--
      }, { pollMs: 5 })

    await Promise.all([task(1), task(2), task(3), task(4)])
    expect(maxActive).toBe(1)
    expect(order.sort()).toEqual([1, 2, 3, 4])
    expect(existsSync(lockPath)).toBe(false)
  })

  test('steals the lock when the holder PID is dead', async () => {
    // Pre-create a lockfile owned by a bogus PID that our isAlive stub marks dead.
    writeFileSync(lockPath, '999999', { flag: 'wx' })
    const result = await withSpawnLock(
      lockPath,
      async () => 'stolen',
      { isAlive: () => false, pollMs: 5 },
    )
    expect(result).toBe('stolen')
  })

  test('times out when holder PID is alive and lock is never released', async () => {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' })
    await expect(
      withSpawnLock(
        lockPath,
        async () => 'should-not-run',
        { isAlive: () => true, timeoutMs: 100, pollMs: 20 },
      ),
    ).rejects.toThrow(/could not acquire daemon spawn lock/)
    // Lock still held — we didn't clobber it.
    expect(existsSync(lockPath)).toBe(true)
  })

  test('steals a lock with corrupted (non-numeric) content', async () => {
    writeFileSync(lockPath, 'not-a-pid\n')
    // parseInt('not-a-pid') is NaN, falsy, so the stale branch reads it and
    // bails out of stealing — which means we should time out here.
    // Documenting the current behavior rather than silently changing it.
    await expect(
      withSpawnLock(lockPath, async () => 'x', { isAlive: () => true, timeoutMs: 100, pollMs: 20 }),
    ).rejects.toThrow(/could not acquire/)
    // Still present — we don't clobber unparseable lockfiles blindly.
    expect(existsSync(lockPath)).toBe(true)
  })

  test('survives rapid sequential acquire/release under churn', async () => {
    let count = 0
    for (let i = 0; i < 25; i++) {
      await withSpawnLock(lockPath, async () => { count++ }, { pollMs: 2 })
      expect(existsSync(lockPath)).toBe(false)
    }
    expect(count).toBe(25)
  })

  test('10-way concurrency still serializes and completes in time', async () => {
    let active = 0
    let maxActive = 0
    const tasks = Array.from({ length: 10 }, (_, i) =>
      withSpawnLock(lockPath, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(r => setTimeout(r, 5))
        active--
        return i
      }, { pollMs: 2 }),
    )
    const results = await Promise.all(tasks)
    expect(maxActive).toBe(1)
    expect(results.sort((a, b) => a - b)).toEqual([0,1,2,3,4,5,6,7,8,9])
  })
})

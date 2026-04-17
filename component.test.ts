/**
 * Component tests: spawn real daemon processes against a scratch state dir
 * and exercise the Unix-socket protocol. No Telegram network is required —
 * we pre-seed topics.json so the daemon never calls bot.api.createForumTopic.
 * The grammy poller will log 401s to stderr but that's harmless for these
 * tests since we never assert on it.
 *
 * These tests are the main line of defense for the concurrency fixes
 * (self-guard, bind race, eviction). Unit tests alone can't catch those.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  parseMessages,
  serialize,
  type DaemonMessage,
  type ShimMessage,
} from './protocol'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DAEMON_PATH = join(import.meta.dir, 'daemon.ts')
const FAKE_CHAT_ID = -1009999999999
const FAKE_TOKEN = '1234567:FAKE_TOKEN_FOR_TESTS_ONLY'

const spawnedPids: number[] = []

type SeededProject = { path: string; topicId: number; topicName: string }

function seedStateDir(opts: { projects?: SeededProject[]; allowFrom?: number[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'tt-comp-'))
  writeFileSync(join(dir, '.env'), `CLAUDE_TELEGRAM_TOPICS_BOT_TOKEN=${FAKE_TOKEN}\n`, { mode: 0o600 })
  writeFileSync(
    join(dir, 'access.json'),
    JSON.stringify({
      chatId: FAKE_CHAT_ID,
      dmPolicy: 'allowlist',
      allowFrom: opts.allowFrom ?? [],
      pending: {},
    }),
    { mode: 0o600 },
  )
  const topics: Record<string, { topicId: number; topicName: string }> = {}
  for (const p of opts.projects ?? []) {
    topics[p.path] = { topicId: p.topicId, topicName: p.topicName }
  }
  writeFileSync(join(dir, 'topics.json'), JSON.stringify(topics))
  mkdirSync(join(dir, 'approved'), { recursive: true })
  mkdirSync(join(dir, 'inbox'), { recursive: true })
  return dir
}

function spawnDaemon(stateDir: string): ChildProcess {
  const child = spawn('bun', [DAEMON_PATH], {
    env: { ...process.env, TELEGRAM_TOPICS_STATE_DIR: stateDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (child.pid) spawnedPids.push(child.pid)
  return child
}

async function waitForSocket(stateDir: string, timeoutMs = 5000): Promise<string> {
  const sockPath = join(stateDir, 'daemon.sock')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(sockPath)) return sockPath
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`socket did not appear at ${sockPath} within ${timeoutMs}ms`)
}

async function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  return new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not exit within ${timeoutMs}ms`)), timeoutMs)
    child.once('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
}

/** Minimal client that speaks the shim-daemon protocol over a Unix socket. */
class Client {
  private socket!: import('bun').Socket<{ buffer: string }>
  private buffer = ''
  readonly inbox: DaemonMessage[] = []
  private waiters: Array<{
    predicate: (m: DaemonMessage) => boolean
    resolve: (m: DaemonMessage) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []
  closed = false

  static async connect(sockPath: string): Promise<Client> {
    const c = new Client()
    c.socket = await Bun.connect<{ buffer: string }>({
      unix: sockPath,
      socket: {
        open(s) { s.data = { buffer: '' } },
        data: (_s, data) => {
          const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
          c.buffer += raw
          const { messages, remainder } = parseMessages<DaemonMessage>(c.buffer)
          c.buffer = remainder
          for (const m of messages) {
            c.inbox.push(m)
            // Satisfy the earliest matching waiter
            for (let i = 0; i < c.waiters.length; i++) {
              const w = c.waiters[i]!
              if (w.predicate(m)) {
                clearTimeout(w.timer)
                c.waiters.splice(i, 1)
                w.resolve(m)
                break
              }
            }
          }
        },
        close: () => { c.closed = true },
        error: () => { c.closed = true },
      },
    })
    return c
  }

  send(msg: ShimMessage): void {
    this.socket.write(serialize(msg))
  }

  /** Wait for the first message matching predicate, with timeout. */
  await(predicate: (m: DaemonMessage) => boolean, timeoutMs = 3000): Promise<DaemonMessage> {
    // Check already-received messages first (shouldn't re-deliver — use indexed
    // wait instead if needed), then register a waiter.
    return new Promise<DaemonMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex(w => w.predicate === predicate)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error(`timed out waiting for message (inbox: ${JSON.stringify(this.inbox)})`))
      }, timeoutMs)
      this.waiters.push({ predicate, resolve, reject, timer })
    })
  }

  close(): void {
    try { this.socket.end() } catch {}
  }
}

function killChild(child: ChildProcess): Promise<void> {
  return new Promise<void>(resolve => {
    if (child.exitCode !== null || child.killed) return resolve()
    child.once('exit', () => resolve())
    try { child.kill('SIGTERM') } catch {}
    setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill('SIGKILL') } catch {}
      }
      resolve()
    }, 2000).unref()
  })
}

const activeChildren: ChildProcess[] = []
const activeDirs: string[] = []

function track(child: ChildProcess): ChildProcess {
  activeChildren.push(child)
  return child
}

function trackDir(dir: string): string {
  activeDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(activeChildren.splice(0).map(killChild))
  for (const d of activeDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

// ---------------------------------------------------------------------------
// Self-guard: at most one daemon on a state dir
// ---------------------------------------------------------------------------

const LONG_TIMEOUT = 20_000

describe('daemon self-guard', () => {
  test('second daemon on the same state dir exits cleanly', async () => {
    const dir = trackDir(seedStateDir())

    const a = track(spawnDaemon(dir))
    await waitForSocket(dir, 10_000)
    expect(a.exitCode).toBeNull()

    const b = track(spawnDaemon(dir))
    const bCode = await waitForExit(b, 10_000)
    // Exits cleanly (0), not via crash. The first daemon is still running.
    expect(bCode).toBe(0)
    expect(a.exitCode).toBeNull()
  }, LONG_TIMEOUT)

  test('two daemons launched in the same tick — exactly one wins, the other exits 0', async () => {
    // This is the real regression test for the 409 race: two daemons start so
    // close together that neither sees the other's socket before binding. The
    // self-guard at startup and the bind-retry fallback must together ensure
    // exactly one survives, and the loser exits cleanly (not via crash).
    const dir = trackDir(seedStateDir())

    // Spawn in the same microtask — no awaits between them.
    const a = track(spawnDaemon(dir))
    const b = track(spawnDaemon(dir))

    // Winner must produce a socket.
    await waitForSocket(dir, 10_000)

    // Give loser time to notice and exit.
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const aliveCount = [a, b].filter(c => c.exitCode === null).length
      if (aliveCount === 1) break
      await new Promise(r => setTimeout(r, 50))
    }

    const alive = [a, b].filter(c => c.exitCode === null)
    const dead = [a, b].filter(c => c.exitCode !== null)
    expect(alive).toHaveLength(1)
    expect(dead).toHaveLength(1)
    expect(dead[0]!.exitCode).toBe(0)
  }, LONG_TIMEOUT)

  test('four daemons launched in the same tick — exactly one wins', async () => {
    // Higher contention, same invariant. Catches bugs that only show up when
    // multiple losers race each other as well as the winner.
    const dir = trackDir(seedStateDir())
    const children = Array.from({ length: 4 }, () => track(spawnDaemon(dir)))

    await waitForSocket(dir, 10_000)

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const aliveCount = children.filter(c => c.exitCode === null).length
      if (aliveCount === 1) break
      await new Promise(r => setTimeout(r, 50))
    }

    const alive = children.filter(c => c.exitCode === null)
    const dead = children.filter(c => c.exitCode !== null)
    expect(alive).toHaveLength(1)
    expect(dead).toHaveLength(3)
    for (const d of dead) expect(d.exitCode).toBe(0)
  }, LONG_TIMEOUT + 10_000)

  test('loser stderr names the self-guard reason', async () => {
    // Strong evidence the exit was via our guard (not an unrelated crash).
    const dir = trackDir(seedStateDir())

    const a = spawnDaemon(dir)
    track(a)
    await waitForSocket(dir, 10_000)

    const b = spawnDaemon(dir)
    track(b)

    let bStderr = ''
    b.stderr?.on('data', chunk => { bStderr += chunk.toString() })

    await waitForExit(b, 10_000)
    expect(bStderr).toMatch(/holds .*daemon\.lock/)
  }, LONG_TIMEOUT)

  test('dangling socket file without a live daemon is cleaned up', async () => {
    const dir = trackDir(seedStateDir())
    // Create a bogus socket file — nothing is listening.
    writeFileSync(join(dir, 'daemon.sock'), '')

    const d = track(spawnDaemon(dir))
    // The daemon should probe, detect nothing alive, unlink, and bind fresh.
    await waitForSocket(dir, 10_000)
    expect(d.exitCode).toBeNull()
  }, LONG_TIMEOUT)

  test('self-guard ignores sockets in unrelated state dirs', async () => {
    // Two independent daemons on separate state dirs must coexist.
    const dirA = trackDir(seedStateDir())
    const dirB = trackDir(seedStateDir())

    const a = track(spawnDaemon(dirA))
    const b = track(spawnDaemon(dirB))
    await waitForSocket(dirA, 10_000)
    await waitForSocket(dirB, 10_000)
    expect(a.exitCode).toBeNull()
    expect(b.exitCode).toBeNull()
  }, LONG_TIMEOUT)
})

// ---------------------------------------------------------------------------
// Register handshake
// ---------------------------------------------------------------------------

describe('register handshake', () => {
  test('client registering a pre-seeded project receives registered response', async () => {
    const project = { path: '/tmp/proj-a', topicId: 101, topicName: 'proj-a' }
    const dir = trackDir(seedStateDir({ projects: [project] }))
    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    const client = await Client.connect(sock)
    try {
      client.send({ type: 'register', projectPath: project.path, topicLabel: project.topicName })
      const m = await client.await(m => m.type === 'registered', 8000)
      expect(m).toEqual({ type: 'registered', topicId: 101, topicName: 'proj-a' })
    } finally {
      client.close()
    }
  }, LONG_TIMEOUT)

  test('registering unknown project surfaces an error (no topic creation in offline mode)', async () => {
    // We did NOT seed this project, so ensureTopic falls into the "create" path
    // which calls bot.api.createForumTopic → 401 with fake token → error reply.
    const dir = trackDir(seedStateDir())
    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    const client = await Client.connect(sock)
    try {
      client.send({ type: 'register', projectPath: '/tmp/unseeded', topicLabel: 'unseeded' })
      const m = await client.await(m => m.type === 'error', 15_000) as { type: 'error'; message: string }
      expect(m.type).toBe('error')
      expect(m.message).toMatch(/register failed/i)
    } finally {
      client.close()
    }
  }, LONG_TIMEOUT + 10_000)
})

// ---------------------------------------------------------------------------
// Same-project eviction (last-writer-wins)
// ---------------------------------------------------------------------------

describe('same-project eviction', () => {
  test('second register for the same project evicts the first with "replaced by new session"', async () => {
    const project = { path: '/tmp/proj-evict', topicId: 202, topicName: 'proj-evict' }
    const dir = trackDir(seedStateDir({ projects: [project] }))
    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    const first = await Client.connect(sock)
    const second = await Client.connect(sock)
    try {
      first.send({ type: 'register', projectPath: project.path, topicLabel: project.topicName })
      await first.await(m => m.type === 'registered', 8000)

      second.send({ type: 'register', projectPath: project.path, topicLabel: project.topicName })
      const [evictMsg, secondRegistered] = await Promise.all([
        first.await(m => m.type === 'error' && /replaced by new session/i.test(m.message), 8000),
        second.await(m => m.type === 'registered', 8000),
      ])
      expect(evictMsg.type).toBe('error')
      expect(secondRegistered.type).toBe('registered')
      // First shim's socket is NOT closed — it's alive but deaf. Matches real behavior.
      expect(first.closed).toBe(false)
    } finally {
      first.close()
      second.close()
    }
  }, LONG_TIMEOUT)
})

// ---------------------------------------------------------------------------
// Multi-project isolation
// ---------------------------------------------------------------------------

describe('multi-project isolation', () => {
  test('two clients on different projects both register successfully, no eviction', async () => {
    const a = { path: '/tmp/proj-a', topicId: 301, topicName: 'proj-a' }
    const b = { path: '/tmp/proj-b', topicId: 302, topicName: 'proj-b' }
    const dir = trackDir(seedStateDir({ projects: [a, b] }))
    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    const ca = await Client.connect(sock)
    const cb = await Client.connect(sock)
    try {
      ca.send({ type: 'register', projectPath: a.path, topicLabel: a.topicName })
      cb.send({ type: 'register', projectPath: b.path, topicLabel: b.topicName })
      const [ra, rb] = await Promise.all([
        ca.await(m => m.type === 'registered', 8000),
        cb.await(m => m.type === 'registered', 8000),
      ])
      expect((ra as { topicId: number }).topicId).toBe(301)
      expect((rb as { topicId: number }).topicId).toBe(302)

      // Neither should have received an eviction error.
      await new Promise(r => setTimeout(r, 200))
      for (const client of [ca, cb]) {
        const errs = client.inbox.filter(m => m.type === 'error')
        expect(errs).toEqual([])
      }
    } finally {
      ca.close()
      cb.close()
    }
  }, LONG_TIMEOUT)
})

// ---------------------------------------------------------------------------
// Disconnect cleanup — topic slot must free up after shim drops
// ---------------------------------------------------------------------------

describe('disconnect cleanup', () => {
  test('a new register for the same project succeeds after the previous client disconnects', async () => {
    const project = { path: '/tmp/proj-dc', topicId: 404, topicName: 'proj-dc' }
    const dir = trackDir(seedStateDir({ projects: [project] }))
    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    const first = await Client.connect(sock)
    first.send({ type: 'register', projectPath: project.path, topicLabel: project.topicName })
    await first.await(m => m.type === 'registered', 8000)
    first.close()

    // Give the daemon a beat to process the close event.
    await new Promise(r => setTimeout(r, 150))

    const second = await Client.connect(sock)
    try {
      second.send({ type: 'register', projectPath: project.path, topicLabel: project.topicName })
      const m = await second.await(m => m.type === 'registered', 8000)
      expect((m as { topicId: number }).topicId).toBe(404)
      // No eviction error because the first client is gone.
      await new Promise(r => setTimeout(r, 100))
      expect(second.inbox.filter(m => m.type === 'error')).toEqual([])
    } finally {
      second.close()
    }
  }, LONG_TIMEOUT)
})

// ---------------------------------------------------------------------------
// Daemon restart — socket file is cleaned up and self-guard doesn't block
// ---------------------------------------------------------------------------

describe('daemon restart', () => {
  test('after killing the daemon, a fresh daemon can bind the same state dir', async () => {
    const dir = trackDir(seedStateDir())
    const a = track(spawnDaemon(dir))
    await waitForSocket(dir, 10_000)

    await killChild(a)
    // After SIGTERM, shutdown() calls cleanupSocket() → socket file removed.
    // If the process didn't get there (SIGKILL path), the self-guard's probe
    // will see a dangling socket and unlink it.

    const b = track(spawnDaemon(dir))
    await waitForSocket(dir, 10_000)
    expect(b.exitCode).toBeNull()
  }, LONG_TIMEOUT)
})

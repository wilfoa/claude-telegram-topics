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
  readFileSync,
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

  /**
   * Wait for the first matching message. Consumes messages from `inbox` so
   * repeated `await` calls advance through the stream rather than re-matching
   * the same message. Checks already-received messages first so a late waiter
   * doesn't miss a message that arrived while the caller was doing other work.
   */
  await(predicate: (m: DaemonMessage) => boolean, timeoutMs = 3000): Promise<DaemonMessage> {
    for (let i = 0; i < this.inbox.length; i++) {
      if (predicate(this.inbox[i]!)) {
        return Promise.resolve(this.inbox.splice(i, 1)[0]!)
      }
    }
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

describe('same-instance eviction', () => {
  test('two shims registering the same explicit named instance: second evicts the first', async () => {
    // Eviction is still the contract for *explicit* instance collisions.
    // Bare cwd now auto-suffixes (see the `auto-suffix` block above), so only
    // explicit `#foo` or `#N` collisions can still evict — this is the
    // "explicit wins" contract for TELEGRAM_TOPICS_INSTANCE.
    const project = { path: '/tmp/proj-evict#exp', topicId: 202, topicName: 'proj-evict (exp)' }
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
      // First shim's socket stays open — alive but deaf. Matches real behavior.
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

// ---------------------------------------------------------------------------
// Auto-suffix — bare-cwd registrations from multiple shims get distinct
// integer slots (1 = bare, 2 = cwd#2, etc.) instead of evicting each other.
// Dead slots get reused before new slots are allocated.
// ---------------------------------------------------------------------------

describe('auto-suffix', () => {
  test('three concurrent shims on same bare cwd land on slots 1, 2, 3 without eviction', async () => {
    const proj = '/tmp/proj-auto'
    const dir = trackDir(seedStateDir({
      projects: [
        { path: proj, topicId: 701, topicName: 'proj-auto' },
        { path: `${proj}#2`, topicId: 702, topicName: 'proj-auto (#2)' },
        { path: `${proj}#3`, topicId: 703, topicName: 'proj-auto (#3)' },
      ],
    }))
    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    // Sequentially register so the second and third see a live peer.
    const c1 = await Client.connect(sock)
    c1.send({ type: 'register', projectPath: proj, topicLabel: 'proj-auto' })
    const r1 = await c1.await(m => m.type === 'registered', 8000) as { type: 'registered'; topicId: number; autoSuffix?: number }
    expect(r1.topicId).toBe(701)
    expect(r1.autoSuffix).toBeUndefined() // primary slot — no auto-suffix marker

    const c2 = await Client.connect(sock)
    c2.send({ type: 'register', projectPath: proj, topicLabel: 'proj-auto' })
    const r2 = await c2.await(m => m.type === 'registered', 8000) as { type: 'registered'; topicId: number; autoSuffix?: number }
    expect(r2.topicId).toBe(702)
    expect(r2.autoSuffix).toBe(2)

    const c3 = await Client.connect(sock)
    c3.send({ type: 'register', projectPath: proj, topicLabel: 'proj-auto' })
    const r3 = await c3.await(m => m.type === 'registered', 8000) as { type: 'registered'; topicId: number; autoSuffix?: number }
    expect(r3.topicId).toBe(703)
    expect(r3.autoSuffix).toBe(3)

    // None of them should have received an eviction error.
    await new Promise(r => setTimeout(r, 200))
    for (const c of [c1, c2, c3]) {
      expect(c.inbox.filter(m => m.type === 'error')).toEqual([])
    }

    c1.close()
    c2.close()
    c3.close()
  }, LONG_TIMEOUT)

  test('a freed middle slot is reused by the next registration', async () => {
    const proj = '/tmp/proj-reuse'
    const dir = trackDir(seedStateDir({
      projects: [
        { path: proj, topicId: 801, topicName: 'proj-reuse' },
        { path: `${proj}#2`, topicId: 802, topicName: 'proj-reuse (#2)' },
        { path: `${proj}#3`, topicId: 803, topicName: 'proj-reuse (#3)' },
      ],
    }))
    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    const c1 = await Client.connect(sock)
    c1.send({ type: 'register', projectPath: proj, topicLabel: 'proj-reuse' })
    await c1.await(m => m.type === 'registered', 8000)

    const c2 = await Client.connect(sock)
    c2.send({ type: 'register', projectPath: proj, topicLabel: 'proj-reuse' })
    await c2.await(m => m.type === 'registered', 8000)

    const c3 = await Client.connect(sock)
    c3.send({ type: 'register', projectPath: proj, topicLabel: 'proj-reuse' })
    await c3.await(m => m.type === 'registered', 8000)

    // Drop c2 (occupant of #2). Wait for the daemon to process the close.
    c2.close()
    await new Promise(r => setTimeout(r, 200))

    // Fourth shim registers → should claim #2, not jump to #4.
    const c4 = await Client.connect(sock)
    try {
      c4.send({ type: 'register', projectPath: proj, topicLabel: 'proj-reuse' })
      const r4 = await c4.await(m => m.type === 'registered', 8000) as { type: 'registered'; topicId: number; autoSuffix?: number }
      expect(r4.topicId).toBe(802)
      expect(r4.autoSuffix).toBe(2)
    } finally {
      c1.close()
      c3.close()
      c4.close()
    }
  }, LONG_TIMEOUT)

  test('labels.json entry for ${cwd}#N overrides the derived auto-suffix label', async () => {
    // Regression for the gap where the daemon auto-suffixed to #2 but
    // ignored the user's manually-set labels["${cwd}#2"] entry and used
    // the derived "${base} (#2)" instead.
    const proj = '/tmp/proj-explicit-label'
    const dir = trackDir(seedStateDir({
      projects: [
        { path: proj, topicId: 1001, topicName: 'proj-label' },
        { path: `${proj}#2`, topicId: 1002, topicName: 'platform ops agent' },
      ],
    }))
    // Seed labels.json with explicit names for both the bare path and #2.
    writeFileSync(
      join(dir, 'labels.json'),
      JSON.stringify({
        [proj]: 'app modules',
        [`${proj}#2`]: 'platform ops agent',
      }),
    )

    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    // Primary session registers first.
    const primary = await Client.connect(sock)
    primary.send({ type: 'register', projectPath: proj, topicLabel: 'app modules' })
    await primary.await(m => m.type === 'registered', 8000)

    // Secondary registers with the SAME base label — daemon should pick #2
    // and consult labels.json, not derive from the bare label.
    const secondary = await Client.connect(sock)
    secondary.send({ type: 'register', projectPath: proj, topicLabel: 'app modules' })
    const r = await secondary.await(m => m.type === 'registered', 8000) as {
      type: 'registered'; topicId: number; topicName: string; autoSuffix?: number
    }
    expect(r.autoSuffix).toBe(2)
    expect(r.topicId).toBe(1002)
    // Key assertion: used the labels.json entry, not the derived default.
    expect(r.topicName).toBe('platform ops agent')

    primary.close()
    secondary.close()
  }, LONG_TIMEOUT)

  test('auto-suffix label falls back to derived when labels.json has no override', async () => {
    // Companion test: when no labels entry exists for the #N key, the
    // daemon uses deriveAutoSuffixLabel(shimLabel, N) as before.
    const proj = '/tmp/proj-derived-label'
    const dir = trackDir(seedStateDir({
      projects: [
        { path: proj, topicId: 1101, topicName: 'proj-derived' },
        { path: `${proj}#2`, topicId: 1102, topicName: 'app modules (#2)' },
      ],
    }))
    writeFileSync(
      join(dir, 'labels.json'),
      JSON.stringify({ [proj]: 'app modules' }),
    )

    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    const primary = await Client.connect(sock)
    primary.send({ type: 'register', projectPath: proj, topicLabel: 'app modules' })
    await primary.await(m => m.type === 'registered', 8000)

    const secondary = await Client.connect(sock)
    secondary.send({ type: 'register', projectPath: proj, topicLabel: 'app modules' })
    const r = await secondary.await(m => m.type === 'registered', 8000) as {
      type: 'registered'; topicId: number; topicName: string; autoSuffix?: number
    }
    expect(r.autoSuffix).toBe(2)
    expect(r.topicName).toBe('app modules (#2)')

    primary.close()
    secondary.close()
  }, LONG_TIMEOUT)

  test('named instance does not participate in integer numbering', async () => {
    const proj = '/tmp/proj-named'
    const dir = trackDir(seedStateDir({
      projects: [
        { path: proj, topicId: 901, topicName: 'proj-named' },
        { path: `${proj}#foo`, topicId: 950, topicName: 'proj-named (foo)' },
        { path: `${proj}#2`, topicId: 902, topicName: 'proj-named (#2)' },
      ],
    }))
    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    // Named instance registers first — via explicit path.
    const named = await Client.connect(sock)
    named.send({ type: 'register', projectPath: `${proj}#foo`, topicLabel: 'proj-named (foo)' })
    const rNamed = await named.await(m => m.type === 'registered', 8000) as { type: 'registered'; topicId: number; autoSuffix?: number }
    expect(rNamed.topicId).toBe(950)
    expect(rNamed.autoSuffix).toBeUndefined() // explicit named, not auto-suffixed

    // Bare registers — should get the primary (slot 1), NOT skip to #2 because
    // of the named instance.
    const primary = await Client.connect(sock)
    primary.send({ type: 'register', projectPath: proj, topicLabel: 'proj-named' })
    const rPrim = await primary.await(m => m.type === 'registered', 8000) as { type: 'registered'; topicId: number; autoSuffix?: number }
    expect(rPrim.topicId).toBe(901)
    expect(rPrim.autoSuffix).toBeUndefined()

    // Next bare registers — should get #2 (skipping #foo), not #3.
    const second = await Client.connect(sock)
    second.send({ type: 'register', projectPath: proj, topicLabel: 'proj-named' })
    const rSec = await second.await(m => m.type === 'registered', 8000) as { type: 'registered'; topicId: number; autoSuffix?: number }
    expect(rSec.topicId).toBe(902)
    expect(rSec.autoSuffix).toBe(2)

    named.close()
    primary.close()
    second.close()
  }, LONG_TIMEOUT)
})

// ---------------------------------------------------------------------------
// Instance labeling — two sessions in the "same" project keyed by
// ${cwd}#${instance} get independent topics and do NOT evict each other.
// This mirrors the real flow when a user sets TELEGRAM_TOPICS_INSTANCE.
// ---------------------------------------------------------------------------

describe('instance coexistence', () => {
  test('primary (cwd) and instance-suffixed (cwd#exp) registrations coexist', async () => {
    const primary = { path: '/tmp/proj-x', topicId: 501, topicName: 'proj-x' }
    const secondary = { path: '/tmp/proj-x#exp', topicId: 502, topicName: 'proj-x (exp)' }
    const dir = trackDir(seedStateDir({ projects: [primary, secondary] }))
    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    const a = await Client.connect(sock)
    const b = await Client.connect(sock)
    try {
      a.send({ type: 'register', projectPath: primary.path, topicLabel: primary.topicName })
      b.send({ type: 'register', projectPath: secondary.path, topicLabel: secondary.topicName })
      const [ra, rb] = await Promise.all([
        a.await(m => m.type === 'registered', 8000),
        b.await(m => m.type === 'registered', 8000),
      ])
      expect((ra as { topicId: number }).topicId).toBe(501)
      expect((rb as { topicId: number }).topicId).toBe(502)
      // No eviction on either side.
      await new Promise(r => setTimeout(r, 200))
      expect(a.inbox.filter(m => m.type === 'error')).toEqual([])
      expect(b.inbox.filter(m => m.type === 'error')).toEqual([])
    } finally {
      a.close()
      b.close()
    }
  }, LONG_TIMEOUT)
})

// ---------------------------------------------------------------------------
// remove_topic — clears local state even when Telegram API fails (401 with
// our fake token), evicts any attached shim, and returns a success result.
// ---------------------------------------------------------------------------

describe('remove_topic', () => {
  test('removes a registered project and evicts its attached shim', async () => {
    const project = { path: '/tmp/proj-remove', topicId: 606, topicName: 'proj-remove' }
    const dir = trackDir(seedStateDir({ projects: [project] }))
    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    // Connect two clients: one registers for the project (the "victim"), the
    // other issues the remove_topic request.
    const victim = await Client.connect(sock)
    const requester = await Client.connect(sock)
    try {
      victim.send({ type: 'register', projectPath: project.path, topicLabel: project.topicName })
      await victim.await(m => m.type === 'registered', 8000)

      requester.send({ type: 'remove_topic', callId: 'rm-1', projectPath: project.path })
      const result = await requester.await(
        m => m.type === 'remove_topic_result' && m.callId === 'rm-1',
        10_000,
      ) as { type: 'remove_topic_result'; ok: boolean; message: string }

      // ok === true even though deleteForumTopic fails (fake token) — daemon
      // clears local state regardless so the user isn't stuck.
      expect(result.ok).toBe(true)
      expect(result.message).toMatch(/(deleted|cleared local state)/i)

      // topics.json no longer contains the entry.
      const topicsNow = JSON.parse(readFileSync(join(dir, 'topics.json'), 'utf8'))
      expect(topicsNow[project.path]).toBeUndefined()

      // Victim was evicted: received "topic removed" and its socket was ended.
      const [evictErr] = await Promise.all([
        victim.await(m => m.type === 'error' && /topic removed/i.test(m.message), 5000),
      ])
      expect(evictErr).toBeTruthy()
    } finally {
      victim.close()
      requester.close()
    }
  }, LONG_TIMEOUT)

  test('rename_topic updates topicName in topics.json even when Telegram API fails', async () => {
    // Same pattern as remove_topic's fake-token tolerance: editForumTopic will
    // 401 against our fake token, so we can't assert full success, but we CAN
    // assert the failure path returns ok=false and topics.json stays unchanged.
    const project = { path: '/tmp/proj-rename', topicId: 555, topicName: 'proj-rename' }
    const dir = trackDir(seedStateDir({ projects: [project] }))
    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    const client = await Client.connect(sock)
    try {
      client.send({
        type: 'rename_topic',
        callId: 'rn-1',
        projectPath: project.path,
        newName: 'New Shiny Name',
      })
      const result = await client.await(
        m => m.type === 'rename_topic_result' && m.callId === 'rn-1',
        10_000,
      ) as { type: 'rename_topic_result'; ok: boolean; message: string }

      // Fake token → Telegram API fails → ok=false
      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/Telegram API error/i)

      // topics.json unchanged — we only commit the new name after the API call succeeds
      const topicsNow = JSON.parse(readFileSync(join(dir, 'topics.json'), 'utf8'))
      expect(topicsNow[project.path].topicName).toBe('proj-rename')
    } finally {
      client.close()
    }
  }, LONG_TIMEOUT)

  test('rename_topic for an unknown project returns ok=false', async () => {
    const dir = trackDir(seedStateDir())
    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    const client = await Client.connect(sock)
    try {
      client.send({
        type: 'rename_topic',
        callId: 'rn-404',
        projectPath: '/tmp/nonexistent',
        newName: 'whatever',
      })
      const result = await client.await(
        m => m.type === 'rename_topic_result' && m.callId === 'rn-404',
        8000,
      ) as { type: 'rename_topic_result'; ok: boolean; message: string }
      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/no topic registered/i)
    } finally {
      client.close()
    }
  }, LONG_TIMEOUT)

  test('rename_topic with identical newName is a no-op (ok=true)', async () => {
    const project = { path: '/tmp/proj-noop-rename', topicId: 666, topicName: 'already-this-name' }
    const dir = trackDir(seedStateDir({ projects: [project] }))
    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    const client = await Client.connect(sock)
    try {
      client.send({
        type: 'rename_topic',
        callId: 'rn-noop',
        projectPath: project.path,
        newName: 'already-this-name',
      })
      const result = await client.await(
        m => m.type === 'rename_topic_result' && m.callId === 'rn-noop',
        5000,
      ) as { type: 'rename_topic_result'; ok: boolean; message: string }
      expect(result.ok).toBe(true)
      expect(result.message).toMatch(/nothing to rename/i)
    } finally {
      client.close()
    }
  }, LONG_TIMEOUT)

  test('remove_topic for an unknown project returns ok=false', async () => {
    const dir = trackDir(seedStateDir())
    track(spawnDaemon(dir))
    const sock = await waitForSocket(dir, 10_000)

    const client = await Client.connect(sock)
    try {
      client.send({ type: 'remove_topic', callId: 'rm-404', projectPath: '/tmp/does-not-exist' })
      const result = await client.await(
        m => m.type === 'remove_topic_result' && m.callId === 'rm-404',
        5000,
      ) as { type: 'remove_topic_result'; ok: boolean; message: string }
      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/no topic registered/i)
    } finally {
      client.close()
    }
  }, LONG_TIMEOUT)
})

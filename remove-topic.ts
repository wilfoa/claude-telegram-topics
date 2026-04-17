#!/usr/bin/env bun
/**
 * Standalone helper invoked from the `project remove-confirm` skill.
 *
 * Connects to the daemon's Unix socket, issues a remove_topic message for
 * the given projectPath, prints the result, and exits with code 0 on success
 * or non-zero on any failure. Not part of the MCP shim — no stdio handshake.
 */

import { join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'

import { parseMessages, serialize, type DaemonMessage, type ShimMessage } from './protocol'

const STATE_DIR = process.env.TELEGRAM_TOPICS_STATE_DIR
  ?? join(homedir(), '.claude/channels/telegram-topics')
const SOCKET_PATH = join(STATE_DIR, 'daemon.sock')

function usage(): never {
  process.stderr.write(`usage: remove-topic.ts <projectPath>\n`)
  process.exit(2)
}

const projectPath = process.argv[2]
if (!projectPath) usage()

if (!existsSync(SOCKET_PATH)) {
  process.stderr.write(`daemon socket not found at ${SOCKET_PATH} — start a Claude Code session first to spawn the daemon\n`)
  process.exit(3)
}

const callId = `remove-${process.pid}-${Date.now()}`
const msg: ShimMessage = { type: 'remove_topic', callId, projectPath }

let exitCode = 4 // unset → treat as hang
const timer = setTimeout(() => {
  process.stderr.write('timed out waiting for daemon response\n')
  process.exit(5)
}, 15_000)

await new Promise<void>((resolve, reject) => {
  let buffer = ''
  void Bun.connect<{ buffer: string }>({
    unix: SOCKET_PATH,
    socket: {
      open(s) {
        s.data = { buffer: '' }
        s.write(serialize(msg))
      },
      data(s, data) {
        buffer += typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
        const { messages, remainder } = parseMessages<DaemonMessage>(buffer)
        buffer = remainder
        for (const m of messages) {
          if (m.type === 'remove_topic_result' && m.callId === callId) {
            process.stdout.write(`${m.message}\n`)
            exitCode = m.ok ? 0 : 1
            try { s.end() } catch {}
            clearTimeout(timer)
            resolve()
            return
          }
          if (m.type === 'error') {
            // Registered-shim-side error surfacing; shouldn't normally hit
            // here because we never called register, but log defensively.
            process.stderr.write(`daemon error: ${m.message}\n`)
          }
        }
      },
      close() { resolve() },
      error(_s, err) {
        clearTimeout(timer)
        reject(err)
      },
    },
  }).catch(err => {
    clearTimeout(timer)
    reject(err)
  })
})

process.exit(exitCode)

#!/usr/bin/env bun
/**
 * Standalone helper invoked from the `configure topic` skill when a live
 * rename is requested (the user set a new label and wants Telegram to
 * reflect it right now, without restarting the session).
 *
 * Connects to the daemon's Unix socket, issues a rename_topic message for
 * the given projectPath + newName, prints the result, and exits with code
 * 0 on success or non-zero on any failure. Not part of the MCP shim — no
 * stdio handshake.
 */

import { join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'

import { parseMessages, serialize, type DaemonMessage, type ShimMessage } from './protocol'

const STATE_DIR = process.env.TELEGRAM_TOPICS_STATE_DIR
  ?? join(homedir(), '.claude/channels/telegram-topics')
const SOCKET_PATH = join(STATE_DIR, 'daemon.sock')

function usage(): never {
  process.stderr.write(`usage: rename-topic.ts <projectPath> <newName>\n`)
  process.exit(2)
}

const projectPath = process.argv[2]
const newName = process.argv[3]
if (!projectPath || !newName) usage()

if (!existsSync(SOCKET_PATH)) {
  process.stderr.write(
    `daemon socket not found at ${SOCKET_PATH} — label saved to labels.json; ` +
    `the rename will apply on the next Claude Code session\n`,
  )
  process.exit(0) // non-fatal: offline rename is still valid
}

const callId = `rename-${process.pid}-${Date.now()}`
const msg: ShimMessage = { type: 'rename_topic', callId, projectPath, newName }

let exitCode = 4
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
          if (m.type === 'rename_topic_result' && m.callId === callId) {
            process.stdout.write(`${m.message}\n`)
            exitCode = m.ok ? 0 : 1
            try { s.end() } catch {}
            clearTimeout(timer)
            resolve()
            return
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

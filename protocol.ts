/**
 * Daemon ↔ Shim protocol.
 * JSON messages over Unix socket, newline-delimited.
 */

// --- Shim → Daemon ---

export type RegisterMessage = {
  type: 'register'
  projectPath: string
  topicLabel: string
}

export type ToolCallMessage = {
  type: 'tool_call'
  callId: string
  tool: string
  args: Record<string, unknown>
}

export type PermissionVerdictMessage = {
  type: 'permission_verdict'
  requestId: string
  behavior: 'allow' | 'deny'
}

export type ForwardPermissionRequestMessage = {
  type: 'forward_permission_request'
  requestId: string
  toolName: string
  description: string
  inputPreview: string
}

export type RemoveTopicMessage = {
  type: 'remove_topic'
  callId: string
  projectPath: string
}

export type ShimMessage =
  | RegisterMessage
  | ToolCallMessage
  | PermissionVerdictMessage
  | ForwardPermissionRequestMessage
  | RemoveTopicMessage

// --- Daemon → Shim ---

export type RegisteredMessage = {
  type: 'registered'
  topicId: number
  topicName: string
  /**
   * Set to the integer N (>=2) when the daemon auto-assigned a secondary
   * instance slot `${cwd}#${N}` because the shim registered a bare path and
   * another shim was already live on it. Absent when the shim got the bare
   * path, or when it registered an explicit named instance like `#foo`.
   */
  autoSuffix?: number
}

export type InboundMessage = {
  type: 'inbound'
  content: string
  meta: Record<string, string>
}

export type ToolResultMessage = {
  type: 'tool_result'
  callId: string
  result: { content: Array<{ type: string; text: string }>; isError?: boolean }
}

export type PermissionRequestMessage = {
  type: 'permission_request'
  requestId: string
  toolName: string
  description: string
  inputPreview: string
}

export type PermissionVerdictForwardMessage = {
  type: 'permission_verdict_forward'
  requestId: string
  behavior: 'allow' | 'deny'
}

export type ErrorMessage = {
  type: 'error'
  message: string
}

export type RemoveTopicResultMessage = {
  type: 'remove_topic_result'
  callId: string
  ok: boolean
  message: string
}

export type DaemonMessage =
  | RegisteredMessage
  | InboundMessage
  | ToolResultMessage
  | PermissionRequestMessage
  | PermissionVerdictForwardMessage
  | ErrorMessage
  | RemoveTopicResultMessage

/**
 * Parse newline-delimited JSON from a buffer.
 * Returns parsed messages and any remaining incomplete data.
 */
export function parseMessages<T>(buffer: string): { messages: T[]; remainder: string } {
  const lines = buffer.split('\n')
  const remainder = lines.pop() ?? '' // last element is either empty or incomplete
  const messages: T[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      messages.push(JSON.parse(trimmed) as T)
    } catch {
      // skip malformed lines
    }
  }
  return { messages, remainder }
}

/** Serialize a message for the wire. */
export function serialize(msg: ShimMessage | DaemonMessage): string {
  return JSON.stringify(msg) + '\n'
}

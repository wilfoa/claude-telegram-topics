import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import {
  loadAccess, saveAccess, defaultAccess,
  loadTopics, saveTopics,
  loadToken, saveToken, clearToken,
  readPid, writePid, clearPid,
  type Access, type TopicMap,
} from './state'

const TEST_DIR = join(import.meta.dir, '.test-state')

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('access', () => {
  test('returns defaults when file missing', () => {
    const a = loadAccess(TEST_DIR)
    expect(a.dmPolicy).toBe('pairing')
    expect(a.allowFrom).toEqual([])
    expect(a.pending).toEqual({})
  })

  test('round-trips access.json', () => {
    const a = defaultAccess()
    a.allowFrom = ['123']
    a.dmPolicy = 'allowlist'
    saveAccess(a, TEST_DIR)
    const loaded = loadAccess(TEST_DIR)
    expect(loaded.dmPolicy).toBe('allowlist')
    expect(loaded.allowFrom).toEqual(['123'])
  })
})

describe('topics', () => {
  test('returns empty map when file missing', () => {
    const t = loadTopics(TEST_DIR)
    expect(t).toEqual({})
  })

  test('round-trips topics.json', () => {
    const topics: TopicMap = {
      '/home/user/project': { topicId: 42, topicName: 'my-project' },
    }
    saveTopics(topics, TEST_DIR)
    const loaded = loadTopics(TEST_DIR)
    expect(loaded['/home/user/project']?.topicId).toBe(42)
    expect(loaded['/home/user/project']?.topicName).toBe('my-project')
  })
})

describe('token', () => {
  test('returns undefined when .env missing', () => {
    expect(loadToken(TEST_DIR)).toBeUndefined()
  })

  test('saves and loads token', () => {
    saveToken('123:AAH_test', TEST_DIR)
    expect(loadToken(TEST_DIR)).toBe('123:AAH_test')
  })

  test('clearToken removes the token line', () => {
    saveToken('123:AAH_test', TEST_DIR)
    clearToken(TEST_DIR)
    expect(loadToken(TEST_DIR)).toBeUndefined()
  })
})

describe('pid', () => {
  test('returns undefined when file missing', () => {
    expect(readPid(TEST_DIR)).toBeUndefined()
  })

  test('round-trips pid', () => {
    writePid(12345, TEST_DIR)
    expect(readPid(TEST_DIR)).toBe(12345)
  })

  test('clearPid removes the file', () => {
    writePid(12345, TEST_DIR)
    clearPid(TEST_DIR)
    expect(readPid(TEST_DIR)).toBeUndefined()
  })
})

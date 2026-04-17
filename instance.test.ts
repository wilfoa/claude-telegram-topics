import { describe, expect, test } from 'bun:test'
import { deriveAutoSuffixLabel, parseInstanceSuffix, pickAutoInstance } from './instance'

describe('parseInstanceSuffix', () => {
  test('returns 1 for the bare basePath', () => {
    expect(parseInstanceSuffix('/a/b', '/a/b')).toBe(1)
  })

  test('returns N for #N suffix with positive integer', () => {
    expect(parseInstanceSuffix('/a/b#2', '/a/b')).toBe(2)
    expect(parseInstanceSuffix('/a/b#17', '/a/b')).toBe(17)
  })

  test('returns null for non-integer suffixes', () => {
    expect(parseInstanceSuffix('/a/b#foo', '/a/b')).toBeNull()
    expect(parseInstanceSuffix('/a/b#2foo', '/a/b')).toBeNull()
  })

  test('returns null for leading-zero or signed numerics', () => {
    expect(parseInstanceSuffix('/a/b#02', '/a/b')).toBeNull()
    expect(parseInstanceSuffix('/a/b#-1', '/a/b')).toBeNull()
    expect(parseInstanceSuffix('/a/b#0', '/a/b')).toBeNull()
  })

  test('returns null for empty suffix', () => {
    expect(parseInstanceSuffix('/a/b#', '/a/b')).toBeNull()
  })

  test('returns null for unrelated path', () => {
    expect(parseInstanceSuffix('/a/c', '/a/b')).toBeNull()
    expect(parseInstanceSuffix('/a/bc', '/a/b')).toBeNull()
  })

  test('handles basePath that itself contains `#`', () => {
    // Not a real case, but the suffix parser is local to basePath semantics.
    expect(parseInstanceSuffix('/a/b#1#2', '/a/b#1')).toBe(2)
  })
})

describe('pickAutoInstance', () => {
  test('picks N=1 (bare path) when nothing is live', () => {
    const r = pickAutoInstance('/a/b', [])
    expect(r).toEqual({ effectivePath: '/a/b', instance: 1 })
  })

  test('picks #2 when bare is live', () => {
    expect(pickAutoInstance('/a/b', ['/a/b'])).toEqual({ effectivePath: '/a/b#2', instance: 2 })
  })

  test('picks #3 when bare and #2 are live', () => {
    expect(pickAutoInstance('/a/b', ['/a/b', '/a/b#2'])).toEqual({
      effectivePath: '/a/b#3',
      instance: 3,
    })
  })

  test('reuses a dead slot: #1 live, #2 freed, #3 live → picks #2', () => {
    expect(pickAutoInstance('/a/b', ['/a/b', '/a/b#3'])).toEqual({
      effectivePath: '/a/b#2',
      instance: 2,
    })
  })

  test('reuses the primary when it is freed: #2 live, #3 live, bare freed → picks 1', () => {
    expect(pickAutoInstance('/a/b', ['/a/b#2', '/a/b#3'])).toEqual({
      effectivePath: '/a/b',
      instance: 1,
    })
  })

  test('ignores named (non-integer) instances when numbering', () => {
    // #foo and #exp exist live but do not occupy integer slots.
    const r = pickAutoInstance('/a/b', ['/a/b#foo', '/a/b#exp'])
    expect(r).toEqual({ effectivePath: '/a/b', instance: 1 })
  })

  test('named instances + integer auto-suffix coexist in the live set', () => {
    // Bare and #2 taken; #foo is a named instance and should not affect counting.
    const r = pickAutoInstance('/a/b', ['/a/b', '/a/b#foo', '/a/b#2'])
    expect(r).toEqual({ effectivePath: '/a/b#3', instance: 3 })
  })

  test('ignores live paths for other projects', () => {
    const r = pickAutoInstance('/a/b', ['/other/path', '/other/path#2', '/a/bc', '/a/b-other'])
    expect(r).toEqual({ effectivePath: '/a/b', instance: 1 })
  })
})

describe('deriveAutoSuffixLabel', () => {
  test('returns the bare label for instance 1', () => {
    expect(deriveAutoSuffixLabel('My Project', 1)).toBe('My Project')
  })

  test('appends (#N) for instance 2+', () => {
    expect(deriveAutoSuffixLabel('My Project', 2)).toBe('My Project (#2)')
    expect(deriveAutoSuffixLabel('proj-a', 7)).toBe('proj-a (#7)')
  })
})

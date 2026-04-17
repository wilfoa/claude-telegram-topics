/**
 * Auto-instance selection.
 *
 * When a shim registers with a bare `projectPath` (no `#<instance>` suffix),
 * the daemon needs to decide whether to give it the primary topic for that
 * path or auto-assign the next free integer instance slot.
 *
 * Convention:
 *   N=1 → the bare `projectPath` (primary topic)
 *   N=2 → `${projectPath}#2`
 *   N=3 → `${projectPath}#3`
 *   …
 *
 * Named instances from `TELEGRAM_TOPICS_INSTANCE=foo` produce `${path}#foo`
 * and are orthogonal to integer auto-suffixes — `#foo` does not participate
 * in the integer numbering. This keeps user-chosen names stable across
 * sessions even if other auto-suffixed instances come and go.
 */

/**
 * Returns the integer instance for a registered `projectPath` relative to a
 * `basePath`:
 *   - 1 if `projectPath === basePath`
 *   - N>=1 if `projectPath === `${basePath}#${N}`` and N is a pure integer
 *   - null otherwise (non-matching path, or non-integer suffix like `#foo`)
 */
export function parseInstanceSuffix(projectPath: string, basePath: string): number | null {
  if (projectPath === basePath) return 1
  const prefix = basePath + '#'
  if (!projectPath.startsWith(prefix)) return null
  const suffix = projectPath.slice(prefix.length)
  // Reject empty, leading-zero ("02"), signed ("-1"), and non-numeric.
  if (!/^[1-9]\d*$/.test(suffix)) return null
  return parseInt(suffix, 10)
}

/**
 * Pick the lowest unused integer instance slot for `basePath`, given the
 * set of currently-live projectPaths held by connected shims.
 *
 * Reuse-friendly: if instance #2 exited leaving its entry in `topics.json`
 * but no shim is currently bound to it, a new caller can claim #2 again
 * rather than jumping to #3. Integer allocation is driven entirely by
 * *live* registrations; the known-set (topics.json contents) is informational
 * and intentionally not consulted here.
 */
export function pickAutoInstance(
  basePath: string,
  liveProjectPaths: Iterable<string>,
): { effectivePath: string; instance: number } {
  const liveInts = new Set<number>()
  for (const p of liveProjectPaths) {
    const n = parseInstanceSuffix(p, basePath)
    if (n !== null) liveInts.add(n)
  }
  for (let n = 1; ; n++) {
    if (!liveInts.has(n)) {
      return {
        effectivePath: n === 1 ? basePath : `${basePath}#${n}`,
        instance: n,
      }
    }
  }
}

/**
 * Derive the topic label for an auto-suffixed instance from the label the
 * shim would have gotten for the bare path. Instance 1 keeps the bare label.
 */
export function deriveAutoSuffixLabel(baseLabel: string, instance: number): string {
  return instance === 1 ? baseLabel : `${baseLabel} (#${instance})`
}

/**
 * Resolve the target projectPath for a rename initiated by a running shim.
 *
 * Without an explicit instance override, use the shim's own registered
 * projectPath — so a session that the daemon auto-suffixed to `#2` renames
 * its OWN topic, not the primary. This is the core invariant: the skill
 * can't know the shim's effective path (cwd alone is ambiguous once auto-
 * suffix is in play), so the decision has to route through the shim.
 *
 * With an explicit instance, compute `${cwd}#${instance}`. `"1"` (or an
 * empty string) collapses to the bare cwd — the primary slot. Any other
 * value is used verbatim as the suffix; the daemon-side rename handler is
 * the final authority on whether that projectPath actually exists.
 */
export function resolveRenameTargetPath(
  cwd: string,
  myProjectPath: string,
  instance: string | undefined,
): string {
  if (instance === undefined || instance === null) return myProjectPath
  const trimmed = String(instance).trim()
  if (trimmed === '' || trimmed === '1') return cwd
  return `${cwd}#${trimmed}`
}

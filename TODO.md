# pi-edit — Fix Todo

Merged from two independent reviews (2026-06-17). Sources: `CODE_REVIEW.md` (ours), `REVIEW_FINDINGS.md` (theirs).

---

## P0 — Correctness bugs (fix before any merge)

- [ ] **`diagLine` regex never matches ESLint or ruff output** (`src/index.ts:395`)
  Post-edit diagnostics are silenced for all files. ESLint compact uses `line 10, col 5` (comma); ruff concise uses `file:1:5:` (no keywords). `hasDiagShape` is always `false`.
  Fix: discriminate by exit code, not output shape. Or update regex to `/^(\S+:\s*line\s+\d+,?\s+col\s+\d+|\S+:\d+:\d+:)/i`.

- [ ] **`mtimeMs: -1` sentinel causes TOCTOU gate to open on double stat failure** (`src/index.ts:106`)
  Non-ENOENT stat errors at both read-time and edit-time produce `mtimeMs: -1` twice. `isStale` compares `-1 === -1` → not stale → gate passes. Agent edits a file it never read.
  Fix: use a discriminated union (`{ kind: 'ok' | 'error' }`); treat `kind === 'error'` on either side as stale.

- [ ] **Failed `read` events fall into schema-recovery branch and can be downgraded to `isError: false`** (`src/index.ts:505`)
  A failed read (wrong key) skips the read-tracking block, hits the `isError` block, and may return `{ isError: false }` without calling `rememberRead`. Agent sees phantom success, next edit is blocked, re-reading produces the same phantom — permanent deadlock for that file.
  Fix: never flip `isError → false` for a `read` event unless `rememberRead` was also called.

---

## P1 — Should fix before merge

- [ ] **`event.content` cast to array without null/undefined guard** (`src/index.ts:506`, `538`, `568`)
  Pi can emit `isError: true` with `content: undefined`. `.filter()` on `undefined` throws `TypeError` and crashes the handler for all subsequent events.
  Fix: `const blocks = Array.isArray(event.content) ? event.content : [];` before the filter chain.

- [ ] **`isSafeTarget` blocklist is incomplete when `cwd` is undefined** (`src/index.ts:265`)
  Only `/etc`, `/bin`, `/sbin`, `/usr`, `/lib`, `/var`, `/boot`, `/root` are blocked. `/tmp`, `/home`, `/opt`, `/run` etc. are permitted. Any Pi session started without a working directory has a weak bash guard.
  Fix: block all absolute paths when `cwd` is unknown — `return !target.startsWith("/")`.

- [ ] **`diagLastRunAt` Map has no eviction cap — unbounded growth** (`src/index.ts`, inside `createDiagState`)
  Every edited file gets a permanent timestamp entry. All other bounded maps in the file have caps (512 for `readState`, 256 for `partialReadWarnAt`). Long sessions touching thousands of files leak memory.
  Fix: add `MAX_DIAG_ENTRIES = 512` with the same LRU eviction used in `rememberRead`.

- [ ] **Hardcoded absolute path in test** (`tests/classify-bash.test.ts:170`)
  `readFileSync("/Users/yeshao/headroom/pi-edit/src/index.ts")` fails with `ENOENT` on any machine other than the original author's (and even there the path differs from the current repo location).
  Fix: `readFileSync(join(__dirname, "../src/index.ts"), "utf-8")`.

- [ ] **Test file reimplements old `classifyBash` — new code has zero coverage** (`tests/classify-bash.test.ts`)
  The test ships its own copy using the removed `MUTATING_BASH`/`FILE_REDIRECT`/`FILE_TEE` patterns. `stripQuotedStrings`, `extractRedirectTargets`, `isSafeTarget`, `dd`/`truncate`/`cp`/`mv` patterns, and the `cwd` boundary check are all untested.
  Fix: import the real `classifyBash` (or extract + export it) and rewrite the tests against the actual implementation.

---

## P2 — Low risk, informational

- [ ] **`SCHEMA_ERROR_PATTERNS` likely never match real AJV v8 output** (`src/index.ts:423`)
  Pattern 1 uses lowercase `not`; AJV v8 emits uppercase `NOT`. Pattern 2 uses plural `properties`; AJV v8 uses singular `property`. Recovery hints are silently suppressed.
  Fix: add `/i` flag and broaden the patterns — or better, normalise `file`/`file_path` → `path` in a `tool_call` hook to avoid the problem entirely.

- [ ] **`contentHashOf` memo is per-record, not per-path** (`src/index.ts:115`)
  Two concurrent paths that each call `snapshotFile` for the same file get two `ReadRecord` objects; the Promise-based dedup lives on the instance, so both fire `readFile`. The JSDoc ("prevents duplicate reads") overstates the guarantee.
  Fix: update the JSDoc to say "deduplicates within a single record"; optionally add a path-keyed in-flight map at the module level.

- [ ] **`isStale` mtime-only fallback is a fragile implicit invariant** (`src/index.ts:151`)
  When `contentHash` is absent, staleness falls back to mtime comparison — unreliable on HFS+ (1 s granularity). Currently safe because the read handler always calls `contentHashOf` before `rememberRead`, but that invariant is nowhere stated. A future change that skips hashing silently degrades TOCTOU protection.
  Fix: add a comment asserting the invariant at the `rememberRead` call site, or enforce it structurally.

- [ ] **Schema recovery return-value contract is undocumented** (`src/index.ts:536`)
  The merged handler returns a modified event to inject recovery hints, relying on Pi's `pi.on()` to propagate async return values. If the runtime uses last-write-wins or ignores async returns, hints are silently lost.
  Fix: add a comment citing the Pi runtime contract, or test it experimentally and link the result.

---

## Closed

| ID | Finding | Resolution |
|----|---------|------------|
| T1 | 18 TypeScript errors from minimal type stubs | Fixed: added `ToolResultEvent`, `ToolCallEvent`, overloaded `on()` in `types/pi-coding-agent.ts` |
| R1 | Tests assert old flag names (`no-readguard` etc.) | False alarm: `toContain` substring-matches `"pi-edit-no-readguard"` |

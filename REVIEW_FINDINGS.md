# pi-edit Code Review Findings

> Generated 2026-06-17. Review of 5 changed files (+423/-171 lines).

## Closed

| # | Finding | Resolution |
|---|---------|------------|
| T1 | 18 TypeScript errors from minimal type stubs | Fixed: added `ToolResultEvent`, `ToolCallEvent`, overloaded `on()` signatures in `types/pi-coding-agent.ts` |
| R1 | Source invariant tests assert old flag names | False alarm: `toContain` does substring matching so `"pi-edit-no-readguard"` matches `"no-readguard"` |

---

## Open

### P1 — Worth fixing before merge

#### 1. `diagLastRunAt` Map has no eviction cap — unbounded growth

**File:** `src/index.ts:354-412` (`createDiagState`)

`diagLastRunAt` records the last diagnostic run timestamp per absolute path but has no LRU cap. Every edited file gets a permanent entry. Long sessions touching thousands of files = unbounded growth.

Other maps in the same codebase all have caps: `readState` at 512, `partialReadWarnAt` at 256. This is an inconsistency.

**Suggested fix:** Add `MAX_DIAG_ENTRIES = 512` and evict oldest entry when exceeded, matching the `rememberRead` pattern.

---

#### 2. Schema recovery casts `event.content` to array without guard

**File:** `src/index.ts:506`

```ts
const errorText = (event.content as Array<{ type: string; text?: string }>)
    .filter(...)
```

The `as` assertion is not a runtime check. If Pi ever emits an error event where `content` is `undefined`, a string, or non-array, `.filter()` throws — crashing the entire `tool_result` handler for all subsequent events.

**Suggested fix:** Add `if (!Array.isArray(event.content)) return undefined;` before the filter chain.

---

#### 3. Hardcoded absolute path in test file

**File:** `tests/classify-bash.test.ts:170`

```ts
const src = readFileSync("/Users/yeshao/headroom/pi-edit/src/index.ts", "utf-8");
```

Only works on the original author's machine. Fails with ENOENT for any other developer or CI.

**Suggested fix:** Use `readFileSync(join(__dirname, "../src/index.ts"), "utf-8")`.

---

#### 4. No test coverage for new classifyBash features

**File:** `tests/classify-bash.test.ts`

The test file contains its own copy of `classifyBash` that uses the old `MUTATING_BASH` / `FILE_REDIRECT` / `FILE_TEE` patterns. It tests itself, not the real implementation. New features have zero coverage:

- Quote stripping (`stripQuotedStrings`)
- Redirect target extraction (`extractRedirectTargets`)
- INHERENTLY_MUTATING patterns: `dd`, `truncate`, `cp`, `mv`, `install`
- `isSafeTarget` with `cwd` parameter
- cwd-aware project boundary check

**Suggested fix:** Rewrite the local `classifyBash` to match the new implementation, or import the real function. Add tests for the new patterns.

---

### P2 — Low risk, informational

#### 5. `contentHashOf` memoization is per-record, not per-path

**File:** `src/index.ts:115-131`

Promise-based memo deduplicates within a single `ReadRecord` object, but `snapshotFile()` creates a new record each call. Concurrent reads of the same file via separate records still duplicate `readFile()` work. Not a correctness bug, but the JSDoc ("prevents duplicate reads") overstates the guarantee.

---

#### 6. `isStale` mtime-only fallback is a fragile implicit invariant

**File:** `src/index.ts:151-163`

When `contentHash` is undefined, staleness falls back to mtime comparison — unreliable on HFS+ (1s granularity). Currently safe because the read handler always calls `contentHashOf` before `rememberRead`, but this invariant is implicit. A future change that skips `contentHashOf` in the read handler silently degrades TOCTOU protection.

---

#### 7. Schema recovery return value may be ignored by Pi runtime

**File:** `src/index.ts:536-542`

The merged `tool_result` handler design (justified at line 475) ensures read tracking can't be silently dropped. But the schema recovery path has the same return-value assumption — if Pi's `pi.on()` ignores async handler return values, the recovery hints are silently lost. This is a contract assumption worth documenting.

---

## Summary

| Priority | Count | Verdict |
|----------|-------|---------|
| P1 | 4 | Fix before merge |
| P2 | 3 | Nice to have |

**P1 quick wins** (#1 and #2) are ~5 line changes each. **P3** (test portability) is a one-liner. **P4** (test coverage) is the largest item — requires rewriting the test file's local `classifyBash` to match the new implementation.

# Code Review — pi-edit working-tree diff

**Date:** 2026-06-17  
**Scope:** uncommitted changes in `src/index.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`  
**Effort:** high (8 finder angles × 6 candidates → 1-vote verify, recall-biased)

---

## Findings

### 1. `diagLine` regex never matches ESLint or ruff output — diagnostics silenced

**File:** `src/index.ts:395`  
**Severity:** High — feature entirely dead

The filter regex `/^\s*(?:\S+\s+)?line\s+\d+\s+col\s+\d+/i` was added to distinguish real lint output from tool-crash noise. It requires `\s+` (whitespace) between the digit and `col`, but:

- **ESLint compact** emits `src/foo.ts: line 10, col 5, Error - …` — comma after the digit, not whitespace.
- **ruff concise** emits `file.py:1:5: E501 …` — no `line`/`col` keywords at all.

`hasDiagShape` is always `false` for both tools, so `runDiagnostics` always returns `undefined` and no post-edit lint feedback is ever surfaced.

**Fix:** Use exit code as the primary discriminator (eslint/ruff exit 1 for findings, 0 for clean) and surface `stdout`/`stderr` directly on non-zero exits. If output-shape filtering is still wanted, cover both formats:

```ts
const diagLine = /^(\S+:\s*line\s+\d+,?\s+col\s+\d+|\S+:\d+:\d+:)/i;
```

---

### 2. `mtimeMs: -1` sentinel causes TOCTOU gate to open on double stat failure

**File:** `src/index.ts:106`  
**Severity:** High — TOCTOU bypass

`snapshotFile` returns `{ mtimeMs: -1, absPath, fullRead }` for any stat error other than `ENOENT`. That object is truthy, so the read-tracking handler stores it via `rememberRead`. On the subsequent edit gate check, `snapshotFile` is called again; if it also fails, `current.mtimeMs` is again `-1`. In `isStale`:

1. `record.contentHash` is `undefined` (because `contentHashOf` also failed and returned `undefined` without setting `contentHash`).
2. Falls back to mtime comparison: `-1 === -1` → `isStale` returns `false`.
3. Gate passes — the agent edits a file it never successfully read.

**Fix:** Use a discriminated union instead of a magic number so two error sentinels can be distinguished from two valid-but-equal mtimes:

```ts
type Snapshot =
  | { kind: 'ok'; mtimeMs: number; absPath: string; fullRead: boolean; contentHash?: string }
  | { kind: 'error'; absPath: string; fullRead: boolean };
```

In `isStale`, treat `kind === 'error'` on either side as stale (fail closed).

---

### 3. Failed `read` events fall into the schema-recovery branch, producing a phantom success

**File:** `src/index.ts:505`  
**Severity:** High — agent deadlock

The merged `tool_result` handler's first block gates on `event.toolName === "read" && !event.isError`, so a failed read (e.g. `isError: true` because the model used `file_path` instead of `path`) falls straight into the `if (event.isError)` block. If `isSchemaValidationError` matches and `usedWrongKey` is true, the handler returns `{ isError: false }` — a synthetic success. `rememberRead` was never called, so `readState` has no entry for the file. The agent's next edit is blocked by "you must read first", and re-reading produces another phantom success — the agent cannot escape.

**Fix:** Guard the schema-recovery block against `toolName === "read"` when downgrading `isError` to `false`: only flip `isError` for read if a snapshot was also successfully stored, or keep `isError: true` for reads and only inject the hint text.

---

### 4. `event.content` accessed without null/undefined guard

**File:** `src/index.ts:506`  
**Severity:** Medium — crash

Line 506 casts `event.content` directly to `Array<…>` and calls `.filter()` with no prior null check:

```ts
const errorText = (event.content as Array<{ type: string; text?: string }>)
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
```

Pi can emit a `tool_result` with `isError: true` but `content` absent (quota exceeded, internal timeout, etc.). Calling `.filter()` on `undefined` throws `TypeError`, crashing the handler. The same unguarded spread appears at lines 538 and 568.

**Fix:**

```ts
const blocks = Array.isArray(event.content) ? event.content : [];
const errorText = (blocks as Array<{ type: string; text?: string }>)
    .filter(...)
```

---

### 5. `isSafeTarget` blocklist is incomplete when `cwd` is undefined

**File:** `src/index.ts:265`  
**Severity:** Medium — bash guard bypass

When `ctx.cwd` is undefined, `isSafeTarget` only blocks paths matching `/^\/(etc|bin|sbin|usr|lib|var|boot|root)\b/` and returns `true` for everything else. Paths like `/tmp/exfil`, `/home/user/.ssh/authorized_keys`, `/opt/secrets`, `/run/secrets` are all considered safe.

**Fix:** Fail closed when `cwd` is unknown — block all absolute paths that are not in `NON_FILE_TARGET`:

```ts
if (!cwd) {
    // Can't verify containment without a working directory; block all absolute paths.
    return !target.startsWith("/");
}
```

---

### 6. `SCHEMA_ERROR_PATTERNS` may never match real Pi/AJV error messages

**File:** `src/index.ts:423`  
**Severity:** Medium (Plausible) — recovery hints silently suppressed

```ts
const SCHEMA_ERROR_PATTERNS = [
    /\broot: must not have additional properties\b/,
    /\bpath: must have required properties path\b/,
];
```

- AJV v8 emits `"must NOT have additional properties"` (uppercase `NOT`); pattern 1 uses lowercase `not`.
- AJV v8 emits `"must have required property 'path'"` (singular `property`); pattern 2 uses plural `properties`.

If Pi serialises AJV errors without reformatting them, `isSchemaValidationError` always returns `false` and no recovery hints are ever injected.

**Fix:** Either match case-insensitively (`/i` flag) and cover both singular/plural, or — better — handle this upstream in a `tool_call` hook that normalises `file`/`file_path` → `path` before the tool is invoked, eliminating the need for output-side pattern matching entirely.

---

## Refuted candidates

| Candidate | Reason |
|-----------|--------|
| `sed` regex false-positives on `/init/p` etc. | `stripQuotedStrings` blanks the single-quoted script before the regex runs; `-i` inside the script is gone before matching. |
| `isStale` always-hash is a performance regression | Explicitly documented in the code comment as an intentional design decision for coarse-granularity filesystems. |

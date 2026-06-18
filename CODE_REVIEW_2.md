# Code Review — post-fix pass

**Date:** 2026-06-17  
**Scope:** working-tree changes after first round of fixes  
**Prior review:** `CODE_REVIEW.md`

---

## Fix status from round 1

| Item | Status |
|------|--------|
| `diagLine` regex broken | ✅ Fixed — `hasDiagShape` removed, exit code used as discriminator |
| `mtimeMs: -1` TOCTOU gate opens | ✅ Fixed — `-1` sentinel guard in both branches of `isStale` |
| Failed read → schema deadlock | ✅ Fixed — `read` events no longer downgraded to `isError: false` |
| `event.content` null guard crash | ✅ Fixed — `Array.isArray` guard at lines 501, 536, 566 |
| `isSafeTarget` incomplete blocklist | ✅ Fixed — blocks all absolute paths when `cwd` is absent |
| `diagLastRunAt` eviction cap | ✅ Fixed — `MAX_DIAG_ENTRIES = 512` + eviction in `finally` |
| Hardcoded test path | ✅ Fixed — now uses `join(__dirname, ...)` |
| Test ships own `classifyBash` copy | ❌ Still open — real function never imported or tested |

---

## New findings

### 1. `SCHEMA_ERROR_PATTERNS` pattern 2 still never matches AJV v8 output

**File:** `src/index.ts:422`  
**Severity:** High — schema recovery for missing `path` param silently never fires

The updated pattern is:
```ts
/\bpath:\s+must\s+have\s+required\s+propert(?:y|ies)\s+path\b/i
```

AJV v8 emits: `must have required property 'path'` (single-quoted property name).

After `propert(?:y|ies)` matches `property`, `\s+` consumes the space, then the pattern expects the letter `p` — but the actual string has a single-quote: ` 'path'`. The `'` is not matched and the regex fails. JavaScript cannot backtrack further because `\s+` requires at least one whitespace and the space is already consumed.

**Fix:** Allow an optional quote before the property name:
```ts
/\bpath:\s+must\s+have\s+required\s+propert(?:y|ies)\s+['"]?path['"]?\b/i
```

---

### 2. `tee --append` — real write target escapes bash guard (false negative)

**File:** `src/index.ts:245`  
**Severity:** Medium — an absolute-path write via `tee --append` is never inspected

The flag-skip in `extractRedirectTargets` only handles the short form `-a`:
```ts
if (command[i] === "-" && command[i + 1] === "a") {
    i += 2;
    ...
}
```

For `cmd | tee --append /etc/passwd`:
- `command[i]` is `-`, `command[i+1]` is `-` (not `a`) → skip does not fire
- `captureTarget` is called at `--append`, reads until whitespace → returns `--append`
- `isSafeTarget("--append", cwd)` resolves it as a relative path → safe → no block
- `/etc/passwd` (the real write target) is never examined

This is a false **negative**: the dangerous absolute path escapes inspection entirely.

**Fix:** Skip any flag-looking token (starts with `-`) before reading the target:
```ts
// Skip flag arguments (-a, --append, --ignore-interrupts, etc.)
while (i < command.length && command[i] === "-") {
    let end = i;
    while (end < command.length && !/\s/.test(command[end])) end++;
    i = end;
    while (i < command.length && command[i] === " ") i++;
}
```

---

### 3. `isStale` blocks with a misleading "changed on disk" message on transient I/O errors

**File:** `src/index.ts:160` + `src/index.ts:622`  
**Severity:** Medium — agent loops re-reading an unreadable file

When `record.contentHash` is defined and `hashFileAt(current.absPath)` returns `undefined` (EACCES, EIO, EMFILE — not a content change), line 161 returns `true` (stale). The tool_call handler at line 622 blocks with:

> `"<path> has changed on disk since you last read it (external edit, linter, or another process)."`

The file is unchanged. The agent re-reads it, hits the same I/O error, and loops indefinitely while being told something external modified the file.

**Fix:** Distinguish the two failure modes in the block reason. One approach: have `hashFileAt` return a sentinel that `isStale` can propagate, and in the tool_call handler emit a different message when the cause is an unreadable file rather than a detected change:

```ts
// in tool_call handler, after isStale:
reason:
    `${path} could not be verified as unchanged (read error). ` +
    `Re-read it before editing to confirm the current contents.`,
```

---

### 4. `runDiagnostics` cannot distinguish lint errors (exit 1) from tool crashes (exit 2+)

**File:** `src/index.ts:387`  
**Severity:** Low-Medium — agent may treat crash banners as lint output

`hasDiagShape` was correctly removed (it never matched real output). The replacement forwards all non-zero exit output uniformly:

```ts
if (code === 0) return undefined;
const out = `${stdout}\n${stderr}`.trim();
if (!out) return undefined;
return out.split("\n").slice(0, 30).join("\n");
```

eslint exits 1 for lint findings and 2 for fatal config/parse errors. A missing `ruff` binary exits 127. `npx --no-install` with a missing package emits "Oops! Something went wrong!". All are forwarded identically. An agent receiving a JS stack trace or "command not found" may attempt code fixes for a tooling setup problem.

**Fix:** Gate on the expected "lint findings" exit code per runner:
```ts
// Only exit code 1 means "lint findings found" for eslint and ruff.
// Any other non-zero exit is a tool crash or config error — suppress it.
if (code !== 1) return undefined;
```

---

### 5. `isSafeTarget` blocks all absolute-path redirects when `cwd` is undefined

**File:** `src/index.ts:273`  
**Severity:** Low — legitimate `/tmp` writes may be blocked in stateless Pi sessions

The fix (`return !target.startsWith("/")`) is correct from a security standpoint but more aggressive than before: it blocks `/tmp/build.log`, `/var/tmp/results.txt`, and similar patterns commonly used to capture tool output. If Pi can be invoked without a working directory, those commands are rejected with a misleading "redirect into a file outside the project" message.

**Fix options:**
- Extend `NON_FILE_TARGET` to also cover scratch directories:
  ```ts
  const NON_FILE_TARGET = /^(?:\/dev\/|\/proc\/|\/sys\/|\/tmp\/|\/var\/tmp\/)/;
  ```
- Or document that `cwd` must always be set and make the type non-optional (enforces it at the call site).

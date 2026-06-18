# Code Review — post-fix pass 3

**Date:** 2026-06-18  
**Prior review:** `CODE_REVIEW_3.md`

---

## Fix status from round 3

| Item | Status |
|------|--------|
| `isStale` discriminated union (`"fresh" \| "changed" \| "unreadable"`) | ✅ Fixed — `StaleResult` type at line 165; caller at lines 636–643 |
| `/tmp` NON_FILE_TARGET comment | ✅ Added — line 192–194 |

### `isStale` fix verified

```ts
// line 165–178
type StaleResult = "fresh" | "changed" | "unreadable";
async function isStale(record: ReadRecord, current: ReadRecord): Promise<StaleResult> {
    if (record.contentHash !== undefined) {
        const now = await hashFileAt(current.absPath);
        if (now === undefined) return "unreadable";          // ← was: return true
        return record.contentHash !== now ? "changed" : "fresh";
    }
    if (record.mtimeMs === -1 || current.mtimeMs === -1) return "unreadable";
    return record.mtimeMs !== current.mtimeMs ? "changed" : "fresh";
}

// caller at line 636–644
if (stale !== "fresh") {
    readState.delete(abs);
    const reason =
        stale === "unreadable"
            ? `${path} could not be verified as unchanged (read error)...`
            : `${path} has changed on disk since you last read it...`;
    return { block: true, reason };
}
```

Correct on all three paths. ✅

---

## New findings

### 1. `write` tool on an unread existing file crashes at `record!`

**File:** `src/index.ts:624–635`  
**Severity:** Medium — runtime TypeError crashes the `tool_call` handler for all subsequent events in the session

When `event.toolName === "write"` and the file was never read:

```
line 624: const record = readState.get(abs);   // undefined — never read
line 627: if (event.toolName === "edit" && !record)  // skipped — "write" ≠ "edit"
line 635: const stale = await isStale(record!, current);
                                      ^^^^^^^
                                      undefined at runtime
```

`isStale` immediately accesses `record.contentHash` — `TypeError: Cannot read properties of undefined (reading 'contentHash')`. This crashes the async handler, which means Pi stops seeing `tool_call` interception entirely for the rest of the session.

**Affected scenario:** model uses `write` to overwrite an existing file it never read (valid: `write` replaces the whole file, no `oldText` matching needed — so read-before-write isn't enforced for it).

**Fix:** Add a guard before line 635. Since `write` without a prior read is allowed (no TOCTOU to check), an `undefined` record means no staleness check is needed:

```ts
// After line 632
if (!record) return undefined;  // write without prior read: no TOCTOU to check
const stale = await isStale(record, current);  // record is now narrowed, drop !
```

---

### 2. Test `isSafeTarget` no-cwd branch still has old logic

**File:** `tests/classify-bash.test.ts:104–116`  
**Severity:** Medium — tests give false confidence; a regression in the no-cwd path goes undetected

The test's local `isSafeTarget` at line 107–112:
```ts
if (!cwd) {
    if (/^\/(etc|bin|sbin|usr|lib|var|boot|root)\b/.test(target)) {
        return false;
    }
    return true;  // allows /home/user/data, /opt/secret, /run/creds, ...
}
```

The real `isSafeTarget` at `src/index.ts:288–290`:
```ts
if (!cwd) {
    return !target.startsWith("/");  // blocks ALL absolute paths
}
```

The test copy wasn't updated when the production function was tightened in round 2. The file comment at line 26 says "This mirrors the logic in src/index.ts exactly — if the implementation changes, this test file must be updated to match." — it wasn't.

Consequence: `classifyBash('echo x > /home/user/.bashrc')` (no cwd) passes the test's local copy (`safe → block: false`) while the real function returns `unsafe → block: true`. A future regression that loosens the no-cwd path would not be caught.

**Fix:** Update lines 107–112 in the test to match production:
```ts
if (!cwd) {
    return !target.startsWith("/");
}
```

---

### 3. Test `NON_FILE_TARGET` missing `/tmp/` and `/var/tmp/`

**File:** `tests/classify-bash.test.ts:30`  
**Severity:** Low — test divergence; a test covering `/tmp` redirects would give the wrong result

Test (line 30):
```ts
const NON_FILE_TARGET = /^(?:\/dev\/|\/proc\/|\/sys\/)/;
```

Production (`src/index.ts:194`):
```ts
const NON_FILE_TARGET = /^(?:\/dev\/|\/proc\/|\/sys\/|\/tmp\/|\/var\/tmp\/)/;
```

`/tmp/` and `/var/tmp/` were added in round 3 fixes but weren't propagated to the test copy. A test for `tee /tmp/build.log` would be blocked by the local `classifyBash` (no NON_FILE_TARGET match) but allowed by the real implementation.

**Fix:** Sync the regex:
```ts
const NON_FILE_TARGET = /^(?:\/dev\/|\/proc\/|\/sys\/|\/tmp\/|\/var\/tmp\/)/;
```

---

### 4. Split JSDoc blocks on `ReadRecord.hashPromise`

**File:** `src/index.ts:45–47`  
**Severity:** Low — first comment is orphaned; tooling won't surface it as a field description

```ts
/** Promise inflight for content-hash computation — prevents duplicate reads */
/** when two async paths race to hash the same record */
hashPromise?: Promise<string | undefined>;
```

Two separate `/** */` blocks. TypeScript and IDEs attach only the immediately preceding block to the declaration. The first block documents nothing.

**Fix:** Merge into one block:
```ts
/** Promise inflight for content-hash computation — deduplicates concurrent hash reads within a record */
hashPromise?: Promise<string | undefined>;
```

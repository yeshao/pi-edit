# Code Review — post-fix pass 2

**Date:** 2026-06-18  
**Prior review:** `CODE_REVIEW_2.md`

---

## Fix status from round 2

| Item | Status |
|------|--------|
| Schema pattern 2 (`\s+path\b`) | ✅ Fixed — `['"]?path['"]?\b` backtracks correctly; `\b` fires between `h` and `'` |
| `tee --append` false negative | ✅ Fixed — general flag-skip loop handles all `-`-prefixed tokens |
| Diagnostics crash vs lint | ✅ Fixed — `code !== 1` gates on lint-findings exit code only |
| `/tmp` blocked when `cwd` undefined | ✅ Fixed — `/tmp/` and `/var/tmp/` added to `NON_FILE_TARGET` |
| `isStale` misleading "changed on disk" | ⚠️ Partially fixed — see finding below |

---

## Remaining finding

### `isStale` "changed on disk" message still fires when stat succeeds but hash read fails

**File:** `src/index.ts:166` + `src/index.ts:631`  
**Severity:** Low — gate still fails closed (correct), but agent receives a misleading reason and may loop

The fix at line 631 detects the error-sentinel case:
```ts
const reason =
    record.mtimeMs === -1 || current.mtimeMs === -1
        ? `${path} could not be verified as unchanged (read error). ...`
        : `${path} has changed on disk since you last read it ...`;
```

This correctly handles the case where `fsStat` itself failed (sets `mtimeMs: -1`). But `isStale` returns `true` via a separate path when the stat *succeeds* but the subsequent `hashFileAt` call fails:

```
isStale line 164: record.contentHash !== undefined → enters hash path
isStale line 165: const now = await hashFileAt(current.absPath)  ← EACCES/EIO here
isStale line 166: if (now === undefined) return true              ← stale, cause unknown to caller
```

In this path both `record.mtimeMs` and `current.mtimeMs` are real positive values. The condition at line 631 evaluates to `false` and the "changed on disk" message fires — even though nothing changed; the file was momentarily unreadable during hash computation.

**Fix:** Return a discriminated result from `isStale` so the caller can choose the right message:

```ts
type StaleResult = "fresh" | "changed" | "unreadable";

async function isStale(record: ReadRecord, current: ReadRecord): Promise<StaleResult> {
    if (record.contentHash !== undefined) {
        const now = await hashFileAt(current.absPath);
        if (now === undefined) return "unreadable";
        return record.contentHash !== now ? "changed" : "fresh";
    }
    if (record.mtimeMs === -1 || current.mtimeMs === -1) return "unreadable";
    return record.mtimeMs !== current.mtimeMs ? "changed" : "fresh";
}

// in tool_call handler:
const stale = await isStale(record, current);
if (stale !== "fresh") {
    readState.delete(abs);
    const reason = stale === "unreadable"
        ? `${path} could not be verified as unchanged (read error). Re-read it before editing.`
        : `${path} has changed on disk since you last read it. Re-read and recompute your edits.`;
    return { block: true, reason };
}
```

---

## Note on `/tmp` policy change

Adding `/tmp/` and `/var/tmp/` to `NON_FILE_TARGET` (line 187) means those paths are now **always** permitted — even when `cwd` is defined. Previously `echo secret > /tmp/exfil` with a defined `cwd` would fail the containment check. Now it passes `NON_FILE_TARGET` immediately and is never inspected.

This is the right policy for a scratch space, but it's a deliberate scope reduction. Worth adding a comment to the regex explaining why /tmp is excluded.

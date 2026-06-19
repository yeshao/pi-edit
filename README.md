# pi-edit

Claude Code-style editing discipline for [Pi](https://pi.dev).

Brings Claude Code's editing safety optimizations to Pi **without removing** what Pi already does better (`edits[]` multi-edit, Unicode fuzzy match, file-mutation queue, pluggable Operations, TUI diff previews).

## What It Does

Pi-edit adds five safety layers via event hooks (no tool overrides):

1. **Read-before-write enforcement** — tracks which files the model has read; blocks `edit` on unread files so `oldText` always matches current contents.

2. **TOCTOU protection** — captures file mtime + content hash at read time; blocks edits when the file changed on disk since last read (external edits, linters, concurrent processes).

3. **Bash steering** — inspects `bash` commands for file-mutating patterns (`sed -i`, `awk > file`, `echo > file`, `perl -i`, `tee file`) and blocks them with a hint to use `edit` or `write` instead. Read-only inspection (`sed -n 'Np'`, `awk` filters without redirect) is allowed.

4. **Post-edit diagnostics** — after each successful `edit` or `write`, runs a fast linter (`eslint` for TS/JS, `ruff` for Python) and appends results to the tool output so the model can fix issues before continuing. Includes debouncing and in-flight deduplication.

5. **Schema-error recovery hints** — intercepts Pi's edit schema validation failures (e.g. wrong parameter names like `file` or `file_path` instead of `path`) and appends a recovery hint to the tool result suggesting the correct parameter name.

## Installation

```bash
# Via npm (recommended)
pi install npm:pi-edit

# Via GitHub URL (fallback)
pi install https://github.com/yeshao/pi-edit
```

## Flags

| Flag | Description |
|------|-------------|
| `--pi-edit-no-readguard` | Disable read-before-write + TOCTOU |
| `--pi-edit-no-bashguard` | Disable sed/awk steering |
| `--pi-edit-no-diagnostics` | Disable post-edit lint/typecheck feedback |

## How It Works

### Read-before-write

```
Model calls read("file.txt")
  → pi-edit records: mtime, contentHash, fullRead flag

Model calls edit("file.txt", edits=[...])
  → pi-edit checks: was this file read? has it changed on disk?
  → if unread or stale → block with helpful message
  → if clean → allow
```

### TOCTOU detection

Fast path: identical mtime = unchanged (no hash needed).
Slow path: mtime differs = compute content hash and compare with read-time baseline.

### Bash steering

Only blocks file-mutating shell commands. Read-only inspection is always allowed.

### Post-edit diagnostics

```
Model calls edit("src/foo.ts", ...)
  → edit succeeds
  → pi-edit runs eslint on src/foo.ts
  → if issues found → appended to tool result:
     [diagnostics for src/foo.ts — fix before continuing]
     3:10  error  'x' is defined but never used  @typescript-eslint/no-unused-vars
```

Debounced at 250ms per file; shared in-flight runs; 30s timeout ceiling.

## Dependencies

None — runs entirely via Pi's event hooks and Node.js built-ins.

## Project Structure

```
pi-edit/
├── package.json          # Pi extension manifest
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── src/
│   └── index.ts          # Extension entry (~580 lines)
└── tests/
    └── classify-bash.test.ts  # 58 tests
```

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test
```

## License

MIT

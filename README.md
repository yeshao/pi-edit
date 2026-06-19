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

Every read records a **sha256 content hash** of the file alongside its mtime.

- **Fresh**: current hash matches recorded hash → file unchanged, edit allowed.
- **Changed**: hash differs → file was modified since last read → block and require re-read.
- **Unreadable**: file can't be hashed (I/O error) → fail closed, require re-read.

The mtime is captured but not trusted alone — coarse-grained filesystems (HFS+ 1s, FAT 2s) and same-tick writes (linter rewrites) make mtime unreliable. The content hash is the source of truth.

### Bash steering

Two detection strategies:

1. **Inherently mutating patterns** — blocks `sed -i`, `awk > file`, `perl -i`, `dd of=`, `truncate`, and `cp`/`mv`/`install` with file arguments.
2. **Redirect target analysis** — extracts `>`, `>>`, and `tee` targets from the command, strips quoted strings to avoid false positives (e.g. `echo "a > b"`), and blocks writes outside the project directory.

Read-only inspection (`sed -n 'Np'`, `awk` filters without redirect) is always allowed. Scratch spaces (`/tmp`, `/var/tmp`) are permitted.

### Post-edit diagnostics

```
Model calls edit("src/foo.ts", ...)
  → edit succeeds
  → pi-edit runs eslint on src/foo.ts
  → if issues found → appended to tool result:
     [diagnostics for src/foo.ts — fix before continuing]
     3:10  error  'x' is defined but never used  @typescript-eslint/no-unused-vars
```

Supported: **eslint** for `.ts`/`.tsx`/`.js`/`.jsx`, **ruff** for `.py`.

Debounced at 250ms per file; shared in-flight runs; 30s timeout ceiling.

## How It Works — Schema-error recovery

When Pi's tool schema validation fails (e.g. the model uses `file` or `file_path` instead of `path`), pi-edit intercepts the error and appends a recovery hint:

```
[recovery hint] Pi's 'edit' tool requires the 'path' parameter.
  Retry with: edit path=src/foo.ts
```

For wrong-parameter-name errors on `read`/`edit`/`write`, the error is downgraded to a success with the hint so the agent can self-correct without wasting a turn.

## Partial-read warnings

If the model calls `edit` on a file that was only partially read (with `offset`/`limit`), pi-edit logs a warning that the model may lack full-file context. Debounced to once per minute per file.

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

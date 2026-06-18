/**
 * pi-edit — Claude Code-style editing discipline for Pi
 *
 * Brings Claude Code's editing-discipline optimizations to Pi WITHOUT removing
 * what Pi already does better (edits[] multi-edit, Unicode fuzzy match,
 * file-mutation queue, pluggable Operations, TUI diff previews).
 *
 * It adds, purely via hooks (no tool overrides):
 *   1. Read-before-write enforcement  (read tracking + edit/write gating)
 *   2. TOCTOU protection              (mtime + content hash staleness check)
 *   3. sed/awk/echo-redirect steering (bash command inspection + soft block)
 *   4. Post-edit diagnostics loop     (lint/typecheck → append to tool result)
 *   5. Schema-error recovery hints    (intercepts Pi's edit schema validation
 *                                      failure and suggests `write` instead)
 *
 * Usage:  pi install npm:pi-edit
 *
 * Flags:
 *   --pi-edit-no-readguard        disable read-before-write + TOCTOU
 *   --pi-edit-no-bashguard        disable sed/awk steering
 *   --pi-edit-no-diagnostics      disable post-edit lint/typecheck feedback
 */

import type {
	ExtensionAPI,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { stat as fsStat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Read state tracking (the Pi equivalent of Claude Code's readFileState map)
// ---------------------------------------------------------------------------

interface ReadRecord {
	mtimeMs: number;
	/** lazily computed: only hashed when an mtime comparison is inconclusive */
	contentHash?: string;
	/** absolute path, so we can hash on demand for the deferred-hash path */
	absPath: string;
	/** true when the model read the whole file (no offset/limit) */
	fullRead: boolean;
	/** Promise inflight for content-hash computation — deduplicates concurrent hash reads within a record */
	hashPromise?: Promise<string | undefined>;
}

interface ReadState {
	readState: Map<string, ReadRecord>;
	rememberRead: (abs: string, record: ReadRecord) => void;
}

function createReadState(): ReadState {
	const readState = new Map<string, ReadRecord>();

	/** Cap the read-tracking map so a long session can't accumulate stale entries. */
	const MAX_READ_ENTRIES = 512;

	function rememberRead(abs: string, record: ReadRecord): void {
		// LRU-ish: re-insert moves the key to the end; evict from the front when full.
		readState.delete(abs);
		readState.set(abs, record);
		if (readState.size > MAX_READ_ENTRIES) {
			const oldest = readState.keys().next().value;
			if (oldest !== undefined) readState.delete(oldest);
		}
	}

	return { readState, rememberRead };
}

function keyFor(cwd: string, path: string): string {
	return resolve(cwd, path);
}

function hashOf(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Cheap snapshot: stat only (mtime + size). The content hash is deferred and
 * computed lazily by {@link contentHashOf} only when an mtime comparison can't
 * decide staleness — avoiding a full-file read on every edit/write.
 */
async function snapshotFile(
	absPath: string,
	fullRead = true,
): Promise<ReadRecord | undefined> {
	try {
		const st = await fsStat(absPath);
		return { mtimeMs: st.mtimeMs, absPath, fullRead };
	} catch (e: unknown) {
		// Only ENOENT means "file does not exist" (truly new). Any other stat
		// error (EACCES, EMFILE, EIO, ELOOP, ...) means the file may exist but
		// we can't inspect it — the gate must fail closed, not treat it as new.
		if (
			e !== null &&
			typeof e === "object" &&
			"code" in e &&
			(e as { code: unknown }).code === "ENOENT"
		) {
			return undefined;
		}
		return { mtimeMs: -1, absPath, fullRead };
	}
}

/** Compute (and memoize) the sha256 of a record's file. Returns undefined if unreadable.
 *
 * Uses a Promise-based memo so that concurrent calls for the same record all
 * await the same in-flight read instead of racing to set `contentHash`.
 * Deduplicates within a single record; concurrent reads of the same file via
 * separate records are not deduplicated.
 */
async function contentHashOf(record: ReadRecord): Promise<string | undefined> {
	if (record.contentHash !== undefined) return record.contentHash;
	if (record.hashPromise !== undefined) return record.hashPromise;
	record.hashPromise = (async () => {
		try {
			const buf = await readFile(record.absPath);
			const hash = hashOf(buf);
			record.contentHash = hash;
			return hash;
		} catch {
			return undefined;
		} finally {
			delete record.hashPromise;
		}
	})();
	return record.hashPromise;
}

/** Hash the file at a given absolute path without memoizing. Used for one-off reads.
 *
 * Returns undefined on read failure. The caller decides whether that means
 * "file gone" (stale) or "unreadable" (I/O error).
 */
async function hashFileAt(absPath: string): Promise<string | undefined> {
	try {
		const buf = await readFile(absPath);
		return hashOf(buf);
	} catch {
		return undefined;
	}
}

/**
 * Decide whether `current` is stale relative to the recorded read.
 *
 * When a recorded content hash is available we always hash-confirm — mtime
 * alone is unreliable on coarse-granularity filesystems (HFS+ 1 s, FAT 2 s)
 * and on same-tick writes (linter/formatter rewrites). The equal-mtime
 * short-circuit is only safe when we have *no* hash to compare against.
 *
 * Safe invariant: contentHash is always populated by the read handler
 * before rememberRead is called.
 *
 * Returns a discriminated tag so the caller can choose the right message:
 *   "fresh"     — file unchanged, edit is safe
 *   "changed"   — content or mtime differs, re-read needed
 *   "unreadable" — stat or hash I/O failure, cannot verify
 */
type StaleResult = "fresh" | "changed" | "unreadable";
async function isStale(
	record: ReadRecord,
	current: ReadRecord,
): Promise<StaleResult> {
	if (record.contentHash !== undefined) {
		const now = await hashFileAt(current.absPath);
		if (now === undefined) return "unreadable";
		return record.contentHash !== now ? "changed" : "fresh";
	}
	// No recorded hash — fall back to mtime comparison.
	if (record.mtimeMs === -1 || current.mtimeMs === -1) return "unreadable";
	return record.mtimeMs !== current.mtimeMs ? "changed" : "fresh";
}

// ---------------------------------------------------------------------------
// Bash command inspection — steer away from sed/awk file edits
//
// Inspired by Claude Code's approach: instead of blindly blocking all
// redirects, we extract the redirect target and validate it against the
// project directory. This allows safe patterns like:
//   npm test > output.txt          (target inside project)
//   cat file | tee logs/test.log   (target inside project)
// While still blocking dangerous ones like:
//   echo hello > /etc/passwd      (target outside project)
// ---------------------------------------------------------------------------

// /tmp and /var/tmp are scratch spaces — always permitted even when cwd is set,
// since build tools and tests routinely write artifacts there.
const NON_FILE_TARGET = /^(?:\/dev\/|\/proc\/|\/sys\/|\/tmp\/|\/var\/tmp\/)/;
interface ExtractedTarget {
	target: string;
	operator: ">" | ">>" | "tee";
}

/**
 * Strip a single layer of surrounding quotes (single or double) from a string.
 * Leaves the string unchanged if it is not fully wrapped in matching quotes.
 */
function unquote(s: string): string {
	const m = s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === "'" || s[0] === '"');
	return m ? s.slice(1, -1) : s;
}

/**
 * Remove quoted substrings (single- or double-quoted) from a command string,
 * replacing them with an equal-length run of spaces. This prevents redirect
 * operators *inside* a quoted string (e.g. `echo "a > b"`) from being
 * matched, while preserving the positions of real redirects outside quotes.
 */
function stripQuotedStrings(command: string): string {
	return command
		.replace(/"(?:[^"\\]|\\.)*"/g, (m) => " ".repeat(m.length))
		.replace(/'(?:[^'\\]|\\.)*'/g, (m) => " ".repeat(m.length));
}

function extractRedirectTargets(command: string): ExtractedTarget[] {
	const targets: ExtractedTarget[] = [];
	// Work on a copy with quoted strings blanked out so that > / >> / tee
	// operators inside strings are never matched. Real redirects outside
	// quotes are preserved with their position intact.
	const stripped = stripQuotedStrings(command);

	// Helper: extract target from the ORIGINAL command at a given position,
	// handling quoted targets via unquote().
	function captureTarget(str: string, startIdx: number): string | undefined {
		// Skip whitespace after the operator.
		let i = startIdx;
		while (i < str.length && str[i] === " ") i++;
		if (i >= str.length) return undefined;
		// If the target starts with a quote, find the matching close quote.
		const q = str[i];
		if (q === '"' || q === "'") {
			const close = str.indexOf(q, i + 1);
			if (close === -1) return undefined;
			return str.slice(i + 1, close);
		}
		// Unquoted target: read until the next whitespace, |, ;, or &.
		let end = i;
		while (end < str.length && !/[\s|;&]/.test(str[end])) end++;
		return str.slice(i, end);
	}

	// Tee targets: match on stripped, extract from original.
	// After "tee" we may see flag arguments (-a, --append, --ignore-interrupts, etc.)
	// before the actual file target.
	const teeRe = /\btee\b/g;
	let teeMatch: RegExpExecArray | null;
	while ((teeMatch = teeRe.exec(stripped)) !== null) {
		let i = teeMatch.index + 3; // skip past "tee" in original
		// Skip whitespace
		while (i < command.length && command[i] === " ") i++;
		// Skip flag arguments (-a, --append, --ignore-interrupts, etc.)
		while (i < command.length && command[i] === "-") {
			let end = i;
			while (end < command.length && !/\s/.test(command[end])) end++;
			i = end;
			while (i < command.length && command[i] === " ") i++;
		}
		const target = captureTarget(command, i);
		if (target !== undefined && target.length > 0 && !NON_FILE_TARGET.test(target) && !/^\d+$/.test(target)) {
			targets.push({ target, operator: "tee" });
		}
	}

	// Redirect targets: match >>? (with optional trailing |) on stripped,
	// then capture the target from the ORIGINAL command.
	// Use a negative lookahead for `&` to avoid matching fd redirects like 2>&1.
	const redirectRe = /(>>?)\|?(?!\s*&)/g;
	let redirectMatch: RegExpExecArray | null;
	while ((redirectMatch = redirectRe.exec(stripped)) !== null) {
		const operator = redirectMatch[1]! as ">" | ">>";
		const target = captureTarget(command, redirectMatch.index + redirectMatch[0].length);
		if (target !== undefined && target.length > 0 && !NON_FILE_TARGET.test(target) && !/^\d+$/.test(target)) {
			targets.push({ target, operator });
		}
	}
	return targets;
}

function isSafeTarget(target: string, cwd?: string): boolean {
	if (/^\d+$/.test(target)) return true;
	if (NON_FILE_TARGET.test(target)) return true;
	if (!cwd) {
		return !target.startsWith("/");
	}
	const resolved = resolve(cwd, target);
	const cwdResolved = resolve(cwd);
	return resolved === cwdResolved || resolved.startsWith(cwdResolved + "/");
}

const INHERENTLY_MUTATING: { re: RegExp; hint: string }[] = [
	{ re: /\bsed\b[^|]*-[a-z]*i/, hint: "in-place sed edit" },
	{ re: /\bawk\b[^|]*?>\s*[^&\s]/, hint: "awk redirect to file" },
	{ re: /\bperl\b[^|]*-[a-z]*i/, hint: "perl -i in-place edit" },
	// File-mutating commands that write without a > / >> / tee token.
	{ re: /\bdd\b[^|]*\bof=/, hint: "dd write to file (use edit/write)" },
	{ re: /\btruncate\b/, hint: "truncate (in-place file mutation)" },
	{ re: /\b(?:cp|mv|install)\b\s/, hint: "file copy/move (use edit/write)" },
];

function classifyBash(
	command: string,
	cwd?: string,
): { block: boolean; hint?: string } {
	// Strip quoted strings before testing patterns so that > inside quotes
	// (e.g. awk '{print ">"}') doesn't trigger a false positive, while
	// awk '{print}'>file.txt still does.
	const stripped = stripQuotedStrings(command);
	for (const { re, hint } of INHERENTLY_MUTATING) {
		if (re.test(stripped)) {
			return { block: true, hint };
		}
	}
	const targets = extractRedirectTargets(command);
	for (const { target, operator } of targets) {
		if (!isSafeTarget(target, cwd)) {
			const opHint = operator === "tee" ? "tee into" : "redirect into";
			return {
				block: true,
				hint: `${opHint} a file outside the project: ${target}`,
			};
		}
	}
	return { block: false };
}

// ---------------------------------------------------------------------------
// Post-edit diagnostics (the LSP-equivalent feedback loop)
// ---------------------------------------------------------------------------

interface DiagRunner {
	exts: string[];
	argv: (file: string) => { cmd: string; args: string[] } | undefined;
}

const DIAG_RUNNERS: DiagRunner[] = [
	{
		exts: [".ts", ".tsx"],
		argv: (file) => ({
			cmd: "npx",
			// "--" terminates option parsing so a file named "--fix" etc. is
			// treated as a positional path, not consumed as an eslint flag.
			args: ["--no-install", "eslint", "--format", "compact", "--", file],
		}),
	},
	{
		exts: [".js", ".jsx"],
		argv: (file) => ({
			cmd: "npx",
			args: ["--no-install", "eslint", "--format", "compact", "--", file],
		}),
	},
	{
		exts: [".py"],
		argv: (file) => ({
			cmd: "ruff",
			args: ["check", "--output-format", "concise", "--", file],
		}),
	},
];

function runnerFor(path: string): DiagRunner | undefined {
	return DIAG_RUNNERS.find((r) => r.exts.some((e) => path.endsWith(e)));
}

function createDiagState() {
	const DIAG_DEBOUNCE_MS = 250;
	const MAX_DIAG_ENTRIES = 512;
	const diagInFlight = new Map<string, Promise<string | undefined>>();
	const diagLastRunAt = new Map<string, number>();

	async function runDiagnostics(
		pi: ExtensionAPI,
		cwd: string,
		path: string,
	): Promise<string | undefined> {
		const runner = runnerFor(path);
		if (!runner) return undefined;
		const spec = runner.argv(path);
		if (!spec) return undefined;

		const abs = keyFor(cwd, path);

		const inFlight = diagInFlight.get(abs);
		if (inFlight) return inFlight;

		const last = diagLastRunAt.get(abs);
		if (last !== undefined && Date.now() - last < DIAG_DEBOUNCE_MS)
			return undefined;

		const run = (async () => {
			try {
				const { stdout, stderr, code } = await pi.exec(spec.cmd, spec.args, {
					cwd,
					timeout: 30_000,
				});
				// Exit code 1 = lint findings (what we surface).
				// Exit code 0 = clean. Exit code 2+ = tool crash / config error.
				if (code !== 1) return undefined;

				const out = `${stdout}\n${stderr}`.trim();
				if (!out) return undefined;
				return out.split("\n").slice(0, 30).join("\n");
			} catch {
				return undefined;
			} finally {
				diagLastRunAt.set(abs, Date.now());
				if (diagLastRunAt.size > MAX_DIAG_ENTRIES) {
					const oldest = diagLastRunAt.keys().next().value;
					if (oldest !== undefined) diagLastRunAt.delete(oldest);
				}
				diagInFlight.delete(abs);
			}
		})();

		diagInFlight.set(abs, run);
		return run;
	}

	return { runDiagnostics };
}

// ---------------------------------------------------------------------------
// Schema-error recovery patterns
// ---------------------------------------------------------------------------
/**
 * Pi's tool schemas have `additionalProperties: false` but the framework may
 * inject extra properties or the model may use wrong parameter names (e.g.
 * `file` or `file_path` instead of `path`). These schema validation failures
 * are intercepted so we can inject a recovery hint.
 */
const SCHEMA_ERROR_PATTERNS = [
	/\broot:\s+must\s+(?:not\s+)?have\s+additional\s+properties?\b/i,
	/\bpath:\s+must\s+have\s+required\s+propert(?:y|ies)\s+['"]?path['"]?\b/i,
];
function isSchemaValidationError(text: string): boolean {
	return SCHEMA_ERROR_PATTERNS.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerFlag("pi-edit-no-readguard", {
		type: "boolean",
		default: false,
		description: "disable read-before-write/TOCTOU",
	});
	pi.registerFlag("pi-edit-no-bashguard", {
		type: "boolean",
		default: false,
		description: "disable sed/awk steering",
	});
	pi.registerFlag("pi-edit-no-diagnostics", {
		type: "boolean",
		default: false,
		description: "disable post-edit lint",
	});

	const readGuardOff = () => pi.getFlag("pi-edit-no-readguard") === true;
	const bashGuardOff = () => pi.getFlag("pi-edit-no-bashguard") === true;
	const diagOff = () => pi.getFlag("pi-edit-no-diagnostics") === true;

	// Per-agent isolated state — each call to this extension function gets its
	// own maps, so multiple agents in the same process don't share state.
	const { readState, rememberRead } = createReadState();
	const { runDiagnostics } = createDiagState();
	// Module-level debounce map for partial-read warnings (not agent-specific).
	const partialReadWarnAt = new Map<string, number>();
	const MAX_PARTIAL_WARN_ENTRIES = 256;
	function readPathOf(
		input: Record<string, unknown>,
		mode?: string,
	): string | undefined {
		const p =
			(input.path as string) ??
			(input.file_path as string) ??
			(input.file as string);
		if (typeof p === "string" && p.length > 0) return p;
		if (mode !== "tui") {
			console.warn("[pi-edit] read event missing path/file_path; not tracked", {
				keys: Object.keys(input),
			});
		}
		return undefined;
	}

	// 1 & 3 & 4 & 5. Single tool_result handler — merges read tracking,
	// post-edit diagnostics, and schema-error recovery into one registration
	// so that Pi runtimes with last-write-wins pi.on() semantics cannot
	// silently drop the read-tracking logic (which would permanently block
	// every edit because readState would never be populated).
	pi.on("tool_result", async (event, ctx) => {
		// --- 1. Track reads: populate readState so edit/write gating works. ---
		if (event.toolName === "read" && !event.isError) {
			const path = readPathOf(event.input, ctx.mode);
			if (path) {
				const abs = keyFor(ctx.cwd, path);
				const fullRead =
					event.input.offset === undefined && event.input.limit === undefined;
				const snap = await snapshotFile(abs, fullRead);
				if (snap) {
					await contentHashOf(snap);
					rememberRead(abs, snap);
				}
			}
			return undefined;
		}

		// --- 5. Schema-error recovery (read/edit/write) ---
		if (event.isError) {
			const blocks = Array.isArray(event.content) ? event.content : [];
			const errorText = blocks
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			if (errorText && isSchemaValidationError(errorText)) {
				const path = readPathOf(event.input, ctx.mode);
				let hint: string;
				// Only the wrong-parameter-name case is a "soft" schema error
				// we can safely downgrade to a success with a recovery hint.
				// For other schema errors (e.g. the edit tool's `root` injection
				// bug) we must preserve isError:true so the agent sees the failure.
				const usedWrongKey =
					event.input.path === undefined &&
					(event.input.file_path !== undefined ||
						event.input.file !== undefined);
				if (event.toolName === "read" && usedWrongKey) {
					hint =
						`\n\n[recovery hint] Pi's 'read' tool requires the 'path' parameter ` +
						`(not 'file' or 'file_path'). Retry with:\n` +
						`  read path=${path ?? event.input.file_path ?? event.input.file}`;
				} else if (event.toolName !== "read" && usedWrongKey) {
					hint =
						`\n\n[recovery hint] Pi's ${event.toolName} tool requires the 'path' parameter. ` +
						`Retry with:\n` +
						`  ${event.toolName} path=${path ?? event.input.file_path ?? event.input.file}`;
				} else {
					hint =
						`\n\n[recovery hint] Pi's ${event.toolName} tool returned a schema ` +
						`validation error. Review the error above before retrying.`;
				}
				// Requires Pi runtime to propagate async handler return values
				// to the tool result.
				return {
					content: [
						...(Array.isArray(event.content) ? event.content : []),
						{ type: "text" as const, text: hint },
					],
					isError: usedWrongKey && event.toolName !== "read" ? false : true,
				};
			}
			return undefined;
		}

		// --- 4. Post-edit diagnostics (edit/write successes only) ---
		if (event.toolName !== "edit" && event.toolName !== "write")
			return undefined;
		const path = readPathOf(event.input, ctx.mode);
		if (!path) return undefined;
		// Always refresh readState to the post-edit baseline.
		const abs = keyFor(ctx.cwd, path);
		const snap = await snapshotFile(abs, true);
		if (snap) {
			await contentHashOf(snap);
			rememberRead(abs, snap);
		}

		if (diagOff()) return undefined;

		const diag = await runDiagnostics(pi, ctx.cwd, path);
		if (!diag) return undefined;

		const note = `\n\n[diagnostics for ${path} — fix before continuing]\n${diag}`;
		return {
			content: [
				...(Array.isArray(event.content) ? event.content : []),
				{ type: "text" as const, text: note },
			],
			isError: false,
		};
	});

	// 2. Gate edit/write — read-before-write + TOCTOU.
	pi.on("tool_call", async (event, ctx) => {
		// --- bash steering ---
		if (event.toolName === "bash" && !bashGuardOff()) {
			const bashEvent = event as unknown as ToolCallEvent;
			const { block, hint } = classifyBash(
				(bashEvent.input.command as string) ?? "",
				ctx.cwd,
			);
			if (block) {
				return {
					block: true,
					reason:
						`This bash command performs an ${hint}. Use the 'edit' tool (exact text replacement, ` +
						`supports multiple edits[] in one call) or 'write' (full file) instead of mutating files ` +
						`through the shell. Read-only inspection (sed -n 'Np', awk filters without redirect) is fine.`,
				};
			}
			return undefined;
		}

		if (readGuardOff()) return undefined;
		if (event.toolName !== "edit" && event.toolName !== "write")
			return undefined;

		const path = readPathOf(event.input, ctx.mode);
		if (!path) return undefined;
		const abs = keyFor(ctx.cwd, path);

		const current = await snapshotFile(abs);

		// New-file write: allow unconditionally.
		if (!current) return undefined;

		const record = readState.get(abs);

		// edit without ever reading → block (Claude Code rule)
		if (event.toolName === "edit" && !record) {
			return {
				block: true,
				reason: `You must read ${path} with the 'read' tool before editing it, so your edits[].oldText matches the current contents.`,
			};
		}

		// TOCTOU: file changed since the model last read it.
		if (!record) return undefined; // write without prior read: no TOCTOU to check
		const stale = await isStale(record, current);
		if (stale !== "fresh") {
			readState.delete(abs);
			const reason =
				stale === "unreadable"
					? `${path} could not be verified as unchanged (read error). ` +
						`Re-read it before editing to confirm the current contents.`
					: `${path} has changed on disk since you last read it (external edit, linter, or another process). ` +
						`Re-read it with the 'read' tool and recompute your edits before applying.`;
			return { block: true, reason };
		}

		// Partial-read warning (debounced to avoid spam)
		if (event.toolName === "edit" && record && !record.fullRead) {
			const lastWarn = partialReadWarnAt.get(abs);
			if (lastWarn === undefined || Date.now() - lastWarn > 60_000) {
				console.warn(
					`[pi-edit] editing ${path} after a partial read; model may lack full-file context`,
				);
				partialReadWarnAt.set(abs, Date.now());
				if (partialReadWarnAt.size > MAX_PARTIAL_WARN_ENTRIES) {
					const oldest = partialReadWarnAt.keys().next().value;
					if (oldest !== undefined) partialReadWarnAt.delete(oldest);
				}
			}
		}

		return undefined;
	});
}

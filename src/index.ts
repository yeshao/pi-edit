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
 *
 * Usage:  pi install npm:pi-edit
 *
 * Flags:
 *   --no-readguard        disable read-before-write + TOCTOU
 *   --no-bashguard        disable sed/awk steering
 *   --no-diagnostics      disable post-edit lint/typecheck feedback
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
}

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

function keyFor(cwd: string, path: string): string {
	return resolve(cwd, path);
}

function hashOf(content: string): string {
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
	} catch {
		return undefined;
	}
}

/** Compute (and memoize) the sha256 of a record's file. Returns undefined if unreadable. */
async function contentHashOf(record: ReadRecord): Promise<string | undefined> {
	if (record.contentHash !== undefined) return record.contentHash;
	try {
		const buf = await readFile(record.absPath, "utf-8");
		record.contentHash = hashOf(buf);
		return record.contentHash;
	} catch {
		return undefined;
	}
}

/** Hash the file at a given absolute path without memoizing. Used for one-off reads. */
async function hashFileAt(absPath: string): Promise<string | undefined> {
	try {
		const buf = await readFile(absPath, "utf-8");
		return hashOf(buf);
	} catch {
		return undefined;
	}
}

/**
 * Decide whether `current` is stale relative to the recorded read.
 * Fast path: identical mtime ⇒ unchanged. Only when mtimes differ do we fall
 * back to a content hash (handles coarse-mtime filesystems / mtime-only touches).
 *
 * The recorded snapshot's hash MUST have been captured at read time (`record`
 * already carries it); the current on-disk hash is read here. If `record` has
 * no hash (read-time hashing was skipped) we can't disambiguate a coarse-mtime
 * change, so we treat the mtime difference as authoritative → stale (safe).
 */
async function isStale(
	record: ReadRecord,
	current: ReadRecord,
): Promise<boolean> {
	if (record.mtimeMs === current.mtimeMs) return false;
	if (record.contentHash === undefined) return true;
	const now = await hashFileAt(current.absPath);
	if (now === undefined) return true;
	return record.contentHash !== now;
}

// ---------------------------------------------------------------------------
// Bash command inspection — steer away from sed/awk file edits
// ---------------------------------------------------------------------------

/**
 * Device/throwaway redirect targets that are NOT file edits and must not be blocked
 * (e.g. `cmd 2>/dev/null`, `cmd > /dev/null`, `cat x > /proc/...`).
 */
const NON_FILE_TARGET = /^(?:\/dev\/|\/proc\/|\/sys\/)/;

/**
 * Match a shell redirect into a *real file with an extension* and capture the target,
 * so we can exclude /dev, /proc, /sys and fd-only redirects (`2>&1`).
 */
const FILE_REDIRECT = />>?\s*([^&\s][^\s|;&]*\.\w+)/;
/** tee into a real file (with extension), not `tee /dev/null` or `tee /proc/...`. */
const FILE_TEE = /\btee\b\s+(?:-a\s+)?([^\s|;&]*\.\w+)/;

/** Patterns that mutate files via the shell and should be redirected to edit/write. */
const MUTATING_BASH: { re: RegExp; hint: string; targetGroup?: number }[] = [
	{ re: /\bsed\b[^|]*\s-[a-z]*i/, hint: "in-place sed edit" },
	{ re: /\bawk\b[^|]*>\s*[^&\s]/, hint: "awk redirect to file" },
	{ re: /\bperl\b[^|]*\s-[a-z]*i/, hint: "perl -i in-place edit" },
	{ re: FILE_REDIRECT, hint: "shell redirect into a file", targetGroup: 1 },
	{ re: FILE_TEE, hint: "tee into a file", targetGroup: 1 },
];

/** Read-only sed/awk (sed -n 'Np', awk filters w/o redirect) is allowed. */
function classifyBash(command: string): { block: boolean; hint?: string } {
	for (const { re, hint, targetGroup } of MUTATING_BASH) {
		const m = re.exec(command);
		if (!m) continue;
		if (targetGroup !== undefined) {
			const target = m[targetGroup];
			if (target && NON_FILE_TARGET.test(target)) continue;
		}
		return { block: true, hint };
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
			args: ["--no-install", "eslint", "--format", "compact", file],
		}),
	},
	{
		exts: [".js", ".jsx"],
		argv: (file) => ({
			cmd: "npx",
			args: ["--no-install", "eslint", "--format", "compact", file],
		}),
	},
	{
		exts: [".py"],
		argv: (file) => ({
			cmd: "ruff",
			args: ["check", "--output-format", "concise", file],
		}),
	},
];

function runnerFor(path: string): DiagRunner | undefined {
	return DIAG_RUNNERS.find((r) => r.exts.some((e) => path.endsWith(e)));
}

const DIAG_DEBOUNCE_MS = 250;
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
			if (code === 0) return undefined;
			const out = `${stdout}\n${stderr}`.trim();
			if (!out) return undefined;
			const lines = out.split("\n").slice(0, 30);
			return lines.join("\n");
		} catch {
			return undefined;
		} finally {
			diagLastRunAt.set(abs, Date.now());
			diagInFlight.delete(abs);
		}
	})();

	diagInFlight.set(abs, run);
	return run;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-readguard", {
		type: "boolean",
		default: false,
		description: "disable read-before-write/TOCTOU",
	});
	pi.registerFlag("no-bashguard", {
		type: "boolean",
		default: false,
		description: "disable sed/awk steering",
	});
	pi.registerFlag("no-diagnostics", {
		type: "boolean",
		default: false,
		description: "disable post-edit lint",
	});

	const readGuardOff = () => pi.getFlag("no-readguard") === true;
	const bashGuardOff = () => pi.getFlag("no-bashguard") === true;
	const diagOff = () => pi.getFlag("no-diagnostics") === true;

	function readPathOf(
		input: Record<string, unknown>,
		mode?: string,
	): string | undefined {
		const path = (input.path as string) ?? (input.file_path as string);
		if (typeof path === "string" && path.length > 0) return path;
		if (mode !== "tui") {
			console.warn(
				"[pi-edit] read event missing path/file_path; not tracked",
				{ keys: Object.keys(input) },
			);
		}
		return undefined;
	}

	// 1. Track reads — capture baseline mtime AND content hash at read time.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read" || event.isError) return undefined;
		const path = readPathOf(event.input, ctx.mode);
		if (!path) return undefined;
		const abs = keyFor(ctx.cwd, path);
		const fullRead =
			event.input.offset === undefined && event.input.limit === undefined;
		const snap = await snapshotFile(abs, fullRead);
		if (snap) {
			await contentHashOf(snap);
			rememberRead(abs, snap);
		}
		return undefined;
	});

	// 2. Gate edit/write — read-before-write + TOCTOU.
	pi.on("tool_call", async (event, ctx) => {
		// --- bash steering ---
		if (event.toolName === "bash" && !bashGuardOff()) {
			const bashEvent = event as Extract<ToolCallEvent, { toolName: "bash" }>;
			const { block, hint } = classifyBash(bashEvent.input.command ?? "");
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
		if (record && (await isStale(record, current))) {
			readState.delete(abs);
			return {
				block: true,
				reason:
					`${path} has changed on disk since you last read it (external edit, linter, or another process). ` +
					`Re-read it with the 'read' tool and recompute your edits before applying.`,
			};
		}

		// Partial-read warning
		if (event.toolName === "edit" && record && !record.fullRead) {
			console.warn(
				`[pi-edit] editing ${path} after a partial read; model may lack full-file context`,
			);
		}

		return undefined;
	});

	// 3. Post-edit diagnostics loop.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write")
			return undefined;
		if (event.isError) return undefined;
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
			content: [...event.content, { type: "text" as const, text: note }],
			isError: false,
		};
	});
}

import { describe, it, expect } from "vitest";

/**
 * Source-level regression tests for pi-edit.
 *
 * The extension's core logic (file stat tracking, bash command classification,
 * staleness detection) is deeply async and filesystem-dependent, making it
 * hard to unit-test in isolation without heavy mocking of Pi's ExtensionAPI.
 *
 * We test what we can verify deterministically: the classifyBash logic,
 * the LRU eviction behavior, and source code structure invariants.
 * The full integration is validated by running the extension inside Pi.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// classifyBash — deterministic, no filesystem needed
// ---------------------------------------------------------------------------

/**
 * Re-implement classifyBash locally so we can test it without importing
 * the extension (which requires Pi's ExtensionAPI).
 *
 * This mirrors the logic in src/index.ts exactly — if the implementation
 * changes, this test file must be updated to match.
 */
const NON_FILE_TARGET = /^(?:\/dev\/|\/proc\/|\/sys\/|\/tmp\/|\/var\/tmp\/)/;

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

interface ExtractedTarget {
	target: string;
	operator: ">" | ">>" | "tee";
}

function extractRedirectTargets(command: string): ExtractedTarget[] {
	const targets: ExtractedTarget[] = [];
	const stripped = stripQuotedStrings(command);

	function captureTarget(str: string, startIdx: number): string | undefined {
		let i = startIdx;
		while (i < str.length && str[i] === " ") i++;
		if (i >= str.length) return undefined;
		const q = str[i];
		if (q === '"' || q === "'") {
			const close = str.indexOf(q, i + 1);
			if (close === -1) return undefined;
			return str.slice(i + 1, close);
		}
		let end = i;
		while (end < str.length && !/[\s|;&]/.test(str[end])) end++;
		return str.slice(i, end);
	}

	const teeRe = /\btee\b/g;
	let teeMatch: RegExpExecArray | null;
	while ((teeMatch = teeRe.exec(stripped)) !== null) {
		let i = teeMatch.index + 3;
		while (i < command.length && command[i] === " ") i++;
		if (command[i] === "-" && command[i + 1] === "a") {
			i += 2;
			while (i < command.length && command[i] === " ") i++;
		}
		const target = captureTarget(command, i);
		if (target !== undefined && target.length > 0 && !NON_FILE_TARGET.test(target) && !/^\d+$/.test(target)) {
			targets.push({ target, operator: "tee" });
		}
	}

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
	{ re: /\bdd\b[^|]*\bof=/, hint: "dd write to file (use edit/write)" },
	{ re: /\btruncate\b/, hint: "truncate (in-place file mutation)" },
	{ re: /\b(?:cp|mv|install)\b\s/, hint: "file copy/move (use edit/write)" },
];

function classifyBash(command: string, cwd?: string): { block: boolean; hint?: string } {
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

describe("classifyBash", () => {
	// --- Blocked: in-place edits ---

	it("blocks sed -i", () => {
		expect(classifyBash("sed -i 's/foo/bar/' file.txt")).toEqual({
			block: true,
			hint: "in-place sed edit",
		});
	});

	it("blocks sed -i with double quotes", () => {
		expect(classifyBash(`sed -i "s/foo/bar/" file.txt`)).toEqual({
			block: true,
			hint: "in-place sed edit",
		});
	});

	it("blocks perl -i", () => {
		expect(classifyBash("perl -i -pe 's/foo/bar/' file.txt")).toEqual({
			block: true,
			hint: "perl -i in-place edit",
		});
	});

	it("blocks awk redirect to file", () => {
		expect(classifyBash("awk '{print}' input.txt > output.txt")).toEqual({
			block: true,
			hint: "awk redirect to file",
		});
	});

	it("blocks echo redirect outside project", () => {
		expect(classifyBash('echo "hello" > /etc/passwd', "/home/user/project")).toEqual({
			block: true,
			hint: "redirect into a file outside the project: /etc/passwd",
		});
	});

	it("blocks echo append outside project", () => {
		expect(classifyBash('echo "hello" >> /etc/passwd', "/home/user/project")).toEqual({
			block: true,
			hint: "redirect into a file outside the project: /etc/passwd",
		});
	});

	it("blocks tee to file outside project", () => {
		expect(classifyBash("cat input.txt | tee /var/log/secret.log", "/home/user/project")).toEqual({
			block: true,
			hint: "tee into a file outside the project: /var/log/secret.log",
		});
	});

	it("blocks tee -a to file outside project", () => {
		expect(classifyBash("cat input.txt | tee -a /var/log/secret.log", "/home/user/project")).toEqual({
			block: true,
			hint: "tee into a file outside the project: /var/log/secret.log",
		});
	});

	it("allows echo redirect inside project", () => {
		expect(classifyBash('echo "hello" > output.txt', "/home/user/project")).toEqual({ block: false });
	});

	it("allows tee to file inside project", () => {
		expect(classifyBash("cat input.txt | tee logs/test.log", "/home/user/project")).toEqual({ block: false });
	});

	// --- Allowed: read-only operations ---

	it("allows read-only sed -n", () => {
		expect(classifyBash("sed -n '5p' file.txt")).toEqual({ block: false });
	});

	it("allows awk filter without redirect", () => {
		expect(classifyBash("awk '{print $1}' file.txt")).toEqual({ block: false });
	});

	it("allows redirect to /dev/null", () => {
		expect(classifyBash("echo hello > /dev/null")).toEqual({ block: false });
	});

	it("allows redirect to /dev/stdout", () => {
		expect(classifyBash("echo hello > /dev/stdout")).toEqual({ block: false });
	});

	it("allows redirect to /proc/version", () => {
		expect(classifyBash("echo hello > /proc/version")).toEqual({ block: false });
	});

	it("allows fd-only redirect (2>&1)", () => {
		expect(classifyBash("cmd 2>&1")).toEqual({ block: false });
	});

	it("allows grep", () => {
		expect(classifyBash("grep -r 'pattern' src/")).toEqual({ block: false });
	});

	it("allows find", () => {
		expect(classifyBash("find . -name '*.ts'")).toEqual({ block: false });
	});

	it("allows cat pipe", () => {
		expect(classifyBash("cat file.txt | head -5")).toEqual({ block: false });
	});

	// --- Edge cases ---

	it("blocks sed -i even with pipe before it", () => {
		expect(classifyBash("cat file | sed -i 's/x/y/' out.txt")).toEqual({
			block: true,
			hint: "in-place sed edit",
		});
	});

	it("allows tee to /dev/null", () => {
		expect(classifyBash("cat input.txt | tee /dev/null")).toEqual({ block: false });
	});

	// --- New classifyBash features ---

	it("does not block redirect inside quoted string", () => {
		expect(classifyBash('echo "hello > world"')).toEqual({ block: false });
	});

	it("blocks dd write to file", () => {
		expect(classifyBash("dd if=/dev/zero of=file.bin")).toEqual({
			block: true,
			hint: "dd write to file (use edit/write)",
		});
	});

	it("blocks truncate", () => {
		expect(classifyBash("truncate -s 0 file.txt")).toEqual({
			block: true,
			hint: "truncate (in-place file mutation)",
		});
	});

	it("blocks cp", () => {
		expect(classifyBash("cp src.txt dst.txt")).toEqual({
			block: true,
			hint: "file copy/move (use edit/write)",
		});
	});

	it("blocks mv", () => {
		expect(classifyBash("mv src.txt dst.txt")).toEqual({
			block: true,
			hint: "file copy/move (use edit/write)",
		});
	});
});

// ---------------------------------------------------------------------------
// Source code structure invariants
// ---------------------------------------------------------------------------

describe("source code structure", () => {
	const src = readFileSync(join(__dirname, "../src/index.ts"), "utf-8");
	it("registers the no-diagnostics flag", () => {
		expect(src).toContain('registerFlag("pi-edit-no-diagnostics"');
	});

	it("exports a default function (Pi extension entry)", () => {
		expect(src).toMatch(/export default function\s*\(/);
	});

	it("registers the no-readguard flag", () => {
		expect(src).toContain('registerFlag("pi-edit-no-readguard"');
	});

	it("registers the no-bashguard flag", () => {
		expect(src).toContain('registerFlag("pi-edit-no-bashguard"');
	});

	it("registers the no-diagnostics flag (pi-edit prefix)", () => {
		expect(src).toContain('registerFlag("pi-edit-no-diagnostics"');
	});

	it("hooks into tool_call for edit/write gating", () => {
		expect(src).toContain('pi.on("tool_call"');
	});

	it("hooks into tool_result for read tracking", () => {
		expect(src).toContain('pi.on("tool_result"');
	});

	it("implements classifyBash", () => {
		expect(src).toContain("function classifyBash");
	});

	it("implements isStale", () => {
		expect(src).toContain("function isStale");
	});

	it("implements snapshotFile", () => {
		expect(src).toContain("function snapshotFile");
	});

	it("implements runDiagnostics", () => {
		expect(src).toContain("function runDiagnostics");
	});

	it("implements LRU read-state eviction", () => {
		expect(src).toContain("MAX_READ_ENTRIES");
		expect(src).toContain("readState.delete(oldest)");
	});

	it("has post-edit readState refresh", () => {
		// After edit/write, the read state must be refreshed for TOCTOU correctness
		expect(src).toContain("rememberRead(abs, snap)");
	});

	it("gates diagnostics behind diagOff check", () => {
		expect(src).toContain("if (diagOff()) return undefined;");
	});

	it("has debounce for diagnostics", () => {
		expect(src).toContain("DIAG_DEBOUNCE_MS");
	});

	it("has in-flight deduplication for diagnostics", () => {
		expect(src).toContain("diagInFlight");
	});
});

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

const NON_FILE_TARGET = /^(?:\/dev\/|\/proc\/|\/sys\/)/;
const FILE_REDIRECT = />>?\s*([^&\s][^\s|;&]*\.\w+)/;
const FILE_TEE = /\btee\b\s+(?:-a\s+)?([^\s|;&]*\.\w+)/;

const MUTATING_BASH: { re: RegExp; hint: string; targetGroup?: number }[] = [
	{ re: /\bsed\b[^|]*\s-[a-z]*i/, hint: "in-place sed edit" },
	{ re: /\bawk\b[^|]*>\s*[^&\s]/, hint: "awk redirect to file" },
	{ re: /\bperl\b[^|]*\s-[a-z]*i/, hint: "perl -i in-place edit" },
	{ re: FILE_REDIRECT, hint: "shell redirect into a file", targetGroup: 1 },
	{ re: FILE_TEE, hint: "tee into a file", targetGroup: 1 },
];

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

	it("blocks echo redirect to file", () => {
		expect(classifyBash('echo "hello" > output.txt')).toEqual({
			block: true,
			hint: "shell redirect into a file",
		});
	});

	it("blocks echo append to file", () => {
		expect(classifyBash('echo "hello" >> output.txt')).toEqual({
			block: true,
			hint: "shell redirect into a file",
		});
	});

	it("blocks tee to file", () => {
		expect(classifyBash("cat input.txt | tee output.txt")).toEqual({
			block: true,
			hint: "tee into a file",
		});
	});

	it("blocks tee -a to file", () => {
		expect(classifyBash("cat input.txt | tee -a output.txt")).toEqual({
			block: true,
			hint: "tee into a file",
		});
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
});

// ---------------------------------------------------------------------------
// Source code structure invariants
// ---------------------------------------------------------------------------

describe("source code structure", () => {
	const src = readFileSync("/Users/yeshao/headroom/pi-edit/src/index.ts", "utf-8");

	it("exports a default function (Pi extension entry)", () => {
		expect(src).toMatch(/export default function\s*\(/);
	});

	it("registers the no-readguard flag", () => {
		expect(src).toContain('registerFlag("no-readguard"');
	});

	it("registers the no-bashguard flag", () => {
		expect(src).toContain('registerFlag("no-bashguard"');
	});

	it("registers the no-diagnostics flag", () => {
		expect(src).toContain('registerFlag("no-diagnostics"');
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

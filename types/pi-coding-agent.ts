// Minimal type stubs for @earendil-works/pi-coding-agent used by pi-edit.ts.
// Only the members actually referenced at runtime are needed; the rest are
// `import type` and are erased by TypeScript before any test runs.

export interface ToolResultEvent {
	toolName: string;
	input: Record<string, unknown>;
	isError: boolean;
	content: Array<{ type: string; text?: string }>;
}

export interface ToolResultContext {
	cwd: string;
	mode?: string;
}

export interface ExtensionAPI {
	registerFlag(
		name: string,
		opts: { type: string; default: unknown; description: string },
	): void;
	getFlag(name: string): unknown;
	on(
		event: "tool_result",
		handler: (
			event: ToolResultEvent,
			ctx: ToolResultContext,
		) => Promise<unknown>,
	): void;
	on(
		event: "tool_call",
		handler: (
			event: ToolCallEvent,
			ctx: ToolResultContext,
		) => Promise<unknown>,
	): void;
	exec(
		cmd: string,
		args: string[],
		opts: { cwd: string; timeout: number },
	): Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface ToolCallEvent {
	toolName: string;
	input: Record<string, unknown>;
}

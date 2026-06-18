import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
	resolve: {
		alias: {
			"@earendil-works/pi-coding-agent": resolve(
				__dirname,
				"types/pi-coding-agent.ts",
			),
		},
	},
	test: {
		globals: true,
	},
});

import { ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { describe, it } from "node:test";

describe("codex auth isolation", () => {
	it("does not copy host auth file into container", () => {
		const adapterPath = join(cwd(), "src/switchyard/adapter/codex.mjs");
		const source = readFileSync(adapterPath, "utf8");

		strictEqual(
			source.includes("docker cp ~/.codex/auth.json"),
			false,
			"host auth copy is forbidden",
		);
		ok(
			source.includes("bws-get"),
			"BWS-based auth injection should be present",
		);
	});
});

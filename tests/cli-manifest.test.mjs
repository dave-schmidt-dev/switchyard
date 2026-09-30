import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(__dirname, "..", "ops", "macos-vm", "cli-manifest.txt");

const PROVIDERS = [
	"claude",
	"codex",
	"agy",
	"cursor-agent",
	"copilot",
	"opencode",
	"vibe",
];
const KINDS = ["script", "npm", "brew"];
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9][0-9A-Za-z.+_-]*$/;

const rows = readFileSync(MANIFEST, "utf8")
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line.length > 0 && !line.startsWith("#"))
	.map((line) => line.split("|"));

describe("cli-manifest.txt", () => {
	it("has one well-formed row per provider", () => {
		assert.equal(rows.length, PROVIDERS.length);
		const seen = new Map();
		for (const fields of rows) {
			assert.equal(fields.length, 6, `expected 6 fields, got ${fields.length}`);
			const [provider, kind, ref, detail, sha256, version] = fields;
			assert.ok(PROVIDERS.includes(provider), `unknown provider ${provider}`);
			assert.ok(KINDS.includes(kind), `unknown kind ${kind}`);
			assert.ok(ref.length > 0, "empty ref");
			assert.ok(detail.length > 0, "empty detail");
			assert.match(sha256, SHA256);
			assert.match(version, VERSION);
			assert.equal(
				seen.get(provider),
				undefined,
				`duplicate provider ${provider}`,
			);
			seen.set(provider, true);
		}
		for (const provider of PROVIDERS) {
			assert.ok(seen.has(provider), `missing provider ${provider}`);
		}
	});
});

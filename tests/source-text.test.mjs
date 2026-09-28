import { strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sourceText } from "./helpers/source-text.mjs";

const TEST_FILE_URL = new URL("./source-text.test.mjs", import.meta.url);

describe("sourceText", () => {
	it("reads a file URL", () => {
		strictEqual(
			sourceText(TEST_FILE_URL),
			readFileSync(fileURLToPath(TEST_FILE_URL), "utf8"),
		);
	});

	it("joins mixed file URL and repository-relative string inputs", () => {
		const expected = [
			readFileSync(fileURLToPath(TEST_FILE_URL), "utf8"),
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		].join("\n");

		strictEqual(sourceText(TEST_FILE_URL, "package.json"), expected);
	});
});

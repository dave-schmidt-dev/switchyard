import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Reads repository-relative strings or file URLs as UTF-8 and joins their contents with newlines. */
export function sourceText(...repoRelativePaths) {
	return repoRelativePaths
		.map((repoRelativePath) =>
			readFileSync(
				repoRelativePath instanceof URL
					? fileURLToPath(repoRelativePath)
					: resolve(REPOSITORY_ROOT, repoRelativePath),
				"utf8",
			),
		)
		.join("\n");
}

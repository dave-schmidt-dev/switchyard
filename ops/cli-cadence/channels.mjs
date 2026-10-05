// Where each provider CLI publishes its latest STABLE release, and how the
// cadence stages a candidate without touching the host's live install.
//
// The channel is the one the pin is installed from (ops/macos-vm/cli-manifest.txt),
// never whichever package manager happens to be ahead: Homebrew shipped
// opencode 2.0.20 while npm's opencode-ai `latest` was still 1.18.x, and the
// unpinned Homebrew upgrade is what broke agent-headless on 2026-10-02.

/** Each CLI's stable channel. `manifest` rows are pinned in cli-manifest.txt. */
export const CHANNELS = Object.freeze({
	claude: Object.freeze({
		harness: "claude",
		manifest: true,
		// npm `latest` runs ahead of the vendor's stable line; `stable` is the pin.
		source: Object.freeze({
			kind: "npm",
			pkg: "@anthropic-ai/claude-code",
			tag: "stable",
		}),
		stage: "npm",
		bin: "claude",
	}),
	codex: Object.freeze({
		harness: "codex",
		manifest: true,
		source: Object.freeze({ kind: "npm", pkg: "@openai/codex", tag: "latest" }),
		stage: "npm",
		bin: "codex",
	}),
	copilot: Object.freeze({
		harness: "copilot",
		manifest: true,
		source: Object.freeze({
			kind: "npm",
			pkg: "@github/copilot",
			tag: "latest",
		}),
		stage: "npm",
		bin: "copilot",
	}),
	opencode: Object.freeze({
		harness: "opencode",
		manifest: true,
		source: Object.freeze({ kind: "npm", pkg: "opencode-ai", tag: "latest" }),
		stage: "npm",
		bin: "opencode",
		// Reported, never followed: see the header.
		informational: Object.freeze({ kind: "brew", formula: "opencode" }),
	}),
	vibe: Object.freeze({
		harness: "vibe",
		manifest: true,
		// The guest installs the Homebrew formula (and hashes its source), the
		// host installs from PyPI with uv; the formula is the one that can lag.
		source: Object.freeze({ kind: "brew", formula: "mistral-vibe" }),
		stage: "pypi",
		pypi: "mistral-vibe",
		bin: "vibe",
	}),
	"cursor-agent": Object.freeze({
		harness: "cursor",
		manifest: true,
		source: Object.freeze({
			kind: "cursor-installer",
			url: "https://cursor.com/install",
		}),
		stage: "installer",
		bin: "cursor-agent",
	}),
	agy: Object.freeze({
		harness: "agy",
		manifest: true,
		source: Object.freeze({
			kind: "agy-installer",
			url: "https://antigravity.google/cli/install.sh",
		}),
		stage: "installer",
		bin: "agy",
	}),
	// agent-headless only: not in the golden image, so not in the manifest. The
	// cadence tracks it against the host install and gates it on the same
	// flag contract (its call sites come from ~/.agent's contract file).
	pi: Object.freeze({
		harness: null,
		manifest: false,
		source: Object.freeze({
			kind: "npm",
			pkg: "@earendil-works/pi-coding-agent",
			tag: "latest",
		}),
		stage: "npm",
		bin: "pi",
	}),
});

// Cursor publishes stable builds as YYYY.MM.DD-<hash>; for everyone else a
// semver `-suffix` (1.0.92-5, 0.159.0-alpha.12) marks a prerelease.
const DATED_BUILD = /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/u;

/** A release version with no prerelease marker. */
export function isStableVersion(version) {
	if (typeof version !== "string" || !/^[0-9][0-9A-Za-z.+_-]*$/u.test(version))
		return false;
	return !version.includes("-") || DATED_BUILD.test(version);
}

/**
 * Compare dotted numeric versions (cursor's 2026.09.28-64d2043 compares on its
 * date). A trailing build hash never decides the order.
 */
export function compareVersions(left, right) {
	const parts = (version) =>
		String(version)
			.split("-")[0]
			.split(".")
			.map((part) => Number.parseInt(part, 10) || 0);
	const a = parts(left);
	const b = parts(right);
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const delta = (a[index] ?? 0) - (b[index] ?? 0);
		if (delta !== 0) return Math.sign(delta);
	}
	return 0;
}

/** cursor.com/install names exactly one downloads.cursor.com/lab/<version>. */
export function cursorVersionFromInstaller(text) {
	const versions = new Set(
		[
			...String(text).matchAll(/downloads\.cursor\.com\/lab\/([^/"'\s]+)/gu),
		].map((match) => match[1]),
	);
	return versions.size === 1 ? [...versions][0] : null;
}

/** The agy installer's DOWNLOAD_BASE_URL, whose manifest names the version. */
export function agyBaseUrlFromInstaller(text) {
	const match = /DOWNLOAD_BASE_URL=["']([^"']+)["']/u.exec(String(text));
	return match?.[1]?.startsWith("https://")
		? match[1].replace(/\/$/u, "")
		: null;
}

/**
 * Latest stable version on a CLI's channel. `io` supplies network access:
 * { npmView(pkg, field), brewStable(formula), fetchText(url), fetchJson(url) }.
 * Throws with the CLI name when the channel cannot be read or is not stable.
 */
export async function resolveLatestStable(name, io) {
	const { source } = CHANNELS[name];
	let version;
	if (source.kind === "npm") {
		version = (await io.npmView(source.pkg, `dist-tags.${source.tag}`)).trim();
	} else if (source.kind === "brew") {
		version = await io.brewStable(source.formula);
	} else if (source.kind === "cursor-installer") {
		version = cursorVersionFromInstaller(await io.fetchText(source.url));
	} else if (source.kind === "agy-installer") {
		const base = agyBaseUrlFromInstaller(await io.fetchText(source.url));
		if (!base) throw new Error(`${name}: installer has no DOWNLOAD_BASE_URL`);
		version = (await io.fetchJson(`${base}/manifests/darwin_arm64.json`))
			?.version;
	}
	if (!isStableVersion(version))
		throw new Error(
			`${name}: channel returned no stable version (${version ?? "none"})`,
		);
	return version;
}

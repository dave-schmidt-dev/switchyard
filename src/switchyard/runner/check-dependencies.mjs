import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

function trustedManifestMatches(projectPath, clone, name) {
	try {
		const hostPath = join(projectPath, name);
		const candidatePath = join(clone, name);
		const host = lstatSync(hostPath);
		const candidate = lstatSync(candidatePath);
		return (
			host.isFile() &&
			candidate.isFile() &&
			host.size > 0 &&
			host.size <= MAX_MANIFEST_BYTES &&
			host.size === candidate.size &&
			readFileSync(hostPath).equals(readFileSync(candidatePath))
		);
	} catch {
		return false;
	}
}

function containedRelativeReference(clone, relative) {
	if (!relative || isAbsolute(relative) || relative.includes("\0"))
		return false;
	try {
		const target = realpathSync(resolve(clone, relative));
		return target.startsWith(`${realpathSync(clone)}${sep}`);
	} catch {
		return false;
	}
}

function containedFileReference(clone, value) {
	return (
		value.startsWith("file:") &&
		containedRelativeReference(clone, value.slice(5))
	);
}

function safePackageSource(clone, value) {
	if (typeof value !== "string") return false;
	if (value.startsWith("file:")) return containedFileReference(clone, value);
	if (
		/^(?:git\+|git:|ssh:|http:)/iu.test(value) ||
		(/^[a-z][a-z0-9+.-]*:/iu.test(value) &&
			!value.startsWith("https:") &&
			!value.startsWith("npm:"))
	)
		return false;
	if (!value.startsWith("https:")) return true;
	try {
		const url = new URL(value);
		return !url.username && !url.password && !url.search && !url.hash;
	} catch {
		return false;
	}
}

function safeResolvedSource(clone, value, entry) {
	return (
		typeof value === "string" &&
		(entry.link === true
			? containedRelativeReference(clone, value)
			: value.startsWith("file:")
				? containedFileReference(clone, value)
				: value.startsWith("https:") && safePackageSource(clone, value))
	);
}

function safeDependencySources(clone) {
	try {
		const manifest = JSON.parse(
			readFileSync(join(clone, "package.json"), "utf8"),
		);
		const lock = JSON.parse(
			readFileSync(join(clone, "package-lock.json"), "utf8"),
		);
		if (![2, 3].includes(lock.lockfileVersion) || !lock.packages) return false;
		for (const group of [
			manifest.dependencies,
			manifest.devDependencies,
			manifest.optionalDependencies,
		]) {
			for (const source of Object.values(group ?? {}))
				if (!safePackageSource(clone, source)) return false;
		}
		for (const entry of Object.values(lock.packages)) {
			if (!entry || typeof entry !== "object") return false;
			if (
				entry.resolved !== undefined &&
				!safeResolvedSource(clone, entry.resolved, entry)
			)
				return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Use the host's existing npm tarball cache only for a trusted, unchanged
 * manifest pair. The caller runs the fixed npm CLI with scripts and network
 * disabled; provider-edited checks still run separately under Seatbelt.
 */
export function trustedOfflineNpmEnv(
	projectPath,
	clone,
	runtimeEnv,
	cachePath = join(homedir(), ".npm"),
) {
	if (
		!trustedManifestMatches(projectPath, clone, "package.json") ||
		!trustedManifestMatches(projectPath, clone, "package-lock.json") ||
		!safeDependencySources(clone)
	)
		return null;
	try {
		// A project .npmrc can redirect npm to a credentialed registry or change
		// lifecycle behavior; this narrow setup never consumes one.
		lstatSync(join(clone, ".npmrc"));
		return null;
	} catch (error) {
		if (error?.code !== "ENOENT") return null;
	}
	let cache;
	let userConfig;
	let globalConfig;
	try {
		cache = realpathSync(cachePath);
		if (!lstatSync(cache).isDirectory()) return null;
		userConfig = join(runtimeEnv.HOME, "npm-userrc");
		globalConfig = join(runtimeEnv.HOME, "npm-globalrc");
		writeFileSync(userConfig, "", { flag: "wx", mode: 0o600 });
		writeFileSync(globalConfig, "", { flag: "wx", mode: 0o600 });
	} catch {
		return null;
	}
	return {
		...runtimeEnv,
		npm_config_cache: cache,
		npm_config_userconfig: userConfig,
		npm_config_globalconfig: globalConfig,
		npm_config_logs_dir: runtimeEnv.HOME,
		npm_config_offline: "true",
		npm_config_ignore_scripts: "true",
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
		npm_config_fetch_retries: "0",
	};
}

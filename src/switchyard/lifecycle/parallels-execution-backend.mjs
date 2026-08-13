// Parallels lifecycle backend.
//
// The VM name is the ownership record: no sidecar file is part of this
// backend. Bulk transfer is deliberately a host-memory HTTP hop; the
// prlctl stdin channel is reserved for tiny control rules, never tar bytes.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { basename, dirname } from "node:path";

import { ExecutionBackend } from "./execution-backend.mjs";

export const PARALLELS_WORKING_PREFIX = "switchyard-work-";
const DEFAULT_AQUA_TIMEOUT_MS = 30_000;
const DEFAULT_AQUA_POLL_MS = 250;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UUID =
	/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}?$/i;
const SAFE_GUEST_PATH = /^\/[A-Za-z0-9._+@%+=:,\-/]*$/;
const SAFE_USER = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const DEFAULT_TRANSFER_HOST = "10.211.55.2";
// Bind on the Parallels host-only interface. Binding all interfaces leaves
// the listener reachable from unrelated host networks and was not reachable
// from the guest on this substrate's shared bridge.
const DEFAULT_TRANSFER_LISTEN_HOST = DEFAULT_TRANSFER_HOST;
const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
const PROVIDER_PID_MARKER_PREFIX = "/tmp/switchyard-provider-";
const INDEX_LOCK_PATH = "/project/.git/index.lock";
const KILL_GUEST_PROCESS_TREE = String.raw`
set -eu
root="$1"

children() {
  /bin/ps -axo pid=,ppid= | /usr/bin/awk -v parent="$1" '$2 == parent { print $1 }'
}

collect_descendants() {
  for child in $(children "$1"); do
    printf '%s\n' "$child"
    collect_descendants "$child"
  done
}

alive() {
  /bin/ps -axo pid=,state= | /usr/bin/awk -v target="$1" '$1 == target && $2 !~ /^Z/ { found = 1 } END { exit(found ? 0 : 1) }'
}

signal_tree() {
  signal="$1"
  pid="$2"
  for child in $(collect_descendants "$pid"); do
    /bin/kill "-$signal" "$child" 2>/dev/null || true
  done
  /bin/kill "-$signal" "$pid" 2>/dev/null || true
}

signal_tree TERM "$root"
for _ in $(/usr/bin/seq 1 20); do
  survivors=""
  alive "$root" && survivors="$root"
  descendants="$(collect_descendants "$root")"
  if [ -n "$descendants" ]; then
    if [ -n "$survivors" ]; then
      survivors="$survivors $descendants"
    else
      survivors="$descendants"
    fi
  fi
  [ -z "$survivors" ] && exit 0
  /bin/sleep 0.05
done

signal_tree KILL "$root"
/bin/sleep 0.05
survivors=""
alive "$root" && survivors="$root"
descendants="$(collect_descendants "$root")"
if [ -n "$descendants" ]; then
  if [ -n "$survivors" ]; then
    survivors="$survivors $descendants"
  else
    survivors="$descendants"
  fi
fi
[ -z "$survivors" ]
`;

// This helper runs in a separate Node process because the synchronous
// lifecycle API blocks the caller's event loop while prlctl is running. The
// helper owns only an HTTP listener and an async prlctl child; all payloads
// remain in process memory and are framed back to the parent over stdout.
const BULK_TRANSFER_HELPER = String.raw`
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const input = readFileSync(0);
const newline = input.indexOf(10);
if (newline < 0) throw new Error("missing transfer header");
const config = JSON.parse(input.subarray(0, newline).toString("utf8"));
const payload = input.subarray(newline + 1);
const token = randomUUID();
const expectedPath = "/" + token;
const maxBytes = config.maxBytes;
let received = null;

function run(args, stdin = null) {
  return new Promise((resolve, reject) => {
    const child = spawn("prlctl", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8").slice(0, 2000); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error("prlctl failed (" + (code ?? signal ?? "unknown") + "): " + stderr.trim()));
    });
    child.stdin.end(stdin);
  });
}

const server = createServer((request, response) => {
  if (request.url !== expectedPath) {
    response.writeHead(404).end();
    return;
  }
  if (config.direction === "push" && request.method === "GET") {
    response.writeHead(200, { "content-length": payload.length, "content-type": "application/octet-stream" });
    response.end(payload);
    return;
  }
  if (config.direction === "pull" && request.method === "PUT") {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
      else request.destroy(new Error("transfer exceeds configured limit"));
    });
    request.once("error", () => response.destroy());
    request.once("end", () => {
      received = Buffer.concat(chunks, size);
      response.writeHead(204).end();
    });
    return;
  }
  response.writeHead(405).end();
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, config.listenHost, resolve);
  });
  const address = server.address();
  const url = "http://" + config.transferHost + ":" + address.port + "/" + token;
  const rule = "pass out quick on en0 proto tcp from any to " + config.transferHost + " port " + address.port + "\n";
  try {
    await run(config.pfArgs, Buffer.from(rule, "utf8"));
    const guestArgs = config.guestArgs.map((value) => value.replaceAll("TRANSFER_URL", url));
    await run(guestArgs);
    if (config.direction === "pull" && !received) throw new Error("guest did not upload a tar");
  } finally {
    try { await run(config.cleanupArgs); } catch { /* cleanup is best effort */ }
  }
  server.close();
  const body = received ?? Buffer.alloc(0);
  const digest = createHash("sha256").update(config.direction === "push" ? payload : body).digest("hex");
  process.stdout.write(JSON.stringify({ bytes: config.direction === "push" ? payload.length : body.length, sha256: digest }) + "\n");
  if (config.direction === "pull") process.stdout.write(body);
} catch (error) {
  try { server.close(); } catch { /* already closed */ }
  process.stderr.write("bulk transfer failed: " + String(error?.message ?? "unknown") + "\n");
  process.exitCode = 1;
}
`;

function defaultSleep(milliseconds) {
	if (milliseconds <= 0) return;
	const atomics = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(atomics, 0, 0, milliseconds);
}

function defaultPidIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function outputText(value) {
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	if (typeof value === "string") return value;
	if (value && typeof value.stdout !== "undefined") {
		return outputText(value.stdout);
	}
	return "";
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function providerPidMarkerPath(workspaceId) {
	const digest = createHash("sha256").update(String(workspaceId)).digest("hex");
	return `${PROVIDER_PID_MARKER_PREFIX}${digest.slice(0, 32)}.pid`;
}

function validateGuestPath(value, label) {
	if (typeof value !== "string" || !SAFE_GUEST_PATH.test(value)) {
		throw new Error(`${label} must be an absolute safe guest path`);
	}
	if (value.split("/").includes("..")) {
		throw new Error(`${label} must not contain parent traversal`);
	}
	return value;
}

function validateUser(value) {
	if (typeof value !== "string" || !SAFE_USER.test(value)) {
		throw new Error("provider user must be a safe account name");
	}
	return value;
}

function resolveWorkspacePath(value, providerUser) {
	const user = validateUser(providerUser);
	const physicalRoot = `/Users/${user}/.switchyard/project`;
	if (value === "/project") return physicalRoot;
	if (value.startsWith("/project/")) {
		return `${physicalRoot}${value.slice("/project".length)}`;
	}
	return value;
}

function validateUid(value) {
	if (!/^\d+$/.test(String(value ?? "")) || Number(value) <= 0) {
		throw new Error("aquaUid must be a positive numeric uid");
	}
	return String(value);
}

function validateTransferHost(value) {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(value) ||
		value.includes("..")
	) {
		throw new Error("transferHost must be a safe host address");
	}
	return value;
}

function validateTar(value) {
	if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
		throw new TypeError("tar must be an in-memory Buffer or Uint8Array");
	}
	if (value.byteLength > MAX_TRANSFER_BYTES) {
		throw new Error("tar exceeds the configured in-memory transfer limit");
	}
	return Buffer.from(value);
}

function snapshotIdsFromOutput(output) {
	const text = outputText(output);
	const ids = new Set();
	try {
		const parsed = JSON.parse(text);
		const visit = (value) => {
			if (!value || typeof value !== "object") return;
			if (Array.isArray(value)) {
				for (const item of value) visit(item);
				return;
			}
			for (const [key, item] of Object.entries(value)) {
				if (
					/^(?:id|snapshot[_-]?id)$/i.test(key) &&
					typeof item === "string" &&
					item.length > 0
				) {
					ids.add(item);
				}
				visit(item);
			}
		};
		visit(parsed);
	} catch {
		for (const match of text.matchAll(
			/\{?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}?/gi,
		)) {
			ids.add(match[0]);
		}
	}
	return ids;
}

function snapshotDifference(after, before) {
	return [...after].filter((id) => !before.has(id));
}

function measurePathBytes(path) {
	const entry = lstatSync(path);
	if (!entry.isDirectory()) return entry.size;
	return readdirSync(path, { withFileTypes: true }).reduce((total, child) => {
		const childPath = `${path}/${child.name}`;
		return total + measurePathBytes(childPath);
	}, 0);
}

function diskBytesFromInfo(info, diskUsageFn = null) {
	const text = outputText(info);
	const image = text.match(/\bimage=['"]([^'"]+)['"]/i)?.[1];
	if (image) {
		const bytes = diskUsageFn ? diskUsageFn(image) : measurePathBytes(image);
		if (Number.isFinite(Number(bytes)) && Number(bytes) > 0) {
			return Number(bytes);
		}
	}
	const size = text.match(
		/\b(?:size|capacity)\s*[=:]\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?\b/i,
	);
	if (size) {
		const units = {
			B: 1,
			KB: 1024,
			MB: 1024 ** 2,
			GB: 1024 ** 3,
			TB: 1024 ** 4,
		};
		const bytes =
			Number(size[1]) * (units[String(size[2] ?? "B").toUpperCase()] ?? 1);
		if (Number.isFinite(bytes) && bytes > 0) return bytes;
	}
	throw new Error(
		"linked clone disk measurement was not present in prlctl output",
	);
}

function validateRunId(runId) {
	if (typeof runId !== "string" || !SAFE_RUN_ID.test(runId)) {
		throw new Error("runId must be a non-empty safe identifier");
	}
	return runId;
}

function validatePid(pid) {
	if (!Number.isInteger(pid) || pid <= 0) {
		throw new Error("creatorPid must be a positive integer");
	}
	return pid;
}

/**
 * Build the only VM name this backend may create or reclaim.
 * @param {string} runId
 * @param {number} creatorPid
 * @returns {string}
 */
export function buildParallelsWorkingName(runId, creatorPid) {
	return `${PARALLELS_WORKING_PREFIX}${validateRunId(runId)}-${validatePid(creatorPid)}`;
}

/**
 * Parse ownership from a VM name. The PID is the final hyphen-delimited
 * component, so run IDs may contain hyphens without weakening the proof.
 * @param {unknown} name
 * @returns {{name: string, runId: string, creatorPid: number}|null}
 */
export function parseParallelsWorkingName(name) {
	if (typeof name !== "string" || !name.startsWith(PARALLELS_WORKING_PREFIX)) {
		return null;
	}
	const remainder = name.slice(PARALLELS_WORKING_PREFIX.length);
	const separator = remainder.lastIndexOf("-");
	if (separator <= 0) return null;
	const runId = remainder.slice(0, separator);
	const pidText = remainder.slice(separator + 1);
	if (!SAFE_RUN_ID.test(runId) || !/^[1-9]\d*$/.test(pidText)) return null;
	return { name, runId, creatorPid: Number(pidText) };
}

/**
 * Validate the evidence required before selecting a linked clone.
 *
 * Parallels creates a snapshot on the golden image for a linked clone and
 * does not protect that image from destructive operations. A positive disk
 * measurement and finite clone-to-boot duration are therefore a prerequisite
 * for using `--linked`; missing or malformed evidence fails closed.
 * @param {unknown} measurement
 * @returns {{diskBytes: number, cloneToBootMs: number}}
 */
export function validateLinkedCloneMeasurement(measurement) {
	if (!measurement || typeof measurement !== "object") {
		throw new Error(
			"refusing linked clone: positive disk and finite clone-to-boot measurements are required",
		);
	}
	const diskBytes = Number(measurement.diskBytes ?? measurement.onDiskBytes);
	const cloneToBootMs = Number(measurement.cloneToBootMs ?? measurement.bootMs);
	if (
		!Number.isFinite(diskBytes) ||
		diskBytes <= 0 ||
		!Number.isFinite(cloneToBootMs) ||
		cloneToBootMs < 0
	) {
		throw new Error(
			"refusing linked clone: positive disk and finite clone-to-boot measurements are required",
		);
	}
	return { diskBytes, cloneToBootMs };
}

function parseVmList(output) {
	return outputText(output)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const fields = line.includes("\t")
				? line.split("\t").map((field) => field.trim())
				: line.split(/\s+/);
			if (fields.length < 3) return null;
			const [uuid, status, ...nameParts] = fields;
			const name = nameParts.join(" ").trim();
			if (!uuid || !status || !name || name.toLowerCase() === "name")
				return null;
			return {
				uuid,
				status,
				name,
				ownership: parseParallelsWorkingName(name),
			};
		})
		.filter(Boolean);
}

function isUuid(value) {
	return typeof value === "string" && UUID.test(value);
}

/**
 * Synchronous Parallels lifecycle implementation with injectable VM calls.
 *
 * `prlctlFn` receives `(argv, options)` and returns the command's stdout (or
 * an execFileSync-compatible Buffer/string). Supplying it, `sleepFn`,
 * `nowFn`, and `pidIsAlive` makes clone/boot/destroy/reclamation hermetic.
 * @public
 */
export class ParallelsExecutionBackend extends ExecutionBackend {
	constructor({
		prlctlFn,
		execFn,
		bulkTransferFn = null,
		sleepFn = defaultSleep,
		nowFn = Date.now,
		pidIsAlive = defaultPidIsAlive,
		creatorPid = process.pid,
		aquaUid = null,
		aquaTimeoutMs = DEFAULT_AQUA_TIMEOUT_MS,
		aquaPollMs = DEFAULT_AQUA_POLL_MS,
		goldenImage = null,
		measureLinkedCloneFn = null,
		diskUsageFn = null,
		requireLinkedCloneMeasurement = true,
		providerUser = "switchyard",
		transferHost = DEFAULT_TRANSFER_HOST,
		transferListenHost = DEFAULT_TRANSFER_LISTEN_HOST,
		maxTransferBytes = MAX_TRANSFER_BYTES,
	} = {}) {
		super();
		if (typeof prlctlFn === "function") {
			this.prlctlFn = prlctlFn;
		} else {
			const invoke = execFn ?? execFileSync;
			this.prlctlFn = (args, options = {}) =>
				invoke("prlctl", args, {
					encoding: "utf8",
					stdio: "pipe",
					...options,
				});
		}
		this.bulkTransferFn = bulkTransferFn;
		this.sleepFn = sleepFn;
		this.nowFn = nowFn;
		this.pidIsAlive = pidIsAlive;
		this.creatorPid = validatePid(creatorPid);
		this.aquaUid = aquaUid;
		this.aquaTimeoutMs = aquaTimeoutMs;
		this.aquaPollMs = aquaPollMs;
		this.goldenImage = goldenImage;
		this.measureLinkedCloneFn = measureLinkedCloneFn;
		this.diskUsageFn = diskUsageFn;
		this.linkedMeasurementReceipts = new WeakSet();
		this.linkedSnapshotsByUuid = new Map();
		this.requireLinkedCloneMeasurement = requireLinkedCloneMeasurement;
		this.providerUser = validateUser(providerUser);
		this.transferHost = validateTransferHost(transferHost);
		if (
			typeof transferListenHost !== "string" ||
			!/^[A-Za-z0-9.:-]+$/.test(transferListenHost)
		) {
			throw new Error("transferListenHost must be a safe host address");
		}
		this.transferListenHost = transferListenHost;
		if (!Number.isInteger(maxTransferBytes) || maxTransferBytes <= 0) {
			throw new Error("maxTransferBytes must be a positive integer");
		}
		this.maxTransferBytes = maxTransferBytes;
	}

	_call(args, options = {}) {
		return this.prlctlFn(args, options);
	}

	preflight() {
		return outputText(this._call(["--version"])).trim();
	}

	_buildAquaExecArgs(
		workspaceId,
		{ cwd = "/project", aquaUid, providerUser, recordPid = false } = {},
	) {
		const uid = validateUid(aquaUid ?? this.aquaUid);
		const user = validateUser(providerUser ?? this.providerUser);
		const resolvedCwd = resolveWorkspacePath(cwd, user);
		validateGuestPath(resolvedCwd, "cwd");
		const pidPath = providerPidMarkerPath(workspaceId);
		const shell = recordPid
			? `cd ${shellQuote(resolvedCwd)} && trap 'rm -f -- ${shellQuote(pidPath)}' EXIT && echo $$ > ${shellQuote(pidPath)} && exec "$@"`
			: `cd ${shellQuote(resolvedCwd)} && exec "$@"`;
		return [
			"exec",
			workspaceId,
			"launchctl",
			"asuser",
			uid,
			"sudo",
			"-u",
			user,
			"/bin/bash",
			"-lc",
			shellQuote(shell),
			// Parallels includes a named bash placeholder in "$@". `--` is the
			// conventional `$0` sentinel and keeps only the provider command in
			// the executed argument vector.
			"--",
		];
	}

	/**
	 * Return the exact provider transport prefix. The command appended by the
	 * caller runs in the provider's Aqua session and inherits its stdin,
	 * stdout, stderr, exit status, and killable prlctl process handle.
	 */
	execArgv(workspaceId, { cwd = "/project", aquaUid, providerUser } = {}) {
		return {
			command: "prlctl",
			args: this._buildAquaExecArgs(workspaceId, {
				cwd,
				aquaUid,
				providerUser,
				recordPid: true,
			}),
		};
	}

	/**
	 * Return the marker path used by execArgv for this VM workspace.
	 * @param {string} workspaceId
	 * @returns {string}
	 */
	providerPidPath(workspaceId) {
		return providerPidMarkerPath(workspaceId);
	}

	/** Execute one small control command through the same Aqua identity route. */
	execGuest(workspaceId, command, args = [], options = {}) {
		if (
			typeof command !== "string" ||
			!/^[A-Za-z0-9._+@%/=:-]+$/.test(command)
		) {
			throw new Error("guest command must be a safe executable name");
		}
		if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
			throw new TypeError("guest command arguments must be strings");
		}
		const guestArgs = [...args];
		if (
			command === "/bin/bash" &&
			guestArgs[0] === "-lc" &&
			typeof guestArgs[1] === "string"
		) {
			// prlctl reparses shell metacharacters in the bash script argument.
			// Quote the script so conditionals and pipelines reach bash intact.
			guestArgs[1] = shellQuote(guestArgs[1]);
		}
		return this._call(
			[...this._buildAquaExecArgs(workspaceId, options), command, ...guestArgs],
			options.prlctlOptions ?? {},
		);
	}

	/**
	 * Read a PID marker written by a future launch wrapper. Task 4.2 has no
	 * caller that needs a supervisor; this helper keeps the guest PID handoff
	 * explicit for the timeout task without adding one.
	 */
	getGuestPid(workspaceId, pidPath) {
		validateGuestPath(pidPath, "pidPath");
		const output = outputText(
			this.execGuest(workspaceId, "/bin/cat", [pidPath], { cwd: "/" }),
		).trim();
		if (!/^\d+$/.test(output) || Number(output) <= 0) {
			throw new Error("guest PID marker was missing or invalid");
		}
		return Number(output);
	}

	_runBulkTransfer({ direction, workspaceId, payload, guestArgs }) {
		const tar = direction === "push" ? validateTar(payload) : Buffer.alloc(0);
		// pf anchor names are bounded by the kernel's fixed buffer. The golden
		// ruleset already delegates this child namespace, so an 8-byte random
		// suffix is sufficient without exceeding that bound.
		const anchor = `com.apple/switchyard-c3/switchyard-transfer/${randomUUID()
			.replaceAll("-", "")
			.slice(0, 8)}`;
		const config = {
			direction,
			transferHost: this.transferHost,
			listenHost: this.transferListenHost,
			maxBytes: this.maxTransferBytes,
			guestArgs,
			pfArgs: ["exec", workspaceId, "/sbin/pfctl", "-a", anchor, "-f", "-"],
			cleanupArgs: [
				"exec",
				workspaceId,
				"/sbin/pfctl",
				"-a",
				anchor,
				"-F",
				"all",
			],
		};
		const descriptor = { ...config, workspaceId, tar };
		if (typeof this.bulkTransferFn === "function") {
			const result = this.bulkTransferFn(descriptor);
			if (direction === "pull") return validateTar(result);
			return {
				bytes: tar.length,
				sha256: createHash("sha256").update(tar).digest("hex"),
				...(result && typeof result === "object" ? result : {}),
			};
		}

		const input = Buffer.concat([
			Buffer.from(`${JSON.stringify(config)}\n`, "utf8"),
			tar,
		]);
		const result = spawnSync(
			process.execPath,
			["--input-type=module", "-e", BULK_TRANSFER_HELPER],
			{
				input,
				encoding: null,
				maxBuffer: this.maxTransferBytes + 1024 * 1024,
			},
		);
		if (result.error || result.status !== 0) {
			const detail = outputText(result.stderr).trim();
			throw new Error(
				detail
					? `Parallels bulk transfer failed: ${detail}`
					: "Parallels bulk transfer failed",
			);
		}
		const output = Buffer.from(result.stdout ?? Buffer.alloc(0));
		const separator = output.indexOf(10);
		if (separator < 0)
			throw new Error("Parallels bulk transfer returned no receipt");
		let receipt;
		try {
			receipt = JSON.parse(output.subarray(0, separator).toString("utf8"));
		} catch {
			throw new Error("Parallels bulk transfer returned an invalid receipt");
		}
		if (direction === "pull")
			return validateTar(output.subarray(separator + 1));
		return receipt;
	}

	/**
	 * Transfer a tar to a guest directory through a temporary host HTTP
	 * endpoint. The endpoint is permitted by one guest-only pf anchor and the
	 * anchor is flushed in the helper's finally path.
	 */
	pushTar(workspaceId, tar, destination = "/project", options = {}) {
		const user = validateUser(options.providerUser ?? this.providerUser);
		const resolvedDestination = resolveWorkspacePath(destination, user);
		validateGuestPath(resolvedDestination, "destination");
		const script =
			`set -o pipefail; /bin/mkdir -p -- ${shellQuote(resolvedDestination)} && ` +
			`/usr/bin/curl --fail --silent --show-error --location --retry 15 --retry-delay 1 --retry-connrefused --output - TRANSFER_URL | ` +
			`/usr/bin/tar -xpf - -C ${shellQuote(resolvedDestination)}`;
		const guestArgs =
			options.providerUser || options.aquaUid
				? [
						...this._buildAquaExecArgs(workspaceId, {
							cwd: "/",
							aquaUid: options.aquaUid,
							providerUser: options.providerUser,
						}),
						"/bin/bash",
						"-lc",
						shellQuote(script),
					]
				: ["exec", workspaceId, "/bin/bash", "-lc", shellQuote(script)];
		const receipt = this._runBulkTransfer({
			direction: "push",
			workspaceId,
			payload: tar,
			guestArgs,
		});
		// BSD tar preserves the archive's root ownership even when the
		// extraction is initiated by the provider account. Normalize only the
		// destination subtree so generated Xcode projects and Git metadata are
		// writable without weakening the sealed system volume.
		this._call([
			"exec",
			workspaceId,
			"/usr/sbin/chown",
			"-R",
			user,
			resolvedDestination,
		]);
		return receipt;
	}

	/** Pull a guest path through the same in-memory HTTP endpoint. */
	pullTar(workspaceId, sourcePath, options = {}) {
		const user = validateUser(options.providerUser ?? this.providerUser);
		const resolvedSourcePath = resolveWorkspacePath(sourcePath, user);
		validateGuestPath(resolvedSourcePath, "sourcePath");
		const parent = dirname(resolvedSourcePath);
		const name = basename(resolvedSourcePath);
		const script =
			`/usr/bin/tar -cpf - -C ${shellQuote(parent)} ${shellQuote(name)} | ` +
			`/usr/bin/curl --fail --silent --show-error --request PUT --data-binary @- TRANSFER_URL`;
		const guestArgs =
			options.providerUser || options.aquaUid
				? [
						...this._buildAquaExecArgs(workspaceId, {
							cwd: "/",
							aquaUid: options.aquaUid,
							providerUser: options.providerUser,
						}),
						"/bin/bash",
						"-lc",
						shellQuote(script),
					]
				: ["exec", workspaceId, "/bin/bash", "-lc", shellQuote(script)];
		return this._runBulkTransfer({ direction: "pull", workspaceId, guestArgs });
	}

	/**
	 * Provision one Task 1.3 tar-provisionable credential into the provider's
	 * home. Unknown or non-tar providers fail closed; there is no Keychain copy
	 * fallback and no guest-side supervisor.
	 */
	provisionCredentials(
		workspaceId,
		{ provider, tar, aquaUid, providerUser } = {},
	) {
		const layouts = {
			codex: { directory: ".codex", file: "auth.json" },
			opencode: { directory: ".local/share/opencode", file: "auth.json" },
		};
		const layout = layouts[String(provider ?? "").toLowerCase()];
		if (!layout)
			throw new Error(
				`provider is not tar-provisionable on macOS: ${provider}`,
			);
		const user = validateUser(providerUser ?? this.providerUser);
		const destination = `/Users/${user}/${layout.directory}`;
		const credentialPath = `${destination}/${layout.file}`;
		const receipt = this.pushTar(workspaceId, tar, destination, {
			aquaUid,
			providerUser: user,
		});
		// The transfer runs as the provider account. This chmod is deliberately
		// also routed through Aqua so the auth check measures the same identity.
		this.execGuest(workspaceId, "/bin/chmod", ["600", credentialPath], {
			cwd: "/",
			aquaUid,
			providerUser: user,
		});
		return {
			provider: String(provider).toLowerCase(),
			path: credentialPath,
			...receipt,
		};
	}

	/** Inspect provider processes from the same Aqua identity as execution. */
	inspectProcess(workspaceId) {
		return this._call([
			...this._buildAquaExecArgs(workspaceId, { cwd: "/" }),
			"/bin/ps",
			"-axo",
			"pid=,command=",
		]);
	}

	/**
	 * Kill the recorded provider tree in a VM, then clear its stale Git lock.
	 * This is called through provider-lifecycle's existing cleanup parameter;
	 * it never destroys the VM.
	 * @param {string} command
	 * @param {string[]} args
	 * @returns {{workspaceId: string, pid: number}}
	 */
	cleanupProviderProcess(command, args, { onStatus } = {}) {
		if (command !== "prlctl" || !Array.isArray(args) || args[0] !== "exec") {
			return null;
		}
		const workspaceId = args[1];
		if (typeof workspaceId !== "string" || workspaceId.length === 0) {
			throw new Error("Parallels provider cleanup received no VM handle");
		}
		onStatus?.({
			phase: "execution",
			event: "provider_cleanup_started",
			status: "Terminating timed-out guest provider",
		});
		try {
			onStatus?.({
				phase: "execution",
				event: "provider_pid_observed",
				status: "Guest provider PID observed",
			});
			const pid = this.getGuestPid(
				workspaceId,
				this.providerPidPath(workspaceId),
			);
			this.execGuest(
				workspaceId,
				"/bin/bash",
				["-lc", KILL_GUEST_PROCESS_TREE, "switchyard-kill-tree", String(pid)],
				{ cwd: "/" },
			);
			onStatus?.({
				phase: "execution",
				event: "provider_tree_gone",
				status: "Guest provider tree confirmed gone",
			});
			this.execGuest(
				workspaceId,
				"/bin/rm",
				["-f", "--", this.providerPidPath(workspaceId)],
				{ cwd: "/" },
			);
			this.execGuest(workspaceId, "/bin/rm", ["-f", "--", INDEX_LOCK_PATH], {
				cwd: "/",
			});
			onStatus?.({
				phase: "execution",
				event: "provider_cleanup_complete",
				status: "Guest provider cleanup complete; VM retained",
			});
			return { workspaceId, pid };
		} catch (error) {
			onStatus?.({
				phase: "execution",
				event: "provider_cleanup_failed",
				status: "Guest provider cleanup could not confirm process exit",
			});
			throw error;
		}
	}

	listAll() {
		return parseVmList(this._call(["list", "-a", "-o", "uuid,status,name"]));
	}

	/**
	 * List only VMs whose complete reserved name proves a Switchyard owner.
	 * Foreign and malformed-prefix VMs are intentionally omitted.
	 */
	listManaged() {
		return this.listAll()
			.filter((entry) => entry.ownership)
			.map(({ ownership, ...entry }) => ({ ...entry, ...ownership }));
	}

	resolveHandle(handle, { allowUnmanaged = false } = {}) {
		const requested =
			handle && typeof handle === "object"
				? { uuid: handle.uuid, name: handle.name }
				: { uuid: isUuid(handle) ? handle : null, name: handle };
		if (!requested.uuid && !requested.name) {
			throw new Error("VM handle must be a Parallels UUID or VM name");
		}
		const entry = this.listAll().find(
			(candidate) =>
				(requested.uuid && candidate.uuid === requested.uuid) ||
				(requested.name && candidate.name === requested.name),
		);
		if (!entry) throw new Error("VM handle does not identify an existing VM");
		if (!entry.ownership && !allowUnmanaged) {
			throw new Error(`refusing unmanaged Parallels VM: ${entry.name}`);
		}
		return entry.ownership ? { ...entry, ...entry.ownership } : entry;
	}

	assertGoldenImageAvailable(goldenImage = this.goldenImage) {
		const owned = this.listManaged();
		if (owned.length > 0) {
			const names = owned.map((entry) => entry.name).join(", ");
			throw new Error(
				`refusing golden image ${goldenImage ?? "<unnamed>"}: owned clones exist (${names})`,
			);
		}
		return true;
	}

	/** Start the golden image only when no owned clone can reference it. */
	bootGoldenImage(goldenImage = this.goldenImage, options = {}) {
		if (!goldenImage) throw new Error("goldenImage is required");
		this.assertGoldenImageAvailable(goldenImage);
		const entry = this.resolveHandle(goldenImage, { allowUnmanaged: true });
		return this.boot(entry.uuid, {
			...options,
			skipGoldenCheck: true,
			allowUnmanaged: true,
		});
	}

	/**
	 * Boot a managed VM and wait for its Aqua launchd domain.
	 * @returns {{uuid: string, name: string, status: string}}
	 */
	boot(handle, options = {}) {
		const entry = this.resolveHandle(handle, {
			allowUnmanaged: options.allowUnmanaged === true,
		});
		const golden = options.goldenImage ?? this.goldenImage;
		if (!options.skipGoldenCheck && golden && entry.name === golden) {
			this.assertGoldenImageAvailable(golden);
		}
		this._call(["start", entry.uuid]);
		this.waitForAqua(entry.uuid, options);
		return { uuid: entry.uuid, name: entry.name, status: "running" };
	}

	waitForAqua(uuid, options = {}) {
		const uid = options.aquaUid ?? this.aquaUid;
		if (!/^\d+$/.test(String(uid ?? ""))) {
			throw new Error("aquaUid is required to probe the Aqua launchd domain");
		}
		const domain = `gui/${uid}`;
		const timeoutMs = options.aquaTimeoutMs ?? this.aquaTimeoutMs;
		const pollMs = options.aquaPollMs ?? this.aquaPollMs;
		const onStatus = options.onStatus;
		const startedAt = this.nowFn();
		const emit = (event) => {
			if (typeof onStatus === "function") onStatus(event);
		};

		for (;;) {
			try {
				this._call(["exec", uuid, "launchctl", "print", domain], {
					timeout: Math.max(1, Math.min(5_000, timeoutMs)),
				});
				emit({ type: "aqua-ready", uuid, domain });
				return;
			} catch (error) {
				const elapsedMs = this.nowFn() - startedAt;
				if (elapsedMs >= timeoutMs) {
					throw new Error(
						`Aqua domain ${domain} was not ready within ${timeoutMs}ms`,
						{ cause: error },
					);
				}
				emit({ type: "aqua-wait", uuid, domain, elapsedMs });
				this.sleepFn(Math.min(pollMs, timeoutMs - elapsedMs));
			}
		}
	}

	listSnapshotIds(goldenImage) {
		return snapshotIdsFromOutput(this._call(["snapshot-list", goldenImage]));
	}

	deleteSnapshots(goldenImage, snapshotIds) {
		for (const snapshotId of snapshotIds) {
			this._call(["snapshot-delete", goldenImage, "--id", snapshotId]);
		}
	}

	cleanupLinkedSnapshots(goldenImage, snapshotIds) {
		if (!goldenImage || !snapshotIds?.length) return;
		const remaining = snapshotDifference(
			this.listSnapshotIds(goldenImage),
			new Set(),
		).filter((snapshotId) => snapshotIds.includes(snapshotId));
		if (remaining.length > 0) this.deleteSnapshots(goldenImage, remaining);
	}

	/**
	 * Measure a real linked clone when no test probe is injected. The probe is
	 * created, booted, measured, and destroyed before its receipt is accepted by
	 * create(); a fabricated measurement object can never authorize cloning.
	 */
	measureLinkedCloneLifecycle(goldenImage, options = {}) {
		const golden = this.resolveHandle(goldenImage, { allowUnmanaged: true });
		if (!/^stopped$/i.test(String(golden.status ?? ""))) {
			throw new Error(
				"linked-clone measurement requires a stopped golden image",
			);
		}
		const beforeSnapshots = this.listSnapshotIds(goldenImage);
		const probeName = buildParallelsWorkingName(
			`measurement-${randomUUID()}`,
			this.creatorPid,
		);
		const startedAt = this.nowFn();
		let probe = null;
		let createdSnapshots = [];
		try {
			this._call(["clone", goldenImage, "--name", probeName, "--linked"]);
			probe = this.listAll().find((entry) => entry.name === probeName);
			if (!probe?.ownership)
				throw new Error("linked-clone probe returned no UUID");
			createdSnapshots = snapshotDifference(
				this.listSnapshotIds(goldenImage),
				beforeSnapshots,
			);
			const diskBytes = diskBytesFromInfo(
				this._call(["list", "-i", probe.uuid]),
				this.diskUsageFn,
			);
			this.boot(probe.uuid, options);
			return validateLinkedCloneMeasurement({
				diskBytes,
				cloneToBootMs: Math.max(0, this.nowFn() - startedAt),
			});
		} finally {
			if (probe?.uuid) {
				try {
					this.stopAndDelete(probe);
				} finally {
					this.cleanupLinkedSnapshots(goldenImage, createdSnapshots);
				}
			}
		}
	}

	/**
	 * Measure linked-clone evidence through a real probe or an injected
	 * hermetic probe. No caller-supplied object is accepted directly.
	 */
	measureLinkedClone(goldenImage, options = {}) {
		const measure =
			this.measureLinkedCloneFn ??
			((image, measureOptions) =>
				this.measureLinkedCloneLifecycle(image, measureOptions));
		const evidence = validateLinkedCloneMeasurement(
			measure(goldenImage, options),
		);
		const receipt = Object.freeze({
			...evidence,
			goldenImage,
			measuredAt: this.nowFn(),
		});
		this.linkedMeasurementReceipts.add(receipt);
		return receipt;
	}

	create(goldenImage, options = {}) {
		if (!goldenImage || typeof goldenImage !== "string") {
			throw new Error("goldenImage is required");
		}
		const runId = options.runId ?? randomUUID();
		const creatorPid = validatePid(options.creatorPid ?? this.creatorPid);
		const name = buildParallelsWorkingName(runId, creatorPid);
		const linked = options.linked ?? true;
		if (linked && this.requireLinkedCloneMeasurement) {
			const evidence = options.linkedCloneMeasurement;
			if (
				!evidence ||
				!this.linkedMeasurementReceipts.has(evidence) ||
				evidence.goldenImage !== goldenImage
			) {
				throw new Error(
					"linked clone requires a measurement receipt produced for this golden image",
				);
			}
		}

		const snapshotBefore = linked ? this.listSnapshotIds(goldenImage) : null;
		let createdSnapshots = [];
		let entry = null;
		try {
			const cloneArgs = ["clone", goldenImage, "--name", name];
			if (linked) cloneArgs.push("--linked");
			this._call(cloneArgs);
			if (linked) {
				createdSnapshots = snapshotDifference(
					this.listSnapshotIds(goldenImage),
					snapshotBefore,
				);
			}
			entry = this.listAll().find((candidate) => candidate.name === name);
			if (!entry?.ownership) {
				throw new Error(
					`cloned VM ${name} was not returned with a UUID handle`,
				);
			}
			if (linked) {
				this.linkedSnapshotsByUuid.set(entry.uuid, {
					goldenImage,
					snapshotIds: createdSnapshots,
				});
			}
			this.boot(entry.uuid, options);
			this._prepareWorkspace(
				entry.uuid,
				options.providerUser ?? this.providerUser,
			);
			return entry.uuid;
		} catch (error) {
			// The prlctl client can report an error after the bundle was created.
			// Probe and roll back unconditionally; an absent exact name is a
			// harmless no-op, while a partial create cannot be left behind.
			try {
				this.rollback(name, entry?.uuid, {
					goldenImage: linked ? goldenImage : null,
					snapshotBefore,
					snapshotIds: createdSnapshots,
				});
			} catch (rollbackError) {
				error.rollbackError = rollbackError;
			}
			throw error;
		}
	}

	/** Create the isolated logical workspace before the non-admin user enters it. */
	_prepareWorkspace(workspaceId, providerUser) {
		const user = validateUser(providerUser);
		const root = resolveWorkspacePath("/project", user);
		const parent = root.slice(0, root.lastIndexOf("/"));
		this._call(["exec", workspaceId, "/bin/mkdir", "-p", root]);
		this._call(["exec", workspaceId, "/usr/sbin/chown", user, parent, root]);
		this._call(["exec", workspaceId, "/bin/chmod", "700", parent, root]);
	}

	rollback(
		name,
		uuid = null,
		{ goldenImage = null, snapshotBefore = null, snapshotIds = [] } = {},
	) {
		const target =
			uuid ?? this.listAll().find((entry) => entry.name === name)?.uuid;
		if (!target) return false;
		this.stopAndDelete({ uuid: target, name });
		this.linkedSnapshotsByUuid.delete(target);
		if (goldenImage) {
			const candidates = snapshotIds.length
				? snapshotIds
				: snapshotBefore
					? snapshotDifference(
							this.listSnapshotIds(goldenImage),
							snapshotBefore,
						)
					: [];
			this.cleanupLinkedSnapshots(goldenImage, candidates);
		}
		return true;
	}

	stopAndDelete(entry, { forceOnly = false } = {}) {
		let forced = false;
		if (forceOnly) {
			if (!/^stopped$/i.test(String(entry.status ?? ""))) {
				this._call(["stop", entry.uuid, "--kill"]);
				forced = true;
			}
		} else {
			try {
				this._call(["stop", entry.uuid]);
			} catch {
				this._call(["stop", entry.uuid, "--kill"]);
				forced = true;
			}
		}
		try {
			this._call(["delete", entry.uuid]);
		} catch (error) {
			if (forced) throw error;
			this._call(["stop", entry.uuid, "--kill"]);
			forced = true;
			this._call(["delete", entry.uuid]);
		}
		return { uuid: entry.uuid, name: entry.name, forced };
	}

	destroy(handle) {
		const entry = this.resolveHandle(handle);
		const metadata = this.linkedSnapshotsByUuid.get(entry.uuid);
		const result = this.stopAndDelete(entry);
		this.linkedSnapshotsByUuid.delete(entry.uuid);
		if (metadata) {
			this.cleanupLinkedSnapshots(metadata.goldenImage, metadata.snapshotIds);
		}
		return result;
	}

	/** Reclaim only exact-prefix VMs whose embedded creator PID is dead. */
	reclaim({ dryRun = false, onStatus } = {}) {
		const result = { reclaimed: [], skipped: [], errors: [] };
		for (const entry of this.listManaged()) {
			const alive = this.pidIsAlive(entry.creatorPid);
			if (alive) {
				result.skipped.push({ ...entry, reason: "owner-alive" });
				onStatus?.({ type: "skip", name: entry.name, reason: "owner-alive" });
				continue;
			}
			if (dryRun) {
				result.reclaimed.push({ ...entry, dryRun: true });
				continue;
			}
			try {
				const removed = this.stopAndDelete(entry, { forceOnly: true });
				result.reclaimed.push(removed);
				onStatus?.({ type: "reclaimed", name: entry.name });
			} catch (error) {
				result.errors.push({ name: entry.name, reason: error.message });
			}
		}
		return result;
	}
}

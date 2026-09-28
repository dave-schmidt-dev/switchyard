import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	validateIdentifier,
	validateInvocationArgs,
	validateModelArg,
} from "../adapter/shell-safety.mjs";
export const CAPABILITY_CLASS = Object.freeze({
	high: "high",
	standard: "standard",
	low: "low",
});
export const CAPABILITY_CLASS_ORDER = Object.freeze({
	high: 3,
	standard: 2,
	low: 1,
});
const ROSTER_CAPABILITY_CLASSES = ["low", "standard", "high"];
const CAPABILITY_CLASS_RANK = { low: 0, standard: 1, high: 2 };
const MODEL_STATUSES = new Set(["active", "retired"]);
const EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"]);
const VARIANT_VALUES = new Set([
	"default",
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"thinking",
]);
export const PROVIDER_INVOCATION_VOCABULARY = Object.freeze({
	claude: Object.freeze({
		effort: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
		variant: Object.freeze([]),
		argv: Object.freeze({ effort: Object.freeze(["--effort", "<effort>"]) }),
	}),
	codex: Object.freeze({
		effort: Object.freeze(["low", "medium", "high", "xhigh"]),
		variant: Object.freeze([]),
		argv: Object.freeze({
			effort: Object.freeze(["-c", "model_reasoning_effort=<effort>"]),
		}),
	}),
	agy: Object.freeze({
		effort: Object.freeze([]),
		variant: Object.freeze([]),
		argv: Object.freeze({}),
	}),
	opencode: Object.freeze({
		effort: Object.freeze([]),
		variant: Object.freeze([
			"default",
			"none",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
			"thinking",
		]),
		argv: Object.freeze({ variant: Object.freeze(["--variant", "<variant>"]) }),
	}),
	vibe: Object.freeze({
		effort: Object.freeze([]),
		variant: Object.freeze([]),
		argv: Object.freeze({}),
	}),
	copilot: Object.freeze({
		effort: Object.freeze([]),
		variant: Object.freeze([]),
		argv: Object.freeze({}),
	}),
	cursor: Object.freeze({
		effort: Object.freeze([]),
		variant: Object.freeze([]),
		argv: Object.freeze({}),
	}),
});
const ADAPTER_ARGV_MAPPING = PROVIDER_INVOCATION_VOCABULARY;
export const QUALIFICATION_STATUS = Object.freeze({
	PROBE_QUALIFIED: "probe_qualified",
	DISPATCH_QUALIFIED: "dispatch_qualified",
	NOT_TRANSMITTABLE: "not_transmittable",
	TEMPORARILY_UNAVAILABLE: "temporarily_unavailable",
	STALE: "stale",
	FAILED: "failed_qualification",
	UNTESTED: "untested",
});
export const STALE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const KNOWN_PROVIDER_HARNESSES = [
	"claude",
	"codex",
	"agy",
	"cursor",
	"copilot",
	"opencode",
	"vibe",
];
function resolveRosterPath() {
	const envPath = process.env.SWITCHYARD_ROSTER_PATH;
	if (envPath) return envPath;
	return join(homedir(), ".agent", "roster.json");
}
function qualificationVariantKey(modelEntry, slot) {
	const selector = modelEntry?.selector;
	if (typeof selector !== "string" || !selector) return null;
	const effort = slot?.effort;
	if (typeof effort === "string" && effort) return `${selector}@${effort}`;
	const variant = slot?.variant;
	if (typeof variant === "string" && variant) return `${selector}@${variant}`;
	return selector;
}
function validateRosterStructure(data) {
	const violations = [];
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return ["roster root must be a JSON object"];
	}

	const models = data.models;
	if (!models || typeof models !== "object" || Array.isArray(models)) {
		violations.push("top-level 'models' must be an object");
	} else {
		for (const [key, entry] of Object.entries(models)) {
			if (!entry || typeof entry !== "object") {
				violations.push(`models['${key}'] must be an object`);
				continue;
			}
			if (!MODEL_STATUSES.has(entry.status)) {
				violations.push(
					`models['${key}'].status must be 'active' or 'retired', got ${JSON.stringify(entry.status)}`,
				);
			}
			try {
				validateModelArg(entry.selector, `models['${key}'].selector`);
			} catch (error) {
				violations.push(error.message);
			}
		}
	}
	const modelsDict =
		models && typeof models === "object" && !Array.isArray(models)
			? models
			: {};

	const targets = data.targets;
	if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
		violations.push("top-level 'targets' must be an object");
		return violations; // nothing further can be safely checked
	}

	for (const [targetId, target] of Object.entries(targets)) {
		if (!target || typeof target !== "object") {
			violations.push(`targets['${targetId}'] must be an object`);
			continue;
		}
		if (typeof target.harness !== "string" || !target.harness) {
			violations.push(
				`targets['${targetId}'].harness must be a non-empty string`,
			);
		}
		try {
			validateIdentifier(targetId, `targets['${targetId}'] target id`);
		} catch (error) {
			violations.push(error.message);
		}

		const slots = target.slots;
		if (slots === undefined) continue;
		if (typeof slots !== "object" || slots === null || Array.isArray(slots)) {
			violations.push(`targets['${targetId}'].slots must be an object`);
			continue;
		}

		for (const capabilityClass of ROSTER_CAPABILITY_CLASSES) {
			const slotList = slots[capabilityClass];
			if (slotList === undefined) continue;
			if (!Array.isArray(slotList)) {
				violations.push(
					`targets['${targetId}'].slots.${capabilityClass} must be an array`,
				);
				continue;
			}
			slotList.forEach((slot, idx) => {
				const where = `targets['${targetId}'].slots.${capabilityClass}[${idx}]`;
				if (!slot || typeof slot !== "object") {
					violations.push(`${where} must be an object`);
					return;
				}
				if (typeof slot.model_ref !== "string" || !slot.model_ref) {
					violations.push(`${where}.model_ref must be a non-empty string`);
				} else if (!(slot.model_ref in modelsDict)) {
					violations.push(
						`${where}.model_ref '${slot.model_ref}' does not resolve to any catalog model in 'models'`,
					);
				} else {
					try {
						validateModelArg(slot.model_ref, `${where}.model_ref`);
					} catch (error) {
						violations.push(error.message);
					}
				}
				if (slot.effort !== undefined && slot.effort !== null) {
					if (
						typeof slot.effort !== "string" ||
						!EFFORT_VALUES.has(slot.effort)
					) {
						violations.push(
							`${where}.effort must be one of: ${[...EFFORT_VALUES].join(", ")}`,
						);
					}
				}
				if (slot.variant !== undefined && slot.variant !== null) {
					if (
						typeof slot.variant !== "string" ||
						!VARIANT_VALUES.has(slot.variant)
					) {
						violations.push(
							`${where}.variant must be one of: ${[...VARIANT_VALUES].join(", ")}`,
						);
					}
				}
				if (slot.effort != null && slot.variant != null) {
					violations.push(`${where} must not declare both effort and variant`);
				}
				if (slot.invocation_args !== undefined) {
					try {
						validateInvocationArgs(slot.invocation_args, target.harness);
					} catch (error) {
						violations.push(
							`${where}.invocation_args invalid: ${error.message}`,
						);
					}
				}
			});
		}
	}

	return violations;
}
function loadRosterData() {
	const path = resolveRosterPath();

	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		throw new Error(`failed to read roster at '${path}': ${err.message}`);
	}

	let data;
	try {
		data = JSON.parse(text);
	} catch (err) {
		throw new Error(`roster at '${path}' is not valid JSON: ${err.message}`);
	}

	const violations = validateRosterStructure(data);
	if (violations.length > 0) {
		throw new Error(
			`roster at '${path}' failed structural validation:\n` +
				violations.map((v) => `  - ${v}`).join("\n"),
		);
	}

	return data;
}

export {
	CAPABILITY_CLASS_RANK,
	EFFORT_VALUES,
	KNOWN_PROVIDER_HARNESSES,
	loadRosterData,
	qualificationVariantKey,
	ROSTER_CAPABILITY_CLASSES,
	VARIANT_VALUES,
};

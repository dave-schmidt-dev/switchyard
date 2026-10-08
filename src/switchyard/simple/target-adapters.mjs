export const SIMPLE_PROVIDERS = Object.freeze([
	"claude-code",
	"codex",
	"antigravity",
	"antigravity-claude",
	"cursor",
	"opencode-go",
	"vibe",
	"vibe-code",
	"copilot",
	"copilot-student",
]);
export const SIMPLE_TARGET_ADAPTERS = Object.freeze([
	Object.freeze({
		targetId: "codex",
		harness: "codex",
		kind: "codex",
		selectors: null,
	}),
	Object.freeze({
		targetId: "antigravity",
		harness: "agy",
		kind: "agy",
		selectors: Object.freeze([
			"gemini-3.8-flash-medium",
			"gemini-3.8-flash-high",
		]),
	}),
	Object.freeze({
		targetId: "antigravity-claude",
		harness: "agy",
		kind: "agy",
		selectors: Object.freeze(["claude-sonnet-4-6"]),
	}),
	Object.freeze({
		targetId: "copilot-student",
		harness: "copilot",
		kind: "copilot",
		selectors: Object.freeze(["auto"]),
	}),
	Object.freeze({
		targetId: "vibe",
		harness: "vibe",
		kind: "bridge",
		defaultEligible: true,
		defaultCapabilities: Object.freeze(["low", "standard"]),
		capabilities: Object.freeze(["low", "standard"]),
		selectors: Object.freeze(["glm-5-3", "glm-5-3-medium"]),
		validateInvocationArgs: (args) => Array.isArray(args) && args.length === 0,
		expectedDescriptors: Object.freeze({
			low: Object.freeze({
				selector: "glm-5-3-medium",
				invocationArgs: Object.freeze([]),
			}),
			standard: Object.freeze({
				selector: "glm-5-3",
				invocationArgs: Object.freeze([]),
			}),
		}),
	}),
	Object.freeze({
		// Claude Code is subscription-backed and must be explicitly pinned.
		targetId: "claude-code",
		harness: "claude",
		kind: "native",
		defaultEligible: false,
		capabilities: Object.freeze(["low", "standard", "high"]),
		selectors: Object.freeze([
			"claude-haiku-5-5",
			"claude-sonnet-5-5",
			"claude-opus-5-5",
		]),
		validateInvocationArgs: (args) =>
			Array.isArray(args) &&
			args.length === 2 &&
			args[0] === "--effort" &&
			["low", "medium", "high", "xhigh", "max"].includes(args[1]),
	}),
	Object.freeze({
		// Native headless Vibe on Vibe's own login: spends the Vibe Code allowance.
		targetId: "vibe-code",
		harness: "vibe",
		kind: "native",
		defaultEligible: true,
		defaultCapabilities: Object.freeze(["low", "standard"]),
		capabilities: Object.freeze(["low", "standard"]),
		selectors: Object.freeze(["glm-5-3", "glm-5-3-medium"]),
		validateInvocationArgs: (args) => Array.isArray(args) && args.length === 0,
		expectedDescriptors: Object.freeze({
			low: Object.freeze({
				selector: "glm-5-3-medium",
				invocationArgs: Object.freeze([]),
			}),
			standard: Object.freeze({
				selector: "glm-5-3",
				invocationArgs: Object.freeze([]),
			}),
		}),
	}),
	Object.freeze({
		targetId: "opencode-go",
		harness: "opencode",
		kind: "bridge",
		defaultEligible: true,
		capabilities: Object.freeze(["low", "standard"]),
		selectors: Object.freeze(["opencode-go/deepseek-v4.1-flash"]),
		validateInvocationArgs: (args) =>
			Array.isArray(args) &&
			args.length === 2 &&
			args[0] === "--variant" &&
			["low", "max"].includes(args[1]),
		expectedDescriptors: Object.freeze({
			low: Object.freeze({
				selector: "opencode-go/deepseek-v4.1-flash",
				invocationArgs: Object.freeze(["--variant", "low"]),
			}),
			standard: Object.freeze({
				selector: "opencode-go/deepseek-v4.1-flash",
				invocationArgs: Object.freeze(["--variant", "max"]),
			}),
		}),
	}),
]);

import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { execute } from "../src/switchyard/adapter/vibe.mjs";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const DESCRIPTOR = validateInvocationDescriptor(
	{
		target_id: "vibe",
		model_ref: "mistral/mistral-medium-3.5",
		selector: "mistral-medium-3.5",
		effort: null,
		variant: null,
		invocation_args: [],
	},
	"vibe",
);
function options(executionBackend) {
	return {
		model: DESCRIPTOR.selector,
		resolvedTargetId: DESCRIPTOR.target_id,
		descriptorHarness: "vibe",
		invocationDescriptor: DESCRIPTOR,
		descriptorIdentity: DESCRIPTOR.descriptor_identity,
		executionBackend,
	};
}
describe("Vibe adapter", () => {
	it("reports the served model on a matching run", () => {
		const executionBackend = {
			execArgv(_workspaceId, candidate) {
				const servedProbe = candidate.argv.some(
					(arg) => typeof arg === "string" && arg.includes("logs/session"),
				);
				return {
					command: process.execPath,
					args: [
						"-e",
						servedProbe
							? 'process.stdout.write("glm-5-3\\n")'
							: 'process.stdout.write("vibe-ran")',
					],
				};
			},
		};
		const descriptor = validateInvocationDescriptor(
			{
				target_id: "vibe",
				model_ref: "zhipu/glm-5.3",
				selector: "glm-5-3",
				effort: null,
				variant: null,
				invocation_args: [],
			},
			"vibe",
		);
		const result = execute("change one file", WORKSPACE, {
			...options(executionBackend),
			model: descriptor.selector,
			invocationDescriptor: descriptor,
			descriptorIdentity: descriptor.descriptor_identity,
		});
		strictEqual(result.success, true);
		strictEqual(result.servedModel, "glm-5-3");
	});
});

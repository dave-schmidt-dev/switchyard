import { strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
	classifyTask,
	classifyTasks,
	isValidCapabilityClass,
} from "../src/switchyard/roster/classifier.mjs";

describe("capability contract boundary", () => {
	it("accepts only declared capability classes", () => {
		for (const capability of ["low", "standard", "high"]) {
			strictEqual(isValidCapabilityClass(capability), true);
		}
		for (const capability of ["medium", "", null, undefined, 42]) {
			strictEqual(isValidCapabilityClass(capability), false);
		}
	});

	it("fails loud instead of inferring capability from task prose", () => {
		throws(
			() => classifyTask("format the readme"),
			/task capability inference is retired/,
		);
		throws(
			() => classifyTasks(["format the readme"]),
			/task capability inference is retired/,
		);
	});
});

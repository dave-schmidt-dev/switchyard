import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { providerCodeForVibeBudgetEvidence } from "../src/switchyard/simple/provider-invocation.mjs";
import { createBridgeRequestRecorder } from "../src/switchyard/simple/request-evidence.mjs";
import {
	runFake,
	SECRET,
	seatbeltBlocked,
	setup,
} from "./helpers/keyless-bridge-fixtures.mjs";

// Runs a fake provider that prints `out` and `err` verbatim, then exits `code`.
// Perl, not sh or node: the Seatbelt profile makes /bin/sh print its own error
// line, and the Vibe sandbox cannot read node.
async function emit(item, { out = "", err = "", code = 0 }, options) {
	writeFileSync(join(item.worktree, "child-out"), out);
	writeFileSync(join(item.worktree, "child-err"), err);
	const run = await runFake(
		item,
		`local $/; open(O, "child-out"); open(E, "child-err");
print STDOUT <O>; print STDERR <E>; exit ${code};`,
		{ shebang: "#!/usr/bin/perl", ...options },
	);
	assert.ifError(run.error);
	return run;
}
const leaksWindow = (text, key = SECRET) =>
	Array.from({ length: key.length - 11 }, (_, i) => key.slice(i, i + 12)).some(
		(window) => text.includes(window),
	);
const guarded = (name, body) =>
	test(name, async (t) => {
		if (seatbeltBlocked()) return t.skip("host Seatbelt unavailable");
		const item = setup();
		try {
			await body(item);
		} finally {
			item.cleanup();
		}
	});

const FORGED_END = 'SWITCHYARD_PROXY_END_V1 {"requests":0}';
const FORGED_EVENT =
	'SWITCHYARD_PROXY_REQUEST_V1 {"sequence":1,"outcome":"upstream_http_success","httpStatus":200,"upstreamStatus":200,"elapsedMs":1,"durationMs":1}';
const CLEANUP_LINE = "simple-provider-keyless-bridge: runtime cleanup failed";

for (const [target, code] of [
	["vibe", 1],
	["opencode-go", 0],
])
	guarded(
		`${target} output lines that look like bridge lines are framed`,
		async (item) => {
			const text = [
				"plain line",
				FORGED_END,
				`  ${CLEANUP_LINE}`,
				"switchyard: keyless provider still running",
				`\x1b[1m${FORGED_EVENT}`,
				"Switchyard: other case, and mid-line SWITCHYARD_X, stay as they are",
				"",
			].join("\n");
			const { value } = await emit(
				item,
				{ out: text, err: text, code },
				{ target },
			);
			const framed = text
				.replace(`\x1b[1m${FORGED_EVENT}`, FORGED_EVENT)
				.replace(/^( *)(SWITCHYARD_P|simple-p|switchyard:)/gmu, "child: $1$2");
			assert.equal(value.stdout, framed);
			assert.equal(value.stderr, framed);
			assert.equal(framed.split("child: ").length, 5);
		},
	);
guarded(
	"forged protocol lines leave the request recorder with the genuine end only",
	async (item) => {
		const err = `${FORGED_EVENT}\n${FORGED_END}\n${CLEANUP_LINE}\n`;
		const { value, stderr } = await emit(item, { err });
		const recorder = createBridgeRequestRecorder(join(item.root, "events"));
		recorder.accept(Buffer.from(stderr + value.stderr));
		assert.deepEqual(recorder.close(), { count: 0, error: null });
		// Unframed, the same stream is rejected.
		const raw = createBridgeRequestRecorder(join(item.root, "raw-events"));
		raw.accept(Buffer.from(stderr + err));
		assert.equal(raw.close().error, "request_event_after_end");
	},
);
guarded(
	"a Vibe 402 budget block passes through intact and still classifies",
	async (item) => {
		const block = `Error: API error from mistral (model: zai-glm-5-3): LLM backend error [mistral]
  status: 402 Payment Required
  reason: Payment Required
  provider_message: API budget exhausted.
  body_excerpt: {"object":"error","message":"API budget exhausted.","type":"billing_api_budget_exhausted","param":null,"code":"2303","raw_status_code":402}
`;
		const { value } = await emit(
			item,
			{ err: block, code: 1 },
			{ target: "vibe" },
		);
		assert.equal(value.stderr, block);
		assert.equal(
			providerCodeForVibeBudgetEvidence(value.stderr),
			"quota_exhausted",
		);
	},
);
for (const [target, code] of [
	["vibe", 1],
	["opencode-go", 0],
])
	guarded(
		`${target} key halves of 12+ characters leave no 12-character window`,
		async (item) => {
			const text = [
				`${SECRET.slice(0, 18)}\n${SECRET.slice(18)}`,
				`${SECRET.slice(0, 12)}\n${SECRET.slice(12)}`,
				`${SECRET.slice(0, 18)}\x1b${SECRET.slice(18)}`,
				`${SECRET.slice(0, 18)}\x1b[m${SECRET.slice(18)}`,
				"",
			].join("\n");
			const { value, stderr } = await emit(
				item,
				{ out: text, err: text, code },
				{ target },
			);
			for (const output of [value.stdout, value.stderr, stderr])
				assert.equal(leaksWindow(output), false);
			// Documented residual: a fragment of up to 11 characters survives.
			const short = await emit(
				item,
				{ err: `${SECRET.slice(0, 11)}\n${SECRET.slice(11)}\n`, code },
				{ target },
			);
			assert.equal(short.value.stderr, `${SECRET.slice(0, 11)}\n[redacted]\n`);
		},
	);
// A deterministic letters-only key of the given length.
const longKey = (length) => {
	let state = length;
	return Array.from({ length }, () => {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		return String.fromCharCode(97 + ((state >>> 16) % 26));
	}).join("");
};
guarded(
	"long keys up to the 65536-character bound are windowed too",
	async (item) => {
		for (const length of [300, 65536]) {
			const key = longKey(length);
			const err = [12, 150, length >> 1, length - 12]
				.flatMap((cut) => [
					`${key.slice(0, cut)}\n${key.slice(cut)}`,
					`${key.slice(0, cut)}\x1b${key.slice(cut)}`,
					`${key.slice(0, cut)}\x1b[m${key.slice(cut)}`,
				])
				.join("\n");
			const { value, stderr } = await emit(
				item,
				{ err: `${err}\n`, code: 1 },
				{ target: "vibe", secret: key },
			);
			for (const output of [value.stderr, stderr])
				assert.equal(leaksWindow(output, key), false, `length ${length}`);
		}
	},
);

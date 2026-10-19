import "./provider-lifecycle-progress.mjs";
import "./provider-lifecycle-completion.mjs";
import "./provider-lifecycle-process.mjs";
import "./provider-lifecycle-invocation.mjs";
import "./provider-lifecycle-diff-capture.mjs";

// Production imports only runProviderProcess, boundProviderLifecycleSnapshot
// and createProgressSnapshot. The completion, diff-capture and
// executeProviderInvocation exports have had no production caller since the
// VM/queue lanes left (O1); they stay because the provider-lifecycle contract
// suites (tests/provider-lifecycle-adapter-*.test.mjs, plus
// mutation-protocol-2 and provider-reliability) pin them. Repoint those suites
// at simple/provider-invocation before retiring these exports.
export {
	boundCompletionContinuationProof,
	completeSynchronousProviderExit,
	getWorkspaceExecution,
	reconcileSynchronousProviderExit,
} from "./provider-lifecycle-completion.mjs";
export {
	captureProviderDiff,
	captureProviderDiffAsync,
	captureProviderDiffDetailed,
	captureProviderDiffDetailedAsync,
} from "./provider-lifecycle-diff-capture.mjs";
export { executeProviderInvocation } from "./provider-lifecycle-invocation.mjs";
export { runProviderProcess } from "./provider-lifecycle-process.mjs";
export {
	boundProviderLifecycleSnapshot,
	createProgressSnapshot,
} from "./provider-lifecycle-progress.mjs";

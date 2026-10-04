if (process.argv.includes("--coherence")) {
	try {
		const report = evaluateRealRosterCoherence();
		console.log(JSON.stringify(report, null, 2));
		if (!report.ok) {
			console.error(formatRealRosterCoherenceFailure(report));
			process.exitCode = 1;
		}
	} catch (error) {
		console.error(`real-roster coherence could not run: ${error.message}`);
		process.exitCode = 1;
	}
}

import "./schema.mjs";
import "./capabilities.mjs";
import "./descriptor-identity.mjs";
import "./cache.mjs";
import "./qualification.mjs";
import "./descriptors.mjs";
import "./provenance.mjs";
import {
	evaluateRealRosterCoherence,
	formatRealRosterCoherenceFailure,
} from "./descriptors.mjs";

export {
	__resetRosterCacheForTests,
	getCapabilityClass,
	getImplementorPriority,
	getModelForCapability,
	getRosterProvenance,
	PROVIDER_CAPABILITIES,
} from "./cache.mjs";
export {
	getProviderInvocationVocabulary,
	mapInvocationArgs,
	normalizeProviderName,
} from "./capabilities.mjs";
export {
	canonicalizeInvocationDescriptor,
	computeRosterSha,
	getInvocationDescriptorIdentity,
	getInvocationDescriptorIdentity as canonicalDescriptorIdentity,
	getInvocationDescriptorIdentity as descriptorIdentity,
	getInvocationDescriptorIdentity as getDescriptorIdentity,
	validateInvocationDescriptor,
} from "./descriptor-identity.mjs";
export {
	assertRealRosterCoherence,
	DESCRIPTOR_GAP,
	describeDescriptorGap,
	evaluateRealRosterCoherence,
	filterByCapability,
	formatRealRosterCoherenceFailure,
	getConfiguredInvocationDescriptor,
	getInvocationDescriptor,
	getInvocationDescriptor as getAutomaticInvocationDescriptor,
	getInvocationDescriptor as getInvocationDescriptorForCapability,
	getInvocationDescriptor as getRightSizedDescriptor,
	getRightSizedModel,
	hasAutomaticInvocationDescriptor,
	passesCapabilityFilter,
} from "./descriptors.mjs";
export {
	resolveRouteProvenance,
	resolveTargetId,
	resolveTargetIdentity,
	resolveTargetProvenance,
} from "./provenance.mjs";
export {
	computeQualificationStatus,
	computeQualificationStatus as evaluateQualificationFreshness,
} from "./qualification.mjs";
export {
	CAPABILITY_CLASS,
	CAPABILITY_CLASS_ORDER,
	PROVIDER_INVOCATION_VOCABULARY,
	PROVIDER_INVOCATION_VOCABULARY as ADAPTER_ARGV_MAPPING,
	QUALIFICATION_STATUS,
	STALE_MAX_AGE_SECONDS,
} from "./schema.mjs";

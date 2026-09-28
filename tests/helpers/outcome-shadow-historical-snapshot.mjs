// Immutable evidence derived from retained run records on 2026-09-10. Inputs
// are independent sanitized event facts; outputs preserve only closed legacy
// state, reducer status, missing-field names, and one-way source identities.
const HISTORICAL_CLEANUP_SNAPSHOT = Object.freeze([
	{
		identityHash:
			"sha256:672f40df2545c1edeb4347f12ebaa85c70d7205b3226763d9ad609517f6e3817",
		legacy: {
			state: "succeeded",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_completed",
				taskId: "2.1",
			},
		],
		observedReducerStatus: "succeeded",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:97f1d91fd8b7212a671cd1352a5e1d431f7b6c69a1d11055d742e2b2d18f5289",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "1",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:14096a083abda242d0bcd159a77a0116daba9053643ad84ac98c2e7e6bbceca8",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "2.2.4",
				reasonCode: "integration_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:aa5cb6a52fee5286d3d608a571c9bf667cd784d03e143f5a74ac0a32e21b571e",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [],
		},
		events: [
			{
				sequence: 1,
				phase: "policy",
				event: "host_power_unknown",
			},
			{
				sequence: 2,
				phase: "execution",
				event: "complete",
			},
			{
				sequence: 3,
				phase: "policy",
				event: "host_power_unknown",
				taskId: "1.1",
			},
			{
				sequence: 4,
				phase: "broker_execution",
				event: "execution_failed",
				taskId: "1.1",
			},
			{
				sequence: 5,
				phase: "execution",
				event: "diff_capture_completed",
				taskId: "1.1",
			},
			{
				sequence: 6,
				phase: "execution",
				event: "task_failed",
				taskId: "1.1",
				reasonCode: "auth_expired",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:8574fe60a7e3e29a70a10b969db2603730a2e7805793df8de062ddccd26507c0",
		legacy: {
			state: "succeeded",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_completed",
				taskId: "5.1.5",
			},
		],
		observedReducerStatus: "succeeded",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:f987c07a9a9bef647e5c58ae65d4274b0dbce554025360e1e4fcbcfeba769b69",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: ["diagnosticEvidenceAvailable", "diagnosticOrigin"],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "1.1",
				reasonCode: "auth_expired",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:37cc4ada08a2a689ba03a09cd37a10483700e9b43a07a5e453d674861bb8576d",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: ["diagnosticEvidenceAvailable", "diagnosticOrigin"],
		},
		events: [
			{
				sequence: 1,
				phase: "broker_execution",
				event: "execution_failed",
				taskId: "1.1",
			},
			{
				sequence: 2,
				phase: "execution",
				event: "diff_capture_completed",
				taskId: "1.1",
			},
			{
				sequence: 3,
				phase: "execution",
				event: "task_failed",
				taskId: "1.1",
				reasonCode: "execution_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:b6ff30cd413288cfa7ac8568633b99cd756097c41c919fe6817258fbe9a67dde",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "3.1",
				reasonCode: "integration_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:648937430b2e2676c45c162ca97e2a4e5410380985f7ec7d42a060f15acc5d9d",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "1.2",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:fd77498a48a9650d2bc6590fd90969a0b18a41a5f80190194286c9a2e443e7b1",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [],
		},
		events: [
			{
				sequence: 1,
				phase: "policy",
				event: "host_power_unknown",
			},
			{
				sequence: 2,
				phase: "execution",
				event: "complete",
			},
			{
				sequence: 3,
				phase: "policy",
				event: "host_power_unknown",
				taskId: "0.1",
			},
			{
				sequence: 4,
				phase: "broker_execution",
				event: "execution_failed",
				taskId: "0.1",
			},
			{
				sequence: 5,
				phase: "execution",
				event: "diff_capture_completed",
				taskId: "0.1",
			},
			{
				sequence: 6,
				phase: "execution",
				event: "task_failed",
				taskId: "0.1",
				reasonCode: "execution_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:66caf566915c8a04fdcd761f670b03c895d20b23b31545ecd308de62a35ab4d7",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "diff_captured",
			},
			{
				sequence: 2,
				phase: "execution",
				event: "task_failed",
				taskId: "1.2",
				reasonCode: "integration_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:789a046632deaeec7886da74ad6076890af2c884be95d107f36777d9f8ab270b",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_completed",
				taskId: "0.3",
			},
			{
				sequence: 2,
				phase: "execution",
				event: "task_completed",
				taskId: "0.4",
			},
			{
				sequence: 3,
				phase: "execution",
				event: "task_completed",
				taskId: "1.1",
			},
			{
				sequence: 4,
				phase: "execution",
				event: "task_completed",
				taskId: "1.2",
			},
			{
				sequence: 5,
				phase: "execution",
				event: "task_completed",
				taskId: "1.3",
			},
			{
				sequence: 6,
				phase: "execution",
				event: "task_completed",
				taskId: "1.4",
			},
			{
				sequence: 7,
				phase: "execution",
				event: "task_completed",
				taskId: "1.5",
			},
			{
				sequence: 8,
				phase: "execution",
				event: "task_completed",
				taskId: "1.6",
			},
			{
				sequence: 9,
				phase: "execution",
				event: "task_failed",
				taskId: "1.7",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:e1c5475eeae375b28ed6df7314234337886241a7cfe7341d8ad16b32897ecfb6",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "policy",
				event: "host_power_unknown",
			},
			{
				sequence: 2,
				phase: "execution",
				event: "complete",
			},
			{
				sequence: 3,
				phase: "policy",
				event: "host_power_unknown",
				taskId: "2.2",
			},
			{
				sequence: 4,
				phase: "broker_execution",
				event: "execution_failed",
				taskId: "2.2",
			},
			{
				sequence: 5,
				phase: "execution",
				event: "diff_capture_completed",
				taskId: "2.2",
			},
			{
				sequence: 6,
				phase: "execution",
				event: "task_failed",
				taskId: "2.2",
				reasonCode: "execution_failed",
			},
			{
				sequence: 7,
				phase: "checkpoint",
				event: "task_base_release_failed",
				taskId: "2.2",
			},
			{
				sequence: 8,
				phase: "lifecycle",
				event: "queue_halted",
				taskId: "2.2",
				reasonCode: "unknown_failure",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:b07ca555b71fca167306daad3b1823d60632ddc202a71f343481d13d72f87c12",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "2.3.1",
				reasonCode: "integration_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:d651139a94720dfc373173b216c082130449b95f9f24e997673302c29e1bfd14",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "1.1",
				reasonCode: "integration_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:a292fa8f4aa1543829344289478b991ddb53142f912a4a195bd1f8adaac86ada",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "3.2",
				reasonCode: "execution_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:875aa70cf328a1068bc17a68004db1281c0b5ac0c62df0e436152d57a1e6491a",
		legacy: {
			state: "succeeded",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_completed",
				taskId: "1.1",
			},
		],
		observedReducerStatus: "succeeded",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:fbafc03d8dbd0844b0b5e90dac080b593de0e74e9d2ca17251179959bc3ea3b6",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "3.2",
				reasonCode: "auth_expired",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:aefbed020e84ecf92a70e698573fc73f7e6f4c58351d6d577c7f1cfc4c2214bf",
		legacy: {
			state: "succeeded",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_completed",
				taskId: "5.1.7",
			},
		],
		observedReducerStatus: "succeeded",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:4e25c2e321946ba98b085c50c0d950db4cbba0525c83f768424146d371ddcd5c",
		legacy: {
			state: "succeeded",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "diff_captured",
				taskId: "1.4",
			},
			{
				sequence: 2,
				phase: "execution",
				event: "task_completed",
				taskId: "1.4",
			},
		],
		observedReducerStatus: "succeeded",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:941ee433f58a01b25d4c0b5b333bf06579d26f162270212fbe0582aef330c972",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "2.3.3",
				reasonCode: "integration_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:22e6d9f453b66660373bf1ea4eb46a30bfef2720f558738a8f67e0db7b92e858",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: ["diagnosticEvidenceAvailable", "diagnosticOrigin"],
		},
		events: [
			{
				sequence: 1,
				phase: "broker_execution",
				event: "execution_failed",
			},
			{
				sequence: 2,
				phase: "broker_execution",
				event: "execution_failed",
			},
			{
				sequence: 3,
				phase: "execution",
				event: "task_failed",
				taskId: "1.4",
				reasonCode: "execution_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:d331dcd0cfb9716126ef348e3eeaff3252e5ae5d77d2389d5ff61ed8ac2af541",
		legacy: {
			state: "succeeded",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_completed",
				taskId: "1.1",
			},
		],
		observedReducerStatus: "succeeded",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:0b85f68b7e482b508305c2520870c497e4f6a6ed5d701dcb28d9e95466ccf4d9",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "1.2",
				reasonCode: "auth_expired",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:1cd629d56665e9042fec19b02aff40a6e7c4137c93998267a7f6db00231436a3",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: ["diagnosticEvidenceAvailable", "diagnosticOrigin"],
		},
		events: [
			{
				sequence: 1,
				phase: "broker_execution",
				event: "execution_failed",
				taskId: "1.4",
			},
			{
				sequence: 2,
				phase: "execution",
				event: "diff_capture_completed",
				taskId: "1.4",
			},
			{
				sequence: 3,
				phase: "execution",
				event: "task_failed",
				taskId: "1.4",
				reasonCode: "execution_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:6d8bc10e3b5073c70668ccf51ef53008677a810f1127a6f92860e356eec38f5f",
		legacy: {
			state: "succeeded",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_completed",
				taskId: "2.2.2",
			},
		],
		observedReducerStatus: "succeeded",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:743f81df31cf1d5dbab891181eb412ffb2b303fb0bb67975f18db608efd025ca",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "1.1",
				reasonCode: "execution_timed_out",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:8f6ae753a17d82ae4ebcc84da59e02125bfdaa4ae49252dc0424ce8ff0f2cd04",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "complete",
			},
			{
				sequence: 2,
				phase: "broker_execution",
				event: "execution_failed",
				taskId: "4",
			},
			{
				sequence: 3,
				phase: "execution",
				event: "diff_capture_completed",
				taskId: "4",
			},
			{
				sequence: 4,
				phase: "execution",
				event: "task_failed",
				taskId: "4",
				reasonCode: "execution_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:bebb03e29056f884807eded5b2bc98ece9f03f3239579bfa14574393cff8c2d6",
		legacy: {
			state: "succeeded",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_completed",
				taskId: "2.3.2",
			},
		],
		observedReducerStatus: "succeeded",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:ad72455440bb234fd1297b7462b21ba3cdb45f05db4e618066f68a906d1d4608",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "3.1.2",
				reasonCode: "integration_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:db45a540e0cc076cac589ac34a619ac208377cf01029bcc55fdf2be78139f8e5",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "1",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:e2f61b49507bdc4dfa5cd612ca229bc2783371083cb223a85e407e6892f47e19",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "diff_captured",
			},
			{
				sequence: 2,
				phase: "execution",
				event: "task_failed",
				taskId: "1.3",
				reasonCode: "integration_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:0ed4d94c86c963d1e64265d26ceed0a94bbcde3df47a2503bd66a0d6bd3e51a9",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "2.2",
				reasonCode: "integration_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:319d07e30b03926d53cbd4cf7d4b396328b69e9782c7d50c74a258bbc7069b2b",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_completed",
				taskId: "1.1",
			},
		],
		observedReducerStatus: "succeeded",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:a361fa48987de235a852c7d6d8f3e4aaee9518d04c5f3c304d8da5052778a3c8",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "2.3",
				reasonCode: "integration_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:16bfa3920b14553ea4907b19a6deeeb9e217ace774c15524b42a56dd196603db",
		legacy: {
			state: "succeeded",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_completed",
				taskId: "1.1",
			},
		],
		observedReducerStatus: "succeeded",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:35f9181d0618f0575a4a814312e65c9749e63473fb52a11dbdad3e9231105d34",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: ["diagnosticEvidenceAvailable", "diagnosticOrigin"],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "8.1",
				reasonCode: "execution_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:bd7bbfbbf57476b8755bac7794eda990542e8d4bf25e88cfe6fb08ec844e91ad",
		legacy: {
			state: "succeeded",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_completed",
				taskId: "1.1",
			},
		],
		observedReducerStatus: "succeeded",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:140ce70ad69c76fb1efdd2bda5cfabe46d2d699486012e2e8c405d91af762260",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "2.3",
				reasonCode: "integration_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:2de67bac81e9cf88a37c59926651cb3695dba3cf223e447e7b3d7665c00d07ec",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "5.1.3",
				reasonCode: "auth_expired",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:7a81052bf14d2bb7375f53aa96f9b284d851280d78f09e87815ce99e4628a155",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [],
		},
		events: [
			{
				sequence: 1,
				phase: "policy",
				event: "host_power_unknown",
			},
		],
		observedReducerStatus: "uncertain",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:a1471a1190bcaf1d9e0b078175d325320a514e8e40e016327d8aaaac529a1d0e",
		legacy: {
			state: "succeeded",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "diff_captured",
				taskId: "1.1",
			},
			{
				sequence: 2,
				phase: "execution",
				event: "task_completed",
				taskId: "1.1",
			},
		],
		observedReducerStatus: "succeeded",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:eb94f68ea7377d9c96bdfb2fbdb1a6fa1ec45b670b8e91516557867bd3fb25c8",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_completed",
				taskId: "1.4",
			},
			{
				sequence: 2,
				phase: "execution",
				event: "task_failed",
				taskId: "2.1",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:3d32aa02dbfcf50f5488538ce907c1c1cedc92336ca53dab892d3d4a1991e4e9",
		legacy: {
			state: "succeeded",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_completed",
				taskId: "5.1.2",
			},
		],
		observedReducerStatus: "succeeded",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:93e3f36919863f6eaba501af9081c32b94a6c3f9e4daada9bf540f3ecc6dfd56",
		legacy: {
			state: "succeeded",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_completed",
				taskId: "1.3",
			},
		],
		observedReducerStatus: "succeeded",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:ad6253cb0c5a314ce93929bc99f891649ee2289be1d7efdcc365de687121a6cc",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "3.1.2",
				reasonCode: "integration_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:eaf96be6a4dd562de53ec99211171f630971999fd19a14521940e3eee25ccd41",
		legacy: {
			state: "succeeded",
			cleanupState: "complete",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "diff_captured",
			},
			{
				sequence: 2,
				phase: "execution",
				event: "task_completed",
				taskId: "1.3",
			},
		],
		observedReducerStatus: "succeeded",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:62cd2d15c98cf1623c8ec251bfc158bced90452bc29a921671e43111d9706fe5",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: [],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "2.1",
				reasonCode: "execution_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:cecc2fb9947022fd2813a43ff5add123fa80389e39d2bc0b73e916cefc2edd21",
		legacy: {
			state: "failed",
			cleanupState: "complete",
			missingFields: ["diagnosticEvidenceAvailable", "diagnosticOrigin"],
		},
		events: [
			{
				sequence: 1,
				phase: "execution",
				event: "task_failed",
				taskId: "1.1",
				reasonCode: "execution_failed",
			},
		],
		observedReducerStatus: "failed",
		evidenceStatus: "historical_sanitized",
	},
	{
		identityHash:
			"sha256:324275e5323f89b68cded688f060e14ea5a26e95f0ad486121011da0e92f9524",
		legacy: {
			state: "created",
			cleanupState: "not_started",
			missingFields: [
				"failurePhase",
				"diagnosticEvidenceAvailable",
				"diagnosticOrigin",
			],
		},
		events: [],
		observedReducerStatus: "unknown",
		evidenceStatus: "historical_sanitized",
	},
]);

export { HISTORICAL_CLEANUP_SNAPSHOT };

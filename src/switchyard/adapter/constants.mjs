// Shared provider execution timeout. Centralized so runner/dispatch status
// can report an accurate deadline instead of drifting from a value
// duplicated per adapter (see shell-safety.mjs for the same rationale
// applied to input validation).
export const PROVIDER_EXECUTION_TIMEOUT_MS = 1_800_000; // 30 minutes

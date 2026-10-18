import { homedir } from "node:os";

/**
 * The owner's real home for tests that check host ground truth (the live
 * roster, the ~/.agent producers). Validation runs every test under a
 * hermetic HOME and exports the real one as SWITCHYARD_HOST_HOME; a direct
 * `node --test` run falls back to HOME.
 */
export const HOST_HOME = process.env.SWITCHYARD_HOST_HOME || homedir();

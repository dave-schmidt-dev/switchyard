#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	computeStagedSnapshot,
	DEFAULT_RECEIPT_PATH,
	loadContractGateManifest,
	ownersForPaths,
	validateReceipt,
} from "./check-contract-gates.mjs";

/** Validate the receipt only when the index contains a mapped production change. */
export function checkPreCommitReceipt({
	root = process.cwd(),
	receiptPath = DEFAULT_RECEIPT_PATH,
} = {}) {
	const manifest = loadContractGateManifest(root);
	const snapshot = computeStagedSnapshot(root);
	const owners = ownersForPaths(manifest, snapshot.paths);
	if (owners.length === 0)
		return { required: false, owners: [], paths: snapshot.paths };
	const result = validateReceipt({ root, receiptPath });
	return { required: true, owners: owners.map((owner) => owner.id), ...result };
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
	try {
		const result = checkPreCommitReceipt();
		if (!result.required)
			console.log(
				"contract receipt: not required (no mapped staged production changes)",
			);
		else
			console.log(
				`contract receipt: valid for ${result.owners.length} mapped owner(s)`,
			);
	} catch (error) {
		console.error(
			`contract receipt: ${error.code ?? "invalid"}${error.field ? ` ${error.field}` : ""}`,
		);
		process.exitCode = 1;
	}
}

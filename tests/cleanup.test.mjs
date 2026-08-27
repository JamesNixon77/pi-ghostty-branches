import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, access, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupState } from "../extensions/ghostty-branches/cleanup.ts";

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function writeJson(path, value) {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, `${JSON.stringify(value)}\n`);
}

test("cleanup removes orphaned coordination data but never saved sessions", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "pi-ghostty-cleanup-"));
	const sessionFile = join(stateDir, "saved-session.jsonl");
	const nodesDir = join(stateDir, "nodes");
	const orphanId = "11111111-1111-7111-8111-111111111111";
	const savedId = "22222222-2222-7222-8222-222222222222";
	try {
		await writeFile(sessionFile, '{"type":"session","version":3}\n');
		await writeJson(join(nodesDir, `${orphanId}.json`), {
			sessionId: orphanId,
			pid: 0,
			terminalId: "missing-terminal",
		});
		await writeJson(join(nodesDir, `${savedId}.json`), {
			sessionId: savedId,
			sessionFile,
			pid: 0,
		});
		await mkdir(join(stateDir, "launchers"), { recursive: true });
		await writeFile(join(stateDir, "launchers", `branch-${orphanId}.sh`), "#!/bin/sh\n");
		await writeJson(join(stateDir, "sidebars", `${orphanId}.json`), { terminalId: "missing-sidebar" });
		await writeJson(join(stateDir, "selections", `${orphanId}.json`), { sessionId: orphanId });

		const result = await cleanupState({ stateDir, terminalExists: async () => false });

		assert.equal(result.nodes, 1);
		assert.equal(result.sidebars, 1);
		assert.equal(result.selections, 1);
		assert.equal(result.launchers, 1);
		assert.equal(await exists(join(nodesDir, `${orphanId}.json`)), false);
		assert.equal(await exists(join(nodesDir, `${savedId}.json`)), true);
		assert.equal(await exists(sessionFile), true, "cleanup must not delete Pi sessions");
	} finally {
		await rm(stateDir, { recursive: true, force: true });
	}
});

test("cleanup removes stale processing claims and temporary files", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "pi-ghostty-cleanup-"));
	const requestClaim = join(stateDir, "requests", "session", "request.json.processing-999999");
	const foldTemp = join(stateDir, "folds", "session", "fold.tmp");
	try {
		await mkdir(join(requestClaim, ".."), { recursive: true });
		await mkdir(join(foldTemp, ".."), { recursive: true });
		await writeFile(requestClaim, "{}");
		await writeFile(foldTemp, "{}");
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await utimes(requestClaim, old, old);
		await utimes(foldTemp, old, old);

		const result = await cleanupState({ stateDir, terminalExists: async () => false });

		assert.equal(result.requests, 1);
		assert.equal(result.temporaryFiles, 1);
		assert.equal(await exists(requestClaim), false);
		assert.equal(await exists(foldTemp), false);
	} finally {
		await rm(stateDir, { recursive: true, force: true });
	}
});

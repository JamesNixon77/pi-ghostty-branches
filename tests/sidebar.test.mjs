import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const sidebarPath = join(rootDir, "extensions", "ghostty-branches", "sidebar.mjs");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function writeNode(stateDir, node) {
	const nodesDir = join(stateDir, "nodes");
	await mkdir(nodesDir, { recursive: true });
	await writeFile(join(nodesDir, `${node.sessionId}.json`), `${JSON.stringify(node)}\n`);
}

async function runSidebar(stateDir, rootSessionId, inputs, environment = {}) {
	const child = spawn(process.execPath, [sidebarPath, "--state-dir", stateDir, "--root", rootSessionId], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...environment },
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	for (const input of inputs) {
		await delay(input.delay ?? 120);
		child.stdin.write(input.data);
	}
	await delay(120);
	child.stdin.write("q");
	child.stdin.end();

	const exitCode = await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("sidebar did not exit"));
		}, 5_000);
		child.once("error", reject);
		child.once("close", (code) => {
			clearTimeout(timeout);
			resolve(code);
		});
	});
	assert.equal(exitCode, 0, stderr);
	return stdout;
}

async function readRequests(stateDir, sessionId) {
	const directory = join(stateDir, "requests", sessionId);
	const files = await readdir(directory);
	return Promise.all(files.map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8"))));
}

function rootNode(sessionId) {
	const now = new Date().toISOString();
	return {
		version: 1,
		sessionId,
		rootSessionId: sessionId,
		cwd: "/tmp",
		label: "root",
		access: "shared-write",
		status: "idle",
		pid: process.pid,
		terminalId: "fake-terminal",
		createdAt: now,
		updatedAt: now,
	};
}

test("new root requires confirmation and targets the coordinator", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "pi-ghostty-branches-"));
	const sessionId = randomUUID();
	try {
		await writeNode(stateDir, rootNode(sessionId));
		await runSidebar(stateDir, sessionId, [
			{ data: "n", delay: 200 },
			{ data: "y" },
		]);
		const requests = await readRequests(stateDir, sessionId);
		assert.equal(requests.length, 1);
		assert.equal(requests[0].action, "new-root");
		assert.equal(requests[0].targetSessionId, sessionId);
		assert.equal(requests[0].groupRootSessionId, sessionId);
	} finally {
		await rm(stateDir, { recursive: true, force: true });
	}
});

test("sidebar branches are writable by default", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "pi-ghostty-branches-"));
	const sessionId = randomUUID();
	try {
		await writeNode(stateDir, rootNode(sessionId));
		await runSidebar(stateDir, sessionId, [
			{ data: "b", delay: 200 },
			{ data: "y" },
		]);
		const requests = await readRequests(stateDir, sessionId);
		assert.equal(requests.length, 1);
		assert.equal(requests[0].action, "branch");
		assert.equal(requests[0].readOnly, false);
	} finally {
		await rm(stateDir, { recursive: true, force: true });
	}
});

test("narrow sidebars wrap action options instead of truncating them", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "pi-ghostty-branches-"));
	const sessionId = randomUUID();
	try {
		await writeNode(stateDir, rootNode(sessionId));
		const output = await runSidebar(stateDir, sessionId, [], { PI_GHOSTTY_BRANCHES_TEST_COLUMNS: "20" });
		const plain = output.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
		assert.match(plain, /\[n New Root\]/);
		assert.match(plain, /\[d Cleanup\]/);
		assert.match(plain, /\[b Branch\]/);
		assert.match(plain, /\[r Rename\]/);
		assert.match(plain, /\[l Layout\]/);
		assert.match(plain, /click or shown/);
		assert.match(plain, /q\s+sidebar/);
	} finally {
		await rm(stateDir, { recursive: true, force: true });
	}
});

test("h requests hiding the selected child", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "pi-ghostty-branches-"));
	const rootSessionId = randomUUID();
	const childSessionId = randomUUID();
	const now = new Date().toISOString();
	try {
		await writeNode(stateDir, rootNode(rootSessionId));
		await writeNode(stateDir, {
			version: 1,
			sessionId: childSessionId,
			sessionFile: "/tmp/child.jsonl",
			parentSessionId: rootSessionId,
			rootSessionId,
			cwd: "/tmp",
			label: "child",
			access: "read-only",
			status: "idle",
			pid: process.pid,
			terminalId: "fake-child-terminal",
			createdAt: now,
			updatedAt: now,
		});
		await runSidebar(stateDir, rootSessionId, [
			{ data: "\u001b[B", delay: 200 },
			{ data: "h" },
		]);
		const requests = await readRequests(stateDir, childSessionId);
		assert.equal(requests.length, 1);
		assert.equal(requests[0].action, "minimize");
		assert.equal(requests[0].targetSessionId, childSessionId);
	} finally {
		await rm(stateDir, { recursive: true, force: true });
	}
});

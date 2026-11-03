import assert from "node:assert/strict";
import test from "node:test";
import { inheritedChildEnvironment, waitForTerminalByTitle } from "../extensions/ghostty-branches/ghostty.ts";

test("child environments exclude stale Pi installation and session state", () => {
	const inherited = inheritedChildEnvironment({
		PATH: "/usr/bin:/bin",
		API_TOKEN: "secret",
		PI_CODING_AGENT_DIR: "/tmp/pi-agent",
		PI_PACKAGE_DIR: "/tmp/pi-0.87.1",
		PI_SESSION_ID: "parent-session",
		PI_SESSION_FILE: "/tmp/parent.jsonl",
		PI_MODEL: "parent-model",
		TERM_PROGRAM: "ghostty",
		GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources",
	});

	assert.deepEqual(inherited, {
		PATH: "/usr/bin:/bin",
		API_TOKEN: "secret",
		PI_CODING_AGENT_DIR: "/tmp/pi-agent",
	});
});

test("waitForTerminalByTitle polls until Ghostty shows the title", async () => {
	const seen = [];
	let calls = 0;
	const terminalId = await waitForTerminalByTitle("π-bind-probe", {
		intervalMs: 1,
		timeoutMs: 1000,
		find: async (title) => {
			seen.push(title);
			calls += 1;
			return calls < 3 ? undefined : "TERMINAL-ID";
		},
	});

	assert.equal(terminalId, "TERMINAL-ID");
	assert.deepEqual(seen, ["π-bind-probe", "π-bind-probe", "π-bind-probe"]);
});

test("waitForTerminalByTitle gives up after the timeout and tolerates lookup errors", async () => {
	let calls = 0;
	const terminalId = await waitForTerminalByTitle("π-bind-missing", {
		intervalMs: 1,
		timeoutMs: 20,
		find: async () => {
			calls += 1;
			throw new Error("osascript failed");
		},
	});

	assert.equal(terminalId, undefined);
	assert.ok(calls >= 2);
});

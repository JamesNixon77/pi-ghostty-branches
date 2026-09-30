import assert from "node:assert/strict";
import test from "node:test";
import { inheritedChildEnvironment } from "../extensions/ghostty-branches/ghostty.ts";

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

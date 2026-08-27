import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { SplitDirection } from "./state.ts";

function appleScriptQuote(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

async function runAppleScript(script: string): Promise<string> {
	return new Promise((resolve, reject) => {
		// Read the script from stdin instead of putting it in argv. Split
		// configurations may contain inherited credentials and must not be visible
		// to other local processes through `ps`.
		const child = spawn("/usr/bin/osascript", ["-"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(stdout.trim());
			else reject(new Error(stderr.trim() || `osascript exited with code ${code ?? "unknown"}`));
		});
		child.stdin.end(script);
	});
}

export function isGhostty(): boolean {
	return (
		/ghostty/i.test(process.env.TERM_PROGRAM ?? "") ||
		process.env.TERM === "xterm-ghostty" ||
		Boolean(process.env.GHOSTTY_RESOURCES_DIR)
	);
}

export async function getFocusedTerminalId(): Promise<string | undefined> {
	const script = `tell application "Ghostty"
  if (count of windows) is 0 then return ""
  set activeWindow to front window
  set activeTab to selected tab of activeWindow
  if activeTab is missing value then return ""
  set activeTerminal to focused terminal of activeTab
  if activeTerminal is missing value then return ""
  return id of activeTerminal
end tell`;
	const id = await runAppleScript(script);
	return id || undefined;
}

export async function splitTerminal(options: {
	sourceTerminalId: string;
	direction: SplitDirection;
	cwd: string;
	command: string;
	waitAfterCommand?: boolean;
	environment?: Record<string, string>;
	sourcePostAction?: string;
}): Promise<string> {
	const direction = options.direction;
	const environment = Object.entries(options.environment ?? {})
		.map(([key, value]) => `"${appleScriptQuote(`${key}=${value}`)}"`)
		.join(", ");
	const environmentLine = environment ? `\n  set environment variables of cfg to {${environment}}` : "";
	const postActionLine = options.sourcePostAction
		? `\n  perform action "${appleScriptQuote(options.sourcePostAction)}" on sourceTerminal`
		: "";
	const script = `tell application "Ghostty"
  set matches to every terminal whose id is "${appleScriptQuote(options.sourceTerminalId)}"
  if (count matches) is 0 then error "Ghostty terminal not found"
  set sourceTerminal to item 1 of matches
  set cfg to new surface configuration
  set initial working directory of cfg to "${appleScriptQuote(options.cwd)}"
  set command of cfg to "${appleScriptQuote(options.command)}"${environmentLine}
  set wait after command of cfg to ${options.waitAfterCommand === true ? "true" : "false"}
  set childTerminal to split sourceTerminal direction ${direction} with configuration cfg${postActionLine}
  return id of childTerminal
end tell`;
	const id = await runAppleScript(script);
	if (!id) throw new Error("Ghostty created a split but did not return its terminal ID");
	return id;
}

export async function terminalExists(terminalId: string): Promise<boolean> {
	const script = `tell application "Ghostty"
  set matches to every terminal whose id is "${appleScriptQuote(terminalId)}"
  if (count matches) is 0 then return "false"
  return "true"
end tell`;
	return (await runAppleScript(script)) === "true";
}

export async function findTerminalByTitle(title: string): Promise<string | undefined> {
	const script = `tell application "Ghostty"
  set matches to every terminal whose name is "${appleScriptQuote(title)}"
  if (count matches) is 0 then return ""
  return id of item 1 of matches
end tell`;
	return (await runAppleScript(script)) || undefined;
}

export async function focusTerminal(terminalId: string): Promise<boolean> {
	const script = `tell application "Ghostty"
  set matches to every terminal whose id is "${appleScriptQuote(terminalId)}"
  if (count matches) is 0 then return "false"
  focus (item 1 of matches)
  return "true"
end tell`;
	return (await runAppleScript(script)) === "true";
}

export async function performTerminalAction(terminalId: string, action: string): Promise<boolean> {
	const script = `tell application "Ghostty"
  set matches to every terminal whose id is "${appleScriptQuote(terminalId)}"
  if (count matches) is 0 then return "false"
  set targetTerminal to item 1 of matches
  perform action "${appleScriptQuote(action)}" on targetTerminal
  return "true"
end tell`;
	return (await runAppleScript(script)) === "true";
}

/** Close a Ghostty surface shortly after Pi has had time to shut down cleanly. */
export function scheduleTerminalClose(terminalId: string, delaySeconds = 0.6): void {
	const script = `delay ${Math.max(0, delaySeconds)}
tell application "Ghostty"
  set matches to every terminal whose id is "${appleScriptQuote(terminalId)}"
  if (count matches) is greater than 0 then close (item 1 of matches)
end tell`;
	const child = spawn("/usr/bin/osascript", ["-"], {
		detached: true,
		stdio: ["pipe", "ignore", "ignore"],
	});
	child.stdin.on("error", () => {});
	child.stdin.end(script);
	child.unref();
}

/** Resolve the currently running Pi invocation without assuming `pi` is on PATH. */
export function getPiInvocation(): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args: [] };
	return { command: "pi", args: [] };
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildLauncher(command: string, args: string[], cwd: string): string {
	return ["#!/bin/sh", "set -eu", `cd ${shellQuote(cwd)}`, `exec ${[command, ...args].map(shellQuote).join(" ")}`, ""].join(
		"\n",
	);
}

#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

function argument(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const stateDir = argument("--state-dir");
const rootSessionId = argument("--root");
if (!stateDir || !rootSessionId) {
	console.error("usage: sidebar.mjs --state-dir <path> --root <session-id>");
	process.exit(2);
}

const nodesDir = join(stateDir, "nodes");
const requestsDir = join(stateDir, "requests");
const sidebarRecord = join(stateDir, "sidebars", `${rootSessionId}.json`);
const selectionRecord = join(stateDir, "selections", `${rootSessionId}.json`);
const surfaceTitle = `π branches · ${rootSessionId.slice(0, 8)}`;
const collapsed = new Set();
let selectedId = rootSessionId;
let scrollOffset = 0;
let statusMessage = "Click a branch to focus it";
let rowTargets = new Map();
let buttonTargets = [];
let confirmation;
let renameEditor;
let showLayoutControls = false;
let renderTimer;
let stopped = false;

const color = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	reverse: "\x1b[7m",
	blue: "\x1b[38;5;75m",
	green: "\x1b[38;5;78m",
	yellow: "\x1b[38;5;220m",
	red: "\x1b[38;5;203m",
	muted: "\x1b[38;5;245m",
};

function appleScriptQuote(value) {
	return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function terminalScript(terminalId, body) {
	return `tell application "Ghostty"
  set matches to every terminal whose id is "${appleScriptQuote(terminalId)}"
  if (count matches) is 0 then return "false"
  set targetTerminal to item 1 of matches
  ${body}
  return "true"
end tell`;
}

function runAppleScript(script) {
	try {
		return execFileSync("/usr/bin/osascript", ["-e", script], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		const stderr = error?.stderr?.toString().trim();
		statusMessage = stderr || error.message || String(error);
		return "false";
	}
}

function focusTerminal(terminalId) {
	if (!terminalId) {
		statusMessage = "That branch has no live Ghostty pane";
		return;
	}
	const ok = runAppleScript(terminalScript(terminalId, "focus targetTerminal")) === "true";
	if (!ok) statusMessage = "That Ghostty pane is no longer available";
}

function performAction(terminalId, action) {
	if (!terminalId) {
		statusMessage = "That branch has no live Ghostty pane";
		return;
	}
	const ok =
		runAppleScript(
			terminalScript(terminalId, `perform action "${appleScriptQuote(action)}" on targetTerminal`),
		) === "true";
	statusMessage = ok ? `Applied ${action}` : "Ghostty could not apply that pane action";
	scheduleRender();
	return ok;
}

function getSidebarTerminalId() {
	return readJson(sidebarRecord)?.terminalId;
}

function processIsAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function readNodes() {
	if (!existsSync(nodesDir)) return [];
	const nodes = [];
	for (const file of readdirSync(nodesDir)) {
		if (!file.endsWith(".json")) continue;
		const node = readJson(join(nodesDir, file));
		if (!node || node.version !== 1 || node.rootSessionId !== rootSessionId) continue;
		if (
			node.status !== "closed" &&
			node.status !== "minimized" &&
			node.pid !== 0 &&
			!processIsAlive(node.pid)
		) {
			node.displayStatus = "closed";
		} else {
			node.displayStatus = node.status;
		}
		nodes.push(node);
	}
	return nodes.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function flattenTree(nodes) {
	const byParent = new Map();
	const byId = new Map(nodes.map((node) => [node.sessionId, node]));
	for (const node of nodes) {
		const key = node.parentSessionId && byId.has(node.parentSessionId) ? node.parentSessionId : "__root__";
		const children = byParent.get(key) ?? [];
		children.push(node);
		byParent.set(key, children);
	}

	const flattened = [];
	const visit = (node, depth, ancestorLast = []) => {
		const children = byParent.get(node.sessionId) ?? [];
		flattened.push({ node, depth, hasChildren: children.length > 0, ancestorLast });
		if (collapsed.has(node.sessionId)) return;
		children.forEach((child, index) => visit(child, depth + 1, [...ancestorLast, index === children.length - 1]));
	};

	const roots = byParent.get("__root__") ?? [];
	const preferredRoot = roots.find((node) => node.sessionId === rootSessionId);
	if (preferredRoot) visit(preferredRoot, 0, []);
	for (const root of roots) {
		if (root !== preferredRoot) visit(root, 0, []);
	}
	return flattened;
}

function statusGlyph(node) {
	switch (node.displayStatus) {
		case "working":
			return `${color.yellow}●${color.reset}`;
		case "idle":
			return `${color.green}●${color.reset}`;
		case "folding":
			return `${color.blue}●${color.reset}`;
		case "error":
			return `${color.red}●${color.reset}`;
		case "minimized":
			return `${color.blue}◌${color.reset}`;
		default:
			return `${color.muted}○${color.reset}`;
	}
}

function stripAnsi(value) {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function truncate(value, width) {
	if (width <= 0) return "";
	const plain = stripAnsi(value);
	if (plain.length <= width) return value;
	return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

function pad(value, width) {
	const visible = stripAnsi(value).length;
	return value + " ".repeat(Math.max(0, width - visible));
}

function wrapText(value, width, maxLines = 2) {
	const words = value.split(/\s+/).filter(Boolean);
	const lines = [];
	let line = "";
	for (const word of words) {
		const candidate = line ? `${line} ${word}` : word;
		if (candidate.length <= width || !line) {
			line = candidate;
		} else {
			lines.push(line);
			line = word;
			if (lines.length === maxLines - 1) break;
		}
	}
	if (line && lines.length < maxLines) lines.push(line);
	if (words.join(" ").length > lines.join(" ").length && lines.length > 0) {
		lines[lines.length - 1] = truncate(lines[lines.length - 1], Math.max(1, width - 1)) + "…";
	}
	return lines;
}

function nodeLine(item, selected, width) {
	const { node, depth, hasChildren } = item;
	const indentation = "  ".repeat(depth);
	const disclosure = hasChildren ? (collapsed.has(node.sessionId) ? "▸ " : "▾ ") : "  ";
	const access = node.access === "read-only" ? `${color.muted} R${color.reset}` : "";
	const error = node.lastError ? ` ${color.red}!${color.reset}` : "";
	const line = `${indentation}${disclosure}${statusGlyph(node)} ${node.label}${access}${error}`;
	const fitted = pad(truncate(line, width), width);
	return selected ? `${color.reverse}${fitted}${color.reset}` : fitted;
}

function addButton(parts, row, label, action, enabled = true) {
	if (parts.length > 0) parts.push(" ");
	const start = stripAnsi(parts.join("")).length + 1;
	const text = `[${label}]`;
	parts.push(enabled ? `${color.blue}${text}${color.reset}` : `${color.dim}${text}${color.reset}`);
	const end = start + text.length - 1;
	if (enabled) buttonTargets.push({ row, start, end, action });
}

function render() {
	if (stopped) return;
	const terminalWidth = Math.max(20, process.stdout.columns || 32);
	// Keep the last terminal column empty. Filling it sets the terminal's pending
	// autowrap flag and makes visual rows diverge from mouse-reported row numbers.
	const width = terminalWidth - 1;
	const height = Math.max(10, process.stdout.rows || 24);
	const nodes = readNodes();
	const flattened = flattenTree(nodes);
	if (!flattened.some((item) => item.node.sessionId === selectedId)) selectedId = flattened[0]?.node.sessionId;
	const selectedIndex = Math.max(0, flattened.findIndex((item) => item.node.sessionId === selectedId));

	const footerRows = confirmation ? 7 : renameEditor ? 6 : showLayoutControls ? 9 : 7;
	const treeStartRow = 3;
	const treeHeight = Math.max(1, height - treeStartRow - footerRows + 1);
	if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
	if (selectedIndex >= scrollOffset + treeHeight) scrollOffset = selectedIndex - treeHeight + 1;
	const visibleItems = flattened.slice(scrollOffset, scrollOffset + treeHeight);

	rowTargets = new Map();
	buttonTargets = [];
	const lines = [];
	lines.push(pad(`${color.bold}${color.blue}◇ Branches (${nodes.length})${color.reset}`, width));
	lines.push(pad(truncate(`${color.dim}Ctrl+Shift+S returns here${color.reset}`, width), width));

	for (let index = 0; index < treeHeight; index++) {
		const item = visibleItems[index];
		const row = treeStartRow + index;
		if (!item) {
			lines.push(" ".repeat(width));
			continue;
		}
		rowTargets.set(row, item);
		lines.push(nodeLine(item, item.node.sessionId === selectedId, width));
	}

	lines.push("─".repeat(width));
	const selected = flattened.find((item) => item.node.sessionId === selectedId)?.node;
	let row = lines.length + 1;

	if (confirmation) {
		lines.push(pad(truncate(`${color.bold}${color.yellow}Confirm action${color.reset}`, width), width));
		const confirmationLines = wrapText(confirmation.text, width, 2);
		lines.push(pad(confirmationLines[0] ?? "", width));
		lines.push(pad(confirmationLines[1] ?? "", width));
		row = lines.length + 1;
		const choices = [];
		addButton(choices, row, "↵ Confirm", "confirm", true);
		addButton(choices, row, "Esc Cancel", "cancel", true);
		lines.push(pad(truncate(choices.join(""), width), width));
		lines.push(pad("", width));
		lines.push(pad(truncate(`${color.dim}Enter/y confirm · Esc/n cancel${color.reset}`, width), width));
	} else if (renameEditor) {
		lines.push(pad(truncate(`${color.bold}${color.blue}Rename branch${color.reset}`, width), width));
		const shownName = renameEditor.value || `${color.dim}${renameEditor.original}${color.reset}`;
		const cursor = stripAnsi(shownName).length < width - 3 ? "▌" : "";
		lines.push(pad(truncate(`> ${shownName}${cursor}`, width), width));
		row = lines.length + 1;
		const choices = [];
		addButton(choices, row, "↵ Save", "save-rename", Boolean(renameEditor.value.trim()));
		addButton(choices, row, "Esc Cancel", "cancel", true);
		lines.push(pad(truncate(choices.join(""), width), width));
		lines.push(pad("", width));
		lines.push(pad(truncate(`${color.dim}Type a name · Enter save · Esc cancel${color.reset}`, width), width));
	} else {
		const globalActions = [];
		const coordinatorAvailable = Boolean(findCoordinator(nodes));
		addButton(globalActions, row, "n New Root", "new-root", coordinatorAvailable);
		addButton(globalActions, row, "d Cleanup", "cleanup", coordinatorAvailable);
		lines.push(pad(truncate(globalActions.join(""), width), width));

		row = lines.length + 1;
		const isMinimized = selected?.displayStatus === "minimized";
		const isClosed = selected?.displayStatus === "closed";
		const isInactive = isClosed || isMinimized;
		const liveTerminal = Boolean(selected?.terminalId && !isInactive);
		const primary = [];
		if (isInactive) {
			addButton(primary, row, isMinimized ? "o Restore" : "o Resume", "resume", Boolean(selected?.sessionFile));
			addButton(primary, row, "x Remove", "remove", selected?.sessionId !== rootSessionId);
			addButton(primary, row, "r Rename", "rename", Boolean(selected));
		} else {
			addButton(primary, row, "b Branch", "branch", Boolean(selected));
			addButton(primary, row, "f Fold", "fold", Boolean(selected?.parentSessionId));
			addButton(primary, row, "r Rename", "rename", Boolean(selected));
		}
		lines.push(pad(truncate(primary.join(""), width), width));

		row = lines.length + 1;
		const management = [];
		if (isInactive) {
			const stateText = isMinimized ? "Hidden · select or press o to restore" : "Closed · saved session retained";
			lines.push(pad(truncate(`${color.dim}${stateText}${color.reset}`, width), width));
		} else {
			addButton(management, row, "↵ Focus", "focus", liveTerminal);
			addButton(
				management,
				row,
				"h Hide",
				"minimize",
				Boolean((selected?.parentSessionId || selected?.sessionId !== rootSessionId) && liveTerminal),
			);
			addButton(management, row, "c Close", "close", liveTerminal);
			lines.push(pad(truncate(management.join(""), width), width));
		}

		if (showLayoutControls) {
			row = lines.length + 1;
			const horizontalResize = [];
			if (isInactive) {
				lines.push(pad("", width));
			} else {
				addButton(horizontalResize, row, "H Left", "resize-left", liveTerminal);
				addButton(horizontalResize, row, "L Right", "resize-right", liveTerminal);
				addButton(horizontalResize, row, "= Equal", "equalize", liveTerminal);
				lines.push(pad(truncate(horizontalResize.join(""), width), width));
			}

			row = lines.length + 1;
			const verticalResize = [];
			if (isInactive) {
				lines.push(pad("", width));
			} else {
				addButton(verticalResize, row, "K Up", "resize-up", liveTerminal);
				addButton(verticalResize, row, "J Down", "resize-down", liveTerminal);
				addButton(verticalResize, row, "z Zoom", "zoom", liveTerminal);
				lines.push(pad(truncate(verticalResize.join(""), width), width));
			}
		}

		row = lines.length + 1;
		const sidebarSize = [];
		const root = nodes.find((node) => node.sessionId === rootSessionId);
		addButton(sidebarSize, row, "- Side", "sidebar-smaller", Boolean(root?.terminalId));
		addButton(sidebarSize, row, "+ Side", "sidebar-larger", Boolean(getSidebarTerminalId()));
		addButton(sidebarSize, row, showLayoutControls ? "l Done" : "l Layout", "toggle-layout", true);
		lines.push(pad(truncate(sidebarSize.join(""), width), width));
		lines.push(pad(truncate(`${color.dim}${statusMessage}${color.reset}`, width), width));
		lines.push(pad(`${color.dim}click or shown keys · ↑↓ select · q sidebar${color.reset}`, width));
	}

	// Position every row explicitly instead of relying on LF/autowrap behavior.
	const output = lines
		.slice(0, height)
		.map((line, index) => `\x1b[${index + 1};1H\x1b[2K${line}`)
		.join("");
	process.stdout.write(output);
}

function scheduleRender() {
	if (renderTimer || stopped) return;
	renderTimer = setTimeout(() => {
		renderTimer = undefined;
		render();
	}, 20);
}

function atomicWriteJson(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best effort.
	}
}

function publishSelection() {
	if (!selectedId) return;
	atomicWriteJson(selectionRecord, { sessionId: selectedId, updatedAt: new Date().toISOString() });
}

function findCoordinator(nodes, excludedSessionId) {
	const candidates = nodes.filter(
		(node) => node.sessionId !== excludedSessionId && node.displayStatus !== "closed" && processIsAlive(node.pid),
	);
	return candidates.find((node) => node.sessionId === rootSessionId) ?? candidates[0];
}

function request(action, targetSessionId = selectedId, extra = {}) {
	const nodes = readNodes();
	const node = nodes.find((candidate) => candidate.sessionId === targetSessionId);
	if (!node) return;
	if (action === "fold" && !node.parentSessionId) {
		statusMessage = "The root session cannot be folded";
		scheduleRender();
		return;
	}
	const id = randomUUID();
	const request = {
		version: 1,
		id,
		action,
		targetSessionId: node.sessionId,
		direction: action === "branch" ? "right" : undefined,
		readOnly: action === "branch" ? true : undefined,
		createdAt: new Date().toISOString(),
		...extra,
	};
	atomicWriteJson(join(requestsDir, node.sessionId, `${id}.json`), request);
	if (action === "branch") statusMessage = `Branch requested from “${node.label}”`;
	else if (action === "fold") statusMessage = `Fold requested for “${node.label}”`;
	else if (action === "rename") statusMessage = `Renamed branch to “${extra.name}”`;
	else if (action === "resume") statusMessage = "Resume request sent";
	else if (action === "new-root") statusMessage = "New root session requested";
	else if (action === "cleanup") statusMessage = "Runtime cleanup requested";
	else if (action === "minimize") statusMessage = `Hiding “${node.label}”`;
	else statusMessage = `Closing “${node.label}”`;
	scheduleRender();
}

function beginConfirmation(action, node) {
	if (!node) return;
	if (action === "fold" && !node.parentSessionId) {
		statusMessage = "The root session cannot be folded";
		scheduleRender();
		return;
	}
	const nodes = readNodes();
	const parent = nodes.find((candidate) => candidate.sessionId === node.parentSessionId);
	confirmation = {
		action,
		nodeId: node.sessionId,
		text:
			action === "branch"
				? `Create a read-only child from “${node.label}”?`
				: action === "fold"
					? `Fold “${node.label}” into “${parent?.label ?? "parent"}” and close it?`
					: action === "resume"
						? node.displayStatus === "minimized"
							? `Restore “${node.label}” in a new Ghostty pane?`
							: `Resume “${node.label}” in a new Ghostty pane?`
						: action === "remove"
							? `Remove “${node.label}” from this sidebar? Its saved Pi session will be kept.`
							: `Close “${node.label}”? Its saved session will remain available.`, 
	};
	renameEditor = undefined;
	scheduleRender();
}

function beginNewRoot() {
	const coordinator = findCoordinator(readNodes());
	if (!coordinator) {
		statusMessage = "No live Pi pane is available to create a root session";
		scheduleRender();
		return;
	}
	confirmation = {
		action: "new-root",
		nodeId: coordinator.sessionId,
		text: "Create an independent writable root session? It inherits no conversation and shares this working directory.",
	};
	renameEditor = undefined;
	scheduleRender();
}

function beginCleanup() {
	const coordinator = findCoordinator(readNodes());
	if (!coordinator) {
		statusMessage = "No live Pi pane is available to run cleanup";
		scheduleRender();
		return;
	}
	confirmation = {
		action: "cleanup",
		nodeId: coordinator.sessionId,
		text: "Remove stale coordination metadata and generated launchers? Saved Pi sessions will be kept.",
	};
	renameEditor = undefined;
	scheduleRender();
}

function beginRename(node) {
	if (!node) return;
	confirmation = undefined;
	renameEditor = { nodeId: node.sessionId, value: "", original: node.label };
	scheduleRender();
}

function saveRename() {
	if (!renameEditor) return;
	const name = renameEditor.value.trim();
	if (!name) return;
	const path = join(nodesDir, `${renameEditor.nodeId}.json`);
	const node = readJson(path);
	if (node) {
		atomicWriteJson(path, { ...node, label: name, updatedAt: new Date().toISOString() });
		const nodes = readNodes();
		if (node.status === "closed" || !processIsAlive(node.pid)) {
			const coordinator = findCoordinator(nodes, node.sessionId);
			if (coordinator) request("rename", coordinator.sessionId, { branchSessionId: node.sessionId, name });
		} else {
			request("rename", renameEditor.nodeId, { name });
		}
	}
	renameEditor = undefined;
	scheduleRender();
}

function cancelModal() {
	confirmation = undefined;
	renameEditor = undefined;
	statusMessage = "Action cancelled";
	scheduleRender();
}

function updateLocalNode(sessionId, patch) {
	const path = join(nodesDir, `${sessionId}.json`);
	const node = readJson(path);
	if (!node) return;
	atomicWriteJson(path, { ...node, ...patch, updatedAt: new Date().toISOString() });
}

function resumeNode(sessionId) {
	const nodes = readNodes();
	const node = nodes.find((candidate) => candidate.sessionId === sessionId);
	if (!node?.sessionFile) {
		statusMessage = "That branch has no saved Pi session";
		scheduleRender();
		return;
	}
	const coordinator = findCoordinator(nodes, node.sessionId);
	if (!coordinator) {
		statusMessage = "No live Pi pane is available to resume this branch";
		scheduleRender();
		return;
	}
	request("resume", coordinator.sessionId, { branchSessionId: node.sessionId });
	statusMessage = `Resuming “${node.label}”…`;
	scheduleRender();
}

function removeNodeFromSidebar(sessionId) {
	const nodes = readNodes();
	const node = nodes.find((candidate) => candidate.sessionId === sessionId);
	if (!node || node.sessionId === rootSessionId) {
		statusMessage = "The graph root cannot be removed from its own sidebar";
		scheduleRender();
		return;
	}
	for (const child of nodes.filter((candidate) => candidate.parentSessionId === node.sessionId)) {
		updateLocalNode(child.sessionId, { parentSessionId: node.parentSessionId });
	}
	try {
		unlinkSync(join(nodesDir, `${node.sessionId}.json`));
	} catch {
		// Already removed.
	}
	for (const prefix of ["branch", "resume", "root"]) {
		try {
			unlinkSync(join(stateDir, "launchers", `${prefix}-${node.sessionId}.sh`));
		} catch {
			// Launcher may not exist.
		}
	}
	selectedId = node.parentSessionId || rootSessionId;
	publishSelection();
	statusMessage = `Removed “${node.label}” from the sidebar; its Pi session was kept`;
	scheduleRender();
}

function minimizeNode(node) {
	if (node?.displayStatus === "minimized") return beginConfirmation("resume", node);
	if (
		!node ||
		(!node.parentSessionId && node.sessionId === rootSessionId) ||
		!node.terminalId ||
		node.displayStatus === "closed"
	) {
		return;
	}
	request("minimize", node.sessionId);
	statusMessage = `Hiding “${node.label}”; select it later to restore`;
	scheduleRender();
}

function selectedNode() {
	return readNodes().find((node) => node.sessionId === selectedId);
}

function runAction(action) {
	const node = selectedNode();
	const inactive = node?.displayStatus === "closed" || node?.displayStatus === "minimized";
	switch (action) {
		case "branch":
			if (inactive) beginConfirmation("resume", node);
			else beginConfirmation("branch", node);
			return;
		case "fold":
			if (inactive) beginConfirmation("resume", node);
			else beginConfirmation("fold", node);
			return;
		case "new-root":
			beginNewRoot();
			return;
		case "cleanup":
			beginCleanup();
			return;
		case "rename":
			beginRename(node);
			return;
		case "close":
			if (!inactive) beginConfirmation("close", node);
			return;
		case "resume":
			beginConfirmation("resume", node);
			return;
		case "remove":
			beginConfirmation("remove", node);
			return;
		case "minimize":
			minimizeNode(node);
			return;
		case "confirm": {
			const pending = confirmation;
			confirmation = undefined;
			if (!pending) return;
			if (pending.action === "resume") resumeNode(pending.nodeId);
			else if (pending.action === "remove") removeNodeFromSidebar(pending.nodeId);
			else if (pending.action === "new-root") {
				request("new-root", pending.nodeId, { groupRootSessionId: rootSessionId });
			} else request(pending.action, pending.nodeId);
			return;
		}
		case "save-rename":
			saveRename();
			return;
		case "cancel":
			cancelModal();
			return;
		case "focus":
			if (inactive) beginConfirmation("resume", node);
			else if (node) focusTerminal(node.terminalId);
			return;
		case "resize-left":
		case "resize-right":
		case "resize-up":
		case "resize-down":
			if (node) performAction(node.terminalId, `resize_split:${action.slice("resize-".length)},120`);
			return;
		case "sidebar-smaller": {
			const root = readNodes().find((candidate) => candidate.sessionId === rootSessionId);
			if (root) performAction(root.terminalId, "resize_split:left,120");
			return;
		}
		case "sidebar-larger":
			performAction(getSidebarTerminalId(), "resize_split:right,120");
			return;
		case "toggle-layout":
			showLayoutControls = !showLayoutControls;
			statusMessage = showLayoutControls
				? "Layout: H/L move horizontal edges; K/J move vertical edges"
				: "Advanced layout controls hidden";
			scheduleRender();
			return;
		case "equalize":
			if (node) performAction(node.terminalId, "equalize_splits");
			return;
		case "zoom":
			if (node) performAction(node.terminalId, "toggle_split_zoom");
			return;
	}
}

function moveSelection(delta) {
	const flattened = flattenTree(readNodes());
	if (flattened.length === 0) return;
	const current = Math.max(0, flattened.findIndex((item) => item.node.sessionId === selectedId));
	const next = Math.max(0, Math.min(flattened.length - 1, current + delta));
	selectedId = flattened[next].node.sessionId;
	publishSelection();
	scheduleRender();
}

function setCollapsed(collapse) {
	const flattened = flattenTree(readNodes());
	const item = flattened.find((candidate) => candidate.node.sessionId === selectedId);
	if (!item?.hasChildren) return;
	if (collapse) collapsed.add(selectedId);
	else collapsed.delete(selectedId);
	scheduleRender();
}

function handleMouse(button, x, y, pressed) {
	if (!pressed || (button & 3) !== 0) return;
	const buttonTarget = buttonTargets.find((target) => target.row === y && x >= target.start && x <= target.end);
	if (buttonTarget) {
		runAction(buttonTarget.action);
		return;
	}
	const item = rowTargets.get(y);
	if (!item) return;
	// Tree clicks only change selection. Keyboard focus remains in the sidebar;
	// Enter is the explicit action that focuses or resumes the selected pane.
	confirmation = undefined;
	renameEditor = undefined;
	selectedId = item.node.sessionId;
	publishSelection();
	if (x <= item.depth * 2 + 2 && item.hasChildren) {
		if (collapsed.has(selectedId)) collapsed.delete(selectedId);
		else collapsed.add(selectedId);
	}
	statusMessage = `Selected “${item.node.label}” · press Enter to focus`;
	scheduleRender();
}

function handleInput(data) {
	const mousePattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
	let match;
	while ((match = mousePattern.exec(data))) {
		handleMouse(Number(match[1]), Number(match[2]), Number(match[3]), match[4] === "M");
	}
	const keyboard = data.replace(mousePattern, "");
	if (!keyboard) return;

	if (renameEditor) {
		if (keyboard.includes("\x1b") || keyboard.includes("\x03")) return cancelModal();
		const shouldSave = keyboard.includes("\r") || keyboard.includes("\n");
		for (const character of keyboard) {
			if (character === "\x7f" || character === "\b") {
				renameEditor.value = renameEditor.value.slice(0, -1);
			} else if (character >= " " && character !== "\x7f") {
				renameEditor.value += character;
			}
		}
		if (shouldSave) return saveRename();
		scheduleRender();
		return;
	}

	if (confirmation) {
		if (keyboard.includes("\x1b") || keyboard.includes("\x03") || /[nNq]/.test(keyboard)) return cancelModal();
		if (keyboard.includes("\r") || keyboard.includes("\n") || /[yY]/.test(keyboard)) return runAction("confirm");
		return;
	}

	if (keyboard.includes("\x03") || keyboard.includes("q")) return cleanup(0);
	if (keyboard.includes("\x1b[A")) return moveSelection(-1);
	if (keyboard.includes("\x1b[B")) return moveSelection(1);
	if (keyboard.includes("\x1b[D")) return setCollapsed(true);
	if (keyboard.includes("\x1b[C")) return setCollapsed(false);
	if (keyboard.includes("\r") || keyboard.includes("\n")) return runAction("focus");
	if (keyboard.includes("n")) return runAction("new-root");
	if (keyboard.includes("d")) return runAction("cleanup");
	if (keyboard.includes("b")) return runAction("branch");
	if (keyboard.includes("f")) return runAction("fold");
	if (keyboard.includes("r")) return runAction("rename");
	if (keyboard.includes("o")) return runAction("resume");
	if (keyboard.includes("x")) return runAction("remove");
	if (keyboard.includes("h")) return runAction("minimize");
	if (keyboard.includes("c")) return runAction("close");
	if (keyboard.includes("l")) return runAction("toggle-layout");
	if (keyboard.includes("H")) return runAction("resize-left");
	if (keyboard.includes("L")) return runAction("resize-right");
	if (keyboard.includes("K")) return runAction("resize-up");
	if (keyboard.includes("J")) return runAction("resize-down");
	if (keyboard.includes("=")) return runAction("equalize");
	if (keyboard.includes("z")) return runAction("zoom");
	if (keyboard.includes("-")) return runAction("sidebar-smaller");
	if (keyboard.includes("+")) return runAction("sidebar-larger");
}

function cleanup(exitCode) {
	if (stopped) return;
	stopped = true;
	if (renderTimer) clearTimeout(renderTimer);
	clearInterval(refreshInterval);
	process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l");
	for (const path of [sidebarRecord, selectionRecord]) {
		try {
			unlinkSync(path);
		} catch {
			// Parent may already have removed a stale record.
		}
	}
	process.exit(exitCode);
}

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", handleInput);
process.stdout.write(
	`\x1b]2;${surfaceTitle}\x07\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h`,
);
process.on("SIGWINCH", render);
process.on("SIGTERM", () => cleanup(0));
process.on("SIGINT", () => cleanup(0));
process.on("SIGHUP", () => cleanup(0));
const refreshInterval = setInterval(render, 500);
publishSelection();
render();

import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { cleanupState, type CleanupResult } from "./cleanup.ts";
import {
	atomicWriteText,
	claimPath,
	ensureStateDirs,
	foldDirectory,
	getNode,
	getSelectedSessionId,
	getSidebar,
	listJsonPaths,
	listNodes,
	putNode,
	putSidebar,
	readFold,
	readRequest,
	removePath,
	requestDirectory,
	STATE_DIR,
	sidebarPath,
	updateNode,
	writeFold,
	type BranchNode,
	type FoldPacket,
	type SplitDirection,
} from "./state.ts";
import {
	buildLauncher,
	findTerminalByTitle,
	focusTerminal,
	getFocusedTerminalId,
	getPiInvocation,
	performTerminalAction,
	isGhostty,
	scheduleTerminalClose,
	splitTerminal,
	terminalExists,
} from "./ghostty.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const SIDEBAR_PROGRAM = join(EXTENSION_DIR, "sidebar.mjs");
const SCAN_INTERVAL_MS = 350;
const READ_ONLY_TOOLS = "read,grep,find,ls";
const MAX_FOLD_INPUT_CHARS = 100_000;
const CHILD_ENVIRONMENT_DENYLIST = new Set([
	"AI_AGENT",
	"COLORTERM",
	"OLDPWD",
	"PI_CODING_AGENT",
	"PI_MODEL",
	"PI_PROVIDER",
	"PI_REASONING_LEVEL",
	"PI_SESSION_FILE",
	"PI_SESSION_ID",
	"PWD",
	"SHLVL",
	"TERM",
	"TERMINFO",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TERM_SESSION_ID",
	"_",
]);

const FOLD_SYSTEM_PROMPT = `You merge findings from a parallel coding-agent branch back into its parent. Summarize only useful new information from the branch delta.

Include:
- conclusions and decisions
- evidence and important files
- commands or tests run and their outcomes
- code changes, if any
- unresolved questions, risks, and recommended next steps

Be concise and factual. Do not repeat the original task unless needed for clarity. Do not include a preamble.`;

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ghostty creates splits from the GUI application's environment, not from the
 * shell process requesting the split. Recreate normal child-process inheritance
 * while leaving terminal- and session-specific values for Ghostty/Pi to set.
 */
function inheritedChildEnvironment(): Record<string, string> {
	const inherited: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || CHILD_ENVIRONMENT_DENYLIST.has(key)) continue;
		if (key.startsWith("GHOSTTY_") || key.startsWith("ITERM_")) continue;
		inherited[key] = value;
	}
	return inherited;
}

function getTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			if (!part || typeof part !== "object") return false;
			const candidate = part as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string";
		})
		.map((part) => part.text)
		.join("\n");
}

/**
 * Return the longest prefix that does not end in an unmatched assistant tool call.
 * Forking in the middle of a tool batch would create provider-invalid context.
 */
function protocolSafePrefix(entries: SessionEntry[]): SessionEntry[] {
	const pendingToolCalls = new Set<string>();
	let safeIndex = -1;

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				if (Array.isArray(message.content)) {
					for (const part of message.content) {
						if (part.type === "toolCall") pendingToolCalls.add(part.id);
					}
				}
			} else if (message.role === "toolResult") {
				pendingToolCalls.delete(message.toolCallId);
			}
		}

		if (pendingToolCalls.size === 0) safeIndex = index;
	}

	return safeIndex < 0 ? [] : entries.slice(0, safeIndex + 1);
}

function serializeEntry(entry: SessionEntry): string | undefined {
	if (entry.type === "compaction") return `Compaction summary: ${entry.summary}`;
	if (entry.type === "branch_summary") return `Earlier branch summary: ${entry.summary}`;
	if (entry.type === "custom_message") {
		if (entry.customType === "ghostty-branch-fold") return undefined;
		return `Context message: ${getTextContent(entry.content)}`;
	}
	if (entry.type !== "message") return undefined;

	const message = entry.message;
	if (message.role === "user") return `User:\n${getTextContent(message.content)}`;
	if (message.role === "assistant") {
		const lines: string[] = [];
		if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type === "text" && part.text.trim()) lines.push(part.text);
				if (part.type === "toolCall") lines.push(`Tool call: ${part.name} ${JSON.stringify(part.arguments)}`);
			}
		}
		return lines.length > 0 ? `Assistant:\n${lines.join("\n")}` : undefined;
	}
	if (message.role === "toolResult") {
		return `Tool result (${message.toolName}${message.isError ? ", error" : ""}):\n${getTextContent(message.content)}`;
	}
	return undefined;
}

function serializeEntries(entries: SessionEntry[]): string {
	const text = entries.map(serializeEntry).filter((value): value is string => Boolean(value)).join("\n\n");
	if (text.length <= MAX_FOLD_INPUT_CHARS) return text;
	return `[Earlier branch output omitted]\n\n${text.slice(-MAX_FOLD_INPUT_CHARS)}`;
}

function lastEntryId(entries: SessionEntry[]): string | undefined {
	return entries[entries.length - 1]?.id;
}

function childLabel(goal: string | undefined, sessionId: string): string {
	const cleanGoal = goal?.trim().replace(/\s+/g, " ");
	if (cleanGoal) return cleanGoal.length > 52 ? `${cleanGoal.slice(0, 49)}…` : cleanGoal;
	return `branch ${sessionId.slice(0, 8)}`;
}

function sidebarSurfaceTitle(rootSessionId: string): string {
	return `π branches · ${rootSessionId.slice(0, 8)}`;
}

function createRootNode(ctx: ExtensionContext, name: string | undefined): BranchNode {
	const now = new Date().toISOString();
	return {
		version: 1,
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
		rootSessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		label: name || `session ${ctx.sessionManager.getSessionId().slice(0, 8)}`,
		access: "shared-write",
		status: ctx.isIdle() ? "idle" : "working",
		pid: process.pid,
		createdAt: now,
		updatedAt: now,
	};
}

export default function (pi: ExtensionAPI) {
	let activeContext: ExtensionContext | undefined;
	let scanTimer: NodeJS.Timeout | undefined;
	let requestScanRunning = false;
	let foldScanRunning = false;
	let foldCreationRunning = false;
	let shutdownDisposition: "closed" | "minimized" | undefined;
	let lastPaneTitleKey: string | undefined;
	let lastStatusText: string | undefined;

	const rememberContext = (ctx: ExtensionContext): void => {
		activeContext = ctx;
	};

	const applyPaneTitle = (ctx: ExtensionContext, node: BranchNode, selected: boolean): void => {
		const access = node.access === "read-only" ? " · read-only" : "";
		const presentationKey = `${node.label}\u0000${access}\u0000${selected}`;
		if (presentationKey === lastPaneTitleKey) return;
		lastPaneTitleKey = presentationKey;
		ctx.ui.setTitle(`${selected ? "▶ " : ""}π · ${node.label}`);
		ctx.ui.setHeader((_tui, theme) => {
			const canHide = Boolean(node.parentSessionId || node.sessionId !== node.rootSessionId);
			return {
				render(width: number): string[] {
					if (width <= 0) return [];
					if (width < 3) return [theme.fg("borderMuted", "━".repeat(width))];
					const innerWidth = width - 2;
					const fullHideText = "[× Ctrl+Shift+H]";
					const hideText = canHide ? (innerWidth >= 32 ? fullHideText : innerWidth >= 8 ? "[×]" : "") : "";
					const hideWidth = visibleWidth(hideText);
					const gapWidth = hideText ? 1 : 0;
					const titleWidth = Math.max(1, innerWidth - hideWidth - gapWidth);
					const titleText = truncateToWidth(`${selected ? "▶" : "◇"} ${node.label}${access}`, titleWidth, "…");
					const fillWidth = Math.max(0, innerWidth - visibleWidth(titleText) - hideWidth);
					const title = theme.fg("accent", theme.bold(titleText));
					const hide = hideText ? theme.fg("error", hideText) : "";
					const content = ` ${title}${" ".repeat(fillWidth)}${hide} `;
					const banner = theme.bg(selected ? "selectedBg" : "customMessageBg", content);
					const divider = theme.fg(selected ? "borderAccent" : "borderMuted", "━".repeat(width));
					return [banner, divider];
				},
				invalidate() {},
			};
		});
	};

	const refreshPanePresentation = (ctx: ExtensionContext): void => {
		const node = getNode(ctx.sessionManager.getSessionId());
		if (!node) return;
		applyPaneTitle(ctx, node, getSelectedSessionId(node.rootSessionId) === node.sessionId);
	};

	const refreshFooterStatus = (ctx: ExtensionContext): void => {
		const node = getNode(ctx.sessionManager.getSessionId());
		if (!node) return;
		const activeCount = listNodes(node.rootSessionId).filter((candidate) => candidate.status !== "closed").length;
		const text = `◇ ${Math.max(0, activeCount - 1)} branch${activeCount === 2 ? "" : "es"}`;
		if (text !== lastStatusText) {
			lastStatusText = text;
			ctx.ui.setStatus("ghostty-branches", text);
		}
	};

	const ensureCurrentNode = async (ctx: ExtensionContext): Promise<BranchNode> => {
		ensureStateDirs();
		const sessionId = ctx.sessionManager.getSessionId();
		let node = getNode(sessionId);
		const shouldRebindTerminal =
			!node?.terminalId || (node.pid !== process.pid && node.pid > 0 && !processIsAlive(node.pid));
		if (!node) {
			node = createRootNode(ctx, pi.getSessionName());
			putNode(node);
		} else {
			node =
				updateNode(sessionId, {
					sessionFile: ctx.sessionManager.getSessionFile(),
					cwd: ctx.cwd,
					label: node.parentSessionId ? node.label : pi.getSessionName() || node.label,
					pid: process.pid,
					status: ctx.isIdle() ? "idle" : "working",
					lastError: undefined,
				}) ?? node;
		}

		if (isGhostty() && shouldRebindTerminal) {
			// A freshly created child may start before its parent finishes recording the
			// terminal ID returned by Ghostty. Give that write a brief chance to land.
			if (node.parentSessionId && !node.terminalId) {
				await sleep(120);
				node = getNode(sessionId) ?? node;
			}
			if (!node.terminalId) {
				try {
					const terminalId = await getFocusedTerminalId();
					if (terminalId) node = updateNode(sessionId, { terminalId, pid: process.pid }) ?? node;
				} catch (error) {
					updateNode(sessionId, { lastError: error instanceof Error ? error.message : String(error) });
				}
			}
		}

		return node;
	};

	const createSessionSnapshot = (
		ctx: ExtensionContext,
		parentNode: BranchNode,
		goal: string | undefined,
		readOnly: boolean,
		direction: SplitDirection,
	): { childNode: BranchNode; childSessionFile: string } => {
		const branch = protocolSafePrefix(ctx.sessionManager.getBranch());
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		const sessionDir = ctx.sessionManager.getSessionDir() || undefined;
		const childManager = SessionManager.create(ctx.cwd, sessionDir, { parentSession: parentSessionFile });
		const childSessionFile = childManager.getSessionFile();
		const header = childManager.getHeader();
		if (!childSessionFile || !header) throw new Error("Could not allocate a child session file");

		atomicWriteText(childSessionFile, [header, ...branch].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		const label = childLabel(goal, header.id);
		SessionManager.open(childSessionFile).appendSessionInfo(label);

		const now = new Date().toISOString();
		const childNode: BranchNode = {
			version: 1,
			sessionId: header.id,
			sessionFile: childSessionFile,
			parentSessionId: parentNode.sessionId,
			parentSessionFile,
			rootSessionId: parentNode.rootSessionId,
			forkEntryId: lastEntryId(branch),
			cwd: ctx.cwd,
			splitDirection: direction,
			label,
			goal: goal?.trim() || undefined,
			access: readOnly ? "read-only" : "shared-write",
			status: "idle",
			pid: 0,
			createdAt: now,
			updatedAt: now,
		};
		putNode(childNode);
		return { childNode, childSessionFile };
	};

	const createBranch = async (
		ctx: ExtensionContext,
		options: {
			goal?: string;
			direction?: SplitDirection;
			readOnly?: boolean;
			allowFocusedTerminalFallback?: boolean;
		},
	): Promise<void> => {
		rememberContext(ctx);
		if (!isGhostty()) {
			ctx.ui.notify("Ghostty Branches currently requires a Pi session running inside Ghostty", "error");
			return;
		}

		const parentNode = await ensureCurrentNode(ctx);
		const readOnly = options.readOnly ?? true;
		const direction = options.direction ?? "right";
		const { childNode, childSessionFile } = createSessionSnapshot(
			ctx,
			parentNode,
			options.goal,
			readOnly,
			direction,
		);

		try {
			let sourceTerminalId = getNode(parentNode.sessionId)?.terminalId;
			if (!sourceTerminalId && options.allowFocusedTerminalFallback) {
				sourceTerminalId = await getFocusedTerminalId();
				if (sourceTerminalId) updateNode(parentNode.sessionId, { terminalId: sourceTerminalId });
			}
			if (!sourceTerminalId) throw new Error("The parent session is not associated with a Ghostty pane yet");

			const invocation = getPiInvocation();
			const args = [...invocation.args, "--session", childSessionFile];
			if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
			if (ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);
			if (readOnly) args.push("--tools", READ_ONLY_TOOLS);
			if (options.goal?.trim()) args.push("--", options.goal.trim());

			const launcherPath = join(STATE_DIR, "launchers", `branch-${childNode.sessionId}.sh`);
			atomicWriteText(launcherPath, buildLauncher(invocation.command, args, ctx.cwd), 0o700);
			chmodSync(launcherPath, 0o700);

			const terminalId = await splitTerminal({
				sourceTerminalId,
				direction,
				cwd: ctx.cwd,
				command: launcherPath,
				waitAfterCommand: false,
				environment: inheritedChildEnvironment(),
			});
			updateNode(childNode.sessionId, { terminalId, status: "idle", lastError: undefined });
			refreshFooterStatus(ctx);
			ctx.ui.notify(
				`Created ${readOnly ? "read-only " : "writable "}branch “${childNode.label}” in a Ghostty split`,
				"info",
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			updateNode(childNode.sessionId, { status: "error", lastError: message });
			ctx.ui.notify(`Branch session was saved at ${childSessionFile}, but the Ghostty split failed: ${message}`, "error");
		}
	};

	const createRootSession = async (ctx: ExtensionContext, groupRootSessionId?: string): Promise<void> => {
		if (!isGhostty()) return;
		const coordinator = await ensureCurrentNode(ctx);
		const sourceTerminalId = getNode(coordinator.sessionId)?.terminalId;
		if (!sourceTerminalId) {
			ctx.ui.notify("Could not identify a live Ghostty pane for the new root session", "error");
			return;
		}

		const sessionDir = ctx.sessionManager.getSessionDir() || undefined;
		const sessionManager = SessionManager.create(ctx.cwd, sessionDir);
		const sessionFile = sessionManager.getSessionFile();
		const header = sessionManager.getHeader();
		if (!sessionFile || !header) throw new Error("Could not allocate a root session file");
		atomicWriteText(sessionFile, `${JSON.stringify(header)}\n`);
		const label = `root ${header.id.slice(0, 8)}`;
		SessionManager.open(sessionFile).appendSessionInfo(label);

		const now = new Date().toISOString();
		const node: BranchNode = {
			version: 1,
			sessionId: header.id,
			sessionFile,
			rootSessionId: groupRootSessionId ?? coordinator.rootSessionId,
			cwd: ctx.cwd,
			label,
			access: "shared-write",
			status: "idle",
			pid: 0,
			splitDirection: "right",
			createdAt: now,
			updatedAt: now,
		};
		putNode(node);

		try {
			const invocation = getPiInvocation();
			const args = [...invocation.args, "--session", sessionFile];
			if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
			if (ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);
			const launcherPath = join(STATE_DIR, "launchers", `root-${node.sessionId}.sh`);
			atomicWriteText(launcherPath, buildLauncher(invocation.command, args, node.cwd), 0o700);
			chmodSync(launcherPath, 0o700);
			const terminalId = await splitTerminal({
				sourceTerminalId,
				direction: "right",
				cwd: node.cwd,
				command: launcherPath,
				waitAfterCommand: false,
				environment: inheritedChildEnvironment(),
			});
			updateNode(node.sessionId, { terminalId, status: "idle", lastError: undefined });
			ctx.ui.notify(`Created independent root session “${label}”`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			updateNode(node.sessionId, { status: "error", lastError: message });
			ctx.ui.notify(`Could not open the new root session: ${message}`, "error");
		}
	};

	const hideCurrentPane = (ctx: ExtensionContext): void => {
		const node = getNode(ctx.sessionManager.getSessionId());
		if (!node || (!node.parentSessionId && node.sessionId === node.rootSessionId)) {
			ctx.ui.notify("The sidebar's coordinating root pane cannot be hidden", "warning");
			return;
		}
		shutdownDisposition = "minimized";
		updateNode(node.sessionId, { status: "minimized" });
		if (node.terminalId) scheduleTerminalClose(node.terminalId);
		ctx.ui.notify("Branch hidden; restore it from the sidebar", "info");
		ctx.abort();
		ctx.shutdown();
	};

	const resumeBranch = async (ctx: ExtensionContext, branchSessionId: string | undefined): Promise<void> => {
		if (!branchSessionId) return;
		const node = getNode(branchSessionId);
		if (!node?.sessionFile || !existsSync(node.sessionFile)) {
			ctx.ui.notify("The saved branch session file is no longer available", "error");
			return;
		}
		if (node.pid > 0 && processIsAlive(node.pid) && node.terminalId) {
			if (await focusTerminal(node.terminalId)) return;
		}

		const coordinator = await ensureCurrentNode(ctx);
		const sourceTerminalId = getNode(coordinator.sessionId)?.terminalId;
		if (!sourceTerminalId) {
			ctx.ui.notify("Could not identify a live Ghostty pane for the resumed branch", "error");
			return;
		}

		try {
			const invocation = getPiInvocation();
			const args = [...invocation.args, "--session", node.sessionFile];
			if (node.access === "read-only") args.push("--tools", READ_ONLY_TOOLS);
			const launcherPath = join(STATE_DIR, "launchers", `resume-${node.sessionId}.sh`);
			atomicWriteText(launcherPath, buildLauncher(invocation.command, args, node.cwd), 0o700);
			chmodSync(launcherPath, 0o700);
			const terminalId = await splitTerminal({
				sourceTerminalId,
				direction: "right",
				cwd: node.cwd,
				command: launcherPath,
				waitAfterCommand: false,
				environment: inheritedChildEnvironment(),
			});
			updateNode(node.sessionId, {
				terminalId,
				status: "idle",
				minimized: false,
				lastError: undefined,
			});
			ctx.ui.notify(`Resumed “${node.label}” in a new Ghostty pane`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			updateNode(node.sessionId, { status: "error", lastError: message });
			ctx.ui.notify(`Could not resume branch: ${message}`, "error");
		}
	};

	const summarizeFold = async (
		ctx: ExtensionContext,
		node: BranchNode,
		entries: SessionEntry[],
		instructions?: string,
	): Promise<string> => {
		const transcript = serializeEntries(entries);
		if (!transcript.trim()) return "This branch has no new conversation entries to fold into its parent.";
		if (!ctx.model) return transcript;

		const userText = [
			node.goal ? `Branch goal: ${node.goal}` : undefined,
			instructions?.trim() ? `Additional fold instructions: ${instructions.trim()}` : undefined,
			"Branch delta:",
			transcript,
		]
			.filter((part): part is string => Boolean(part))
			.join("\n\n");

		try {
			const response = await ctx.modelRegistry.complete(
				ctx.model,
				{
					systemPrompt: FOLD_SYSTEM_PROMPT,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: userText }],
							timestamp: Date.now(),
						},
					],
				},
				{ cacheRetention: "none", sessionId: uuidv7() },
			);
			const summary = response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
			return summary || transcript;
		} catch {
			return `The automatic fold summary failed. Raw branch delta follows:\n\n${transcript.slice(-40_000)}`;
		}
	};

	const createFold = async (ctx: ExtensionContext, instructions?: string): Promise<void> => {
		if (foldCreationRunning) return;
		const node = getNode(ctx.sessionManager.getSessionId());
		if (!node?.parentSessionId) {
			ctx.ui.notify("This is a root session and has no parent to fold into", "warning");
			return;
		}

		foldCreationRunning = true;
		updateNode(node.sessionId, { status: "folding" });
		try {
			const branch = ctx.sessionManager.getBranch();
			const marker = node.lastFoldedEntryId ?? node.forkEntryId;
			const markerIndex = marker ? branch.findIndex((entry) => entry.id === marker) : -1;
			const delta = markerIndex >= 0 ? branch.slice(markerIndex + 1) : branch;
			if (!serializeEntries(delta).trim()) {
				updateNode(node.sessionId, { status: "idle", lastError: undefined });
				ctx.ui.notify("Nothing new to fold; the branch remains open", "warning");
				return;
			}
			const summary = await summarizeFold(ctx, node, delta, instructions);
			const toEntryId = lastEntryId(branch);
			writeFold({
				childSessionId: node.sessionId,
				parentSessionId: node.parentSessionId,
				fromEntryId: marker,
				toEntryId,
				summary,
				childSessionFile: node.sessionFile,
			});
			shutdownDisposition = "closed";
			updateNode(node.sessionId, {
				status: "closed",
				lastFoldedEntryId: toEntryId,
				lastFoldedAt: new Date().toISOString(),
				lastError: undefined,
			});
			if (node.terminalId) scheduleTerminalClose(node.terminalId);
			ctx.ui.notify("Fold sent to the parent session; closing this branch", "info");
			ctx.shutdown();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			updateNode(node.sessionId, { status: "error", lastError: message });
			ctx.ui.notify(`Could not fold branch: ${message}`, "error");
		} finally {
			foldCreationRunning = false;
		}
	};

	const foldAlreadyInjected = (ctx: ExtensionContext, foldId: string): boolean => {
		return ctx.sessionManager.getBranch().some((entry) => {
			if (entry.type !== "custom_message" || entry.customType !== "ghostty-branch-fold") return false;
			const details = entry.details as { foldId?: string } | undefined;
			return details?.foldId === foldId;
		});
	};

	const injectFold = (ctx: ExtensionContext, packet: FoldPacket): void => {
		if (foldAlreadyInjected(ctx, packet.id)) return;
		const child = getNode(packet.childSessionId);
		const label = child?.label ?? packet.childSessionId.slice(0, 8);
		pi.sendMessage(
			{
				customType: "ghostty-branch-fold",
				content: `Parallel branch “${label}” folded these findings into this session:\n\n${packet.summary}`,
				display: true,
				details: {
					foldId: packet.id,
					childSessionId: packet.childSessionId,
					childSessionFile: packet.childSessionFile,
				},
			},
			{ triggerTurn: false },
		);
		ctx.ui.notify(`Received folded findings from “${label}”`, "info");
	};

	const scanFoldInbox = async (): Promise<void> => {
		const ctx = activeContext;
		if (!ctx || foldScanRunning || !ctx.isIdle()) return;
		foldScanRunning = true;
		try {
			for (const path of listJsonPaths(foldDirectory(ctx.sessionManager.getSessionId()))) {
				const claimed = claimPath(path);
				if (!claimed) continue;
				try {
					const packet = readFold(claimed);
					if (packet?.parentSessionId === ctx.sessionManager.getSessionId()) injectFold(ctx, packet);
				} finally {
					removePath(claimed);
				}
			}
		} finally {
			foldScanRunning = false;
		}
	};

	const formatCleanupResult = (result: CleanupResult): string => {
		const parts = [
			["node", result.nodes],
			["sidebar", result.sidebars],
			["selection", result.selections],
			["launcher", result.launchers],
			["request", result.requests],
			["fold claim", result.folds],
			["temporary file", result.temporaryFiles],
		]
			.filter(([, count]) => Number(count) > 0)
			.map(([label, count]) => `${count} ${label}${Number(count) === 1 ? "" : "s"}`);
		return parts.length > 0 ? parts.join(", ") : "nothing stale";
	};

	const cleanupRuntimeState = async (ctx: ExtensionContext, confirm: boolean): Promise<void> => {
		if (confirm) {
			const accepted = await ctx.ui.confirm(
				"Clean branch runtime state?",
				"Remove stale coordination metadata and generated launchers? Saved Pi session files will not be deleted.",
			);
			if (!accepted) return;
		}
		const result = await cleanupState({
			stateDir: STATE_DIR,
			terminalExists: (terminalId) => terminalExists(terminalId),
		});
		ctx.ui.notify(`Branch cleanup complete: ${formatCleanupResult(result)}`, "info");
	};

	const scanRequests = async (): Promise<void> => {
		const ctx = activeContext;
		if (!ctx || requestScanRunning) return;
		requestScanRunning = true;
		try {
			for (const path of listJsonPaths(requestDirectory(ctx.sessionManager.getSessionId()))) {
				const request = readRequest(path);
				if (!request) {
					removePath(path);
					continue;
				}
				if (request.action === "fold" && !ctx.isIdle()) continue;

				const claimed = claimPath(path);
				if (!claimed) continue;
				try {
					if (request.action === "branch") {
						await createBranch(ctx, {
							goal: request.goal,
							direction: request.direction,
							readOnly: request.readOnly,
							allowFocusedTerminalFallback: false,
						});
					} else if (request.action === "fold") {
						await createFold(ctx, request.instructions);
					} else if (request.action === "rename") {
						const name = request.name?.trim();
						const renamedSessionId = request.branchSessionId ?? ctx.sessionManager.getSessionId();
						if (name && renamedSessionId === ctx.sessionManager.getSessionId()) {
							pi.setSessionName(name);
							const updated =
								updateNode(renamedSessionId, { label: name, lastError: undefined }) ?? getNode(renamedSessionId);
							if (updated) refreshPanePresentation(ctx);
						} else if (name) {
							const renamedNode = getNode(renamedSessionId);
							if (renamedNode?.sessionFile && existsSync(renamedNode.sessionFile)) {
								SessionManager.open(renamedNode.sessionFile).appendSessionInfo(name);
								updateNode(renamedSessionId, { label: name, lastError: undefined });
							}
						}
					} else if (request.action === "resume") {
						await resumeBranch(ctx, request.branchSessionId);
					} else if (request.action === "new-root") {
						await createRootSession(ctx, request.groupRootSessionId);
					} else if (request.action === "cleanup") {
						await cleanupRuntimeState(ctx, false);
					} else if (request.action === "minimize") {
						hideCurrentPane(ctx);
					} else {
						const currentNode = getNode(ctx.sessionManager.getSessionId());
						shutdownDisposition = "closed";
						updateNode(ctx.sessionManager.getSessionId(), { status: "closed" });
						if (currentNode?.terminalId) scheduleTerminalClose(currentNode.terminalId);
						ctx.abort();
						ctx.shutdown();
					}
				} finally {
					removePath(claimed);
				}
			}
		} finally {
			requestScanRunning = false;
		}
	};

	const tick = async (): Promise<void> => {
		const ctx = activeContext;
		if (!ctx) return;
		const currentNode = getNode(ctx.sessionManager.getSessionId());
		if (
			currentNode &&
			!shutdownDisposition &&
			(currentNode.pid !== process.pid || currentNode.status === "closed" || currentNode.status === "minimized")
		) {
			updateNode(currentNode.sessionId, {
				pid: process.pid,
				status:
					currentNode.status === "closed" || currentNode.status === "minimized"
						? ctx.isIdle()
							? "idle"
							: "working"
						: currentNode.status,
			});
		}
		await scanRequests();
		await scanFoldInbox();
		refreshPanePresentation(ctx);
		refreshFooterStatus(ctx);
	};

	const openSidebar = async (ctx: ExtensionContext): Promise<void> => {
		rememberContext(ctx);
		if (!isGhostty()) {
			ctx.ui.notify("The branch sidebar currently requires Ghostty on macOS", "error");
			return;
		}
		const node = await ensureCurrentNode(ctx);
		const rootSessionId = node.rootSessionId;
		const title = sidebarSurfaceTitle(rootSessionId);
		let sourceTerminalId = getNode(node.sessionId)?.terminalId;
		if (!sourceTerminalId) {
			sourceTerminalId = await getFocusedTerminalId();
			if (sourceTerminalId) updateNode(node.sessionId, { terminalId: sourceTerminalId });
		}
		if (!sourceTerminalId) {
			ctx.ui.notify("Could not identify the current Ghostty pane", "error");
			return;
		}

		const revealExistingSidebar = async (terminalId: string): Promise<boolean> => {
			const exists = await terminalExists(terminalId).catch(() => false);
			if (!exists) return false;
			if (await focusTerminal(terminalId).catch(() => false)) return true;

			// A zoomed Pi pane can make another surface temporarily unfocusable.
			// Unzoom the caller and retry rather than mistaking the sidebar for stale.
			await performTerminalAction(sourceTerminalId, "toggle_split_zoom").catch(() => false);
			await sleep(80);
			if (await focusTerminal(terminalId).catch(() => false)) return true;

			// The terminal still exists. Never create a duplicate merely because it
			// is temporarily hidden or Ghostty refused a focus transition.
			ctx.ui.notify("The existing branch sidebar is present but Ghostty could not reveal it", "warning");
			return true;
		};

		const existing = getSidebar(rootSessionId);
		if (existing?.terminalId && (await revealExistingSidebar(existing.terminalId))) return;
		if (existing?.terminalId) removePath(sidebarPath(rootSessionId));

		// Recover if the record was lost while the sidebar process/surface survived.
		const discoveredTerminalId = await findTerminalByTitle(title).catch(() => undefined);
		if (discoveredTerminalId) {
			putSidebar(rootSessionId, { terminalId: discoveredTerminalId });
			if (await revealExistingSidebar(discoveredTerminalId)) return;
		}

		if (!existsSync(SIDEBAR_PROGRAM)) {
			ctx.ui.notify(`Branch sidebar program is missing: ${SIDEBAR_PROGRAM}`, "error");
			return;
		}
		const launcherPath = join(STATE_DIR, "launchers", `sidebar-${rootSessionId}.sh`);
		const launcher = buildLauncher(
			process.execPath,
			[SIDEBAR_PROGRAM, "--state-dir", STATE_DIR, "--root", rootSessionId],
			ctx.cwd,
		);
		atomicWriteText(launcherPath, launcher, 0o700);
		chmodSync(launcherPath, 0o700);

		try {
			const terminalId = await splitTerminal({
				sourceTerminalId,
				direction: "left",
				cwd: ctx.cwd,
				command: launcherPath,
				waitAfterCommand: false,
				// Apply the initial sidebar shrink in the same Ghostty automation
				// transaction as the split to avoid a second delayed resize/reflow.
				sourcePostAction: "resize_split:left,420",
			});
			putSidebar(rootSessionId, { terminalId });
		} catch (error) {
			ctx.ui.notify(`Could not open branch sidebar: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	pi.registerMessageRenderer("ghostty-branch-fold", (message, { expanded }, theme) => {
		const text = getTextContent(message.content);
		const lines = text.split("\n");
		const shown = expanded || lines.length <= 14 ? text : `${lines.slice(0, 14).join("\n")}\n… (Ctrl+O to expand)`;
		return new Text(theme.fg("accent", theme.bold("⇣ Folded branch findings")) + `\n${shown}`, 1, 0);
	});

	pi.registerCommand("branch", {
		description: "Create a read-only child session in a Ghostty split: /branch [goal]",
		handler: async (args, ctx) => {
			await createBranch(ctx, {
				goal: args.trim() || undefined,
				direction: "right",
				readOnly: true,
				allowFocusedTerminalFallback: true,
			});
		},
	});

	pi.registerCommand("branch-write", {
		description: "Create a writable child in the shared working directory (unsafe for concurrent edits)",
		handler: async (args, ctx) => {
			ctx.ui.notify("Writable first-pass branches share the same working directory; concurrent edits may conflict", "warning");
			await createBranch(ctx, {
				goal: args.trim() || undefined,
				direction: "right",
				readOnly: false,
				allowFocusedTerminalFallback: true,
			});
		},
	});

	pi.registerCommand("branches", {
		description: "Open/focus the branch sidebar, or clean stale state with /branches cleanup",
		getArgumentCompletions: (prefix) => {
			const item = { value: "cleanup", label: "cleanup — remove stale runtime metadata" };
			return item.value.startsWith(prefix) ? [item] : null;
		},
		handler: async (args, ctx) => {
			if (args.trim() === "cleanup") await cleanupRuntimeState(ctx, true);
			else await openSidebar(ctx);
		},
	});

	pi.registerCommand("branch-sidebar", {
		description: "Alias for /branches",
		handler: async (_args, ctx) => openSidebar(ctx),
	});

	pi.registerCommand("fold", {
		description: "Summarize this branch's new findings into its parent session",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Waiting for this branch to settle before folding…", "info");
				await ctx.waitForIdle();
			}
			rememberContext(ctx);
			await createFold(ctx, args.trim() || undefined);
		},
	});

	pi.registerShortcut("ctrl+shift+b", {
		description: "Branch current session into a Ghostty split",
		handler: async (ctx) => {
			await createBranch(ctx, {
				direction: "right",
				readOnly: true,
				allowFocusedTerminalFallback: true,
			});
		},
	});

	pi.registerShortcut("ctrl+shift+s", {
		description: "Focus the Ghostty branch sidebar",
		handler: async (ctx) => openSidebar(ctx),
	});

	pi.registerShortcut("ctrl+shift+h", {
		description: "Hide the current Ghostty branch pane",
		handler: (ctx) => hideCurrentPane(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		rememberContext(ctx);
		await ensureCurrentNode(ctx);
		refreshPanePresentation(ctx);
		if (scanTimer) clearInterval(scanTimer);
		scanTimer = setInterval(() => void tick(), SCAN_INTERVAL_MS);
		scanTimer.unref?.();
		await tick();
	});

	pi.on("session_info_changed", (event, ctx) => {
		rememberContext(ctx);
		const node = getNode(ctx.sessionManager.getSessionId());
		if (!node) return;
		updateNode(node.sessionId, { label: event.name || node.label });
		lastPaneTitleKey = undefined;
		refreshPanePresentation(ctx);
	});

	pi.on("model_select", (_event, ctx) => rememberContext(ctx));
	pi.on("thinking_level_select", (_event, ctx) => rememberContext(ctx));

	pi.on("agent_start", (_event, ctx) => {
		rememberContext(ctx);
		updateNode(ctx.sessionManager.getSessionId(), { status: "working", pid: process.pid });
	});

	pi.on("agent_settled", async (_event, ctx) => {
		rememberContext(ctx);
		updateNode(ctx.sessionManager.getSessionId(), { status: "idle", pid: process.pid });
		await tick();
	});

	pi.on("session_shutdown", (event, ctx) => {
		if (scanTimer) clearInterval(scanTimer);
		scanTimer = undefined;
		activeContext = undefined;
		lastPaneTitleKey = undefined;
		lastStatusText = undefined;
		ctx.ui.setStatus("ghostty-branches", undefined);
		updateNode(ctx.sessionManager.getSessionId(), {
			status: event.reason === "reload" ? "idle" : shutdownDisposition ?? "closed",
			pid: process.pid,
		});
		shutdownDisposition = undefined;
	});
}

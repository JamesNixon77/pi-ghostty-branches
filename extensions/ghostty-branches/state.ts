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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type SplitDirection = "right" | "left" | "down" | "up";
export type BranchStatus = "idle" | "working" | "folding" | "minimized" | "closed" | "error";

export interface BranchNode {
	version: 1;
	sessionId: string;
	sessionFile?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	rootSessionId: string;
	forkEntryId?: string;
	lastFoldedEntryId?: string;
	terminalId?: string;
	splitDirection?: SplitDirection;
	minimized?: boolean;
	cwd: string;
	label: string;
	goal?: string;
	access: "read-only" | "shared-write";
	status: BranchStatus;
	pid: number;
	createdAt: string;
	updatedAt: string;
	lastFoldedAt?: string;
	lastError?: string;
}

export interface BranchRequest {
	version: 1;
	id: string;
	action: "branch" | "fold" | "rename" | "close" | "minimize" | "resume" | "new-root" | "cleanup";
	targetSessionId: string;
	branchSessionId?: string;
	groupRootSessionId?: string;
	goal?: string;
	instructions?: string;
	name?: string;
	direction?: SplitDirection;
	readOnly?: boolean;
	createdAt: string;
}

export interface FoldPacket {
	version: 1;
	id: string;
	childSessionId: string;
	parentSessionId: string;
	fromEntryId?: string;
	toEntryId?: string;
	summary: string;
	childSessionFile?: string;
	createdAt: string;
}

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const STATE_DIR = join(agentDir, "ghostty-branches");
export const NODES_DIR = join(STATE_DIR, "nodes");
export const REQUESTS_DIR = join(STATE_DIR, "requests");
export const FOLDS_DIR = join(STATE_DIR, "folds");
export const SIDEBARS_DIR = join(STATE_DIR, "sidebars");
export const SELECTIONS_DIR = join(STATE_DIR, "selections");
export const LAUNCHERS_DIR = join(STATE_DIR, "launchers");

export function ensureStateDirs(): void {
	for (const dir of [STATE_DIR, NODES_DIR, REQUESTS_DIR, FOLDS_DIR, SIDEBARS_DIR, SELECTIONS_DIR, LAUNCHERS_DIR]) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		try {
			chmodSync(dir, 0o700);
		} catch {
			// Best effort on filesystems that do not support POSIX modes.
		}
	}
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function atomicWriteText(path: string, content: string, mode = 0o600): void {
	ensureStateDirs();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, content, { encoding: "utf8", mode });
	renameSync(temporary, path);
	try {
		chmodSync(path, mode);
	} catch {
		// Best effort.
	}
}

export function atomicWriteJson(path: string, value: unknown): void {
	atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function nodePath(sessionId: string): string {
	return join(NODES_DIR, `${sessionId}.json`);
}

export function getNode(sessionId: string): BranchNode | undefined {
	return readJson<BranchNode>(nodePath(sessionId));
}

export function putNode(node: BranchNode): void {
	atomicWriteJson(nodePath(node.sessionId), node);
}

export function updateNode(sessionId: string, patch: Partial<BranchNode>): BranchNode | undefined {
	const current = getNode(sessionId);
	if (!current) return undefined;
	const next: BranchNode = {
		...current,
		...patch,
		sessionId: current.sessionId,
		version: 1,
		updatedAt: new Date().toISOString(),
	};
	putNode(next);
	return next;
}

export function listNodes(rootSessionId?: string): BranchNode[] {
	ensureStateDirs();
	const nodes: BranchNode[] = [];
	for (const file of readdirSync(NODES_DIR)) {
		if (!file.endsWith(".json")) continue;
		const node = readJson<BranchNode>(join(NODES_DIR, file));
		if (!node || node.version !== 1) continue;
		if (rootSessionId && node.rootSessionId !== rootSessionId) continue;
		nodes.push(node);
	}
	return nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function requestDirectory(sessionId: string): string {
	return join(REQUESTS_DIR, sessionId);
}

export function foldDirectory(sessionId: string): string {
	return join(FOLDS_DIR, sessionId);
}

export function writeRequest(
	targetSessionId: string,
	request: Omit<BranchRequest, "version" | "id" | "targetSessionId" | "createdAt">,
): BranchRequest {
	const value: BranchRequest = {
		version: 1,
		id: randomUUID(),
		targetSessionId,
		createdAt: new Date().toISOString(),
		...request,
	};
	atomicWriteJson(join(requestDirectory(targetSessionId), `${value.id}.json`), value);
	return value;
}

export function writeFold(packet: Omit<FoldPacket, "version" | "id" | "createdAt">): FoldPacket {
	const value: FoldPacket = {
		version: 1,
		id: randomUUID(),
		createdAt: new Date().toISOString(),
		...packet,
	};
	atomicWriteJson(join(foldDirectory(value.parentSessionId), `${value.id}.json`), value);
	return value;
}

export function listJsonPaths(directory: string): string[] {
	if (!existsSync(directory)) return [];
	try {
		return readdirSync(directory)
			.filter((file) => file.endsWith(".json"))
			.sort()
			.map((file) => join(directory, file));
	} catch {
		return [];
	}
}

export function readRequest(path: string): BranchRequest | undefined {
	return readJson<BranchRequest>(path);
}

export function readFold(path: string): FoldPacket | undefined {
	return readJson<FoldPacket>(path);
}

export function claimPath(path: string): string | undefined {
	const claimed = `${path}.processing-${process.pid}`;
	try {
		renameSync(path, claimed);
		return claimed;
	} catch {
		return undefined;
	}
}

export function removePath(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already removed or unavailable.
	}
}

export function sidebarPath(rootSessionId: string): string {
	return join(SIDEBARS_DIR, `${rootSessionId}.json`);
}

export function getSidebar(rootSessionId: string): { terminalId: string; pid?: number } | undefined {
	return readJson(sidebarPath(rootSessionId));
}

export function putSidebar(rootSessionId: string, value: { terminalId: string; pid?: number }): void {
	atomicWriteJson(sidebarPath(rootSessionId), value);
}

export function selectionPath(rootSessionId: string): string {
	return join(SELECTIONS_DIR, `${rootSessionId}.json`);
}

export function getSelectedSessionId(rootSessionId: string): string | undefined {
	return readJson<{ sessionId?: string }>(selectionPath(rootSessionId))?.sessionId;
}

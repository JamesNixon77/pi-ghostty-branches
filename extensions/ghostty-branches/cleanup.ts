import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
	renameSync,
} from "node:fs";
import { basename, join } from "node:path";

export interface CleanupResult {
	nodes: number;
	sidebars: number;
	selections: number;
	launchers: number;
	requests: number;
	folds: number;
	temporaryFiles: number;
}

interface CleanupNode {
	sessionId: string;
	sessionFile?: string;
	parentSessionId?: string;
	terminalId?: string;
	pid?: number;
}

interface CleanupOptions {
	stateDir: string;
	terminalExists: (terminalId: string) => Promise<boolean>;
	now?: number;
	staleMilliseconds?: number;
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function processIsAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function files(directory: string): string[] {
	if (!existsSync(directory)) return [];
	try {
		return readdirSync(directory).map((file) => join(directory, file));
	} catch {
		return [];
	}
}

function remove(path: string): boolean {
	try {
		rmSync(path, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

function isOlderThan(path: string, cutoff: number): boolean {
	try {
		return statSync(path).mtimeMs < cutoff;
	} catch {
		return false;
	}
}

function launcherSessionId(file: string): string | undefined {
	const match = basename(file).match(/^(?:branch|resume|root)-(.+)\.sh$/);
	return match?.[1];
}

/**
 * Remove only reconstructable/orphaned coordination data. Pi session JSONL
 * files are never deleted by this function.
 */
export async function cleanupState(options: CleanupOptions): Promise<CleanupResult> {
	const now = options.now ?? Date.now();
	const staleMilliseconds = options.staleMilliseconds ?? 60 * 60 * 1000;
	const staleCutoff = now - staleMilliseconds;
	const result: CleanupResult = {
		nodes: 0,
		sidebars: 0,
		selections: 0,
		launchers: 0,
		requests: 0,
		folds: 0,
		temporaryFiles: 0,
	};

	const nodesDir = join(options.stateDir, "nodes");
	const sidebarsDir = join(options.stateDir, "sidebars");
	const selectionsDir = join(options.stateDir, "selections");
	const launchersDir = join(options.stateDir, "launchers");
	const requestsDir = join(options.stateDir, "requests");
	const foldsDir = join(options.stateDir, "folds");

	const nodePaths = files(nodesDir).filter((path) => path.endsWith(".json"));
	const nodes = nodePaths.map((path) => ({ path, node: readJson<CleanupNode>(path) })).filter((item) => item.node);
	const removedNodeIds = new Set<string>();

	for (const { path, node } of nodes as Array<{ path: string; node: CleanupNode }>) {
		if (processIsAlive(node.pid)) continue;
		if (node.sessionFile && existsSync(node.sessionFile)) continue;
		let hasTerminal = false;
		if (node.terminalId) {
			try {
				hasTerminal = await options.terminalExists(node.terminalId);
			} catch {
				// Fail closed: preserve metadata if terminal liveness cannot be checked.
				hasTerminal = true;
			}
		}
		if (hasTerminal) continue;
		if (remove(path)) {
			removedNodeIds.add(node.sessionId);
			result.nodes++;
		}
	}

	// Preserve descendants of removed metadata nodes by reconnecting them to the
	// removed node's parent. This changes only branch-manager metadata.
	for (const { path, node } of nodes as Array<{ path: string; node: CleanupNode }>) {
		if (!node.parentSessionId || !removedNodeIds.has(node.parentSessionId) || removedNodeIds.has(node.sessionId)) continue;
		const removedParent = (nodes as Array<{ path: string; node: CleanupNode }>).find(
			(item) => item.node.sessionId === node.parentSessionId,
		)?.node;
		try {
			const current = readJson<Record<string, unknown>>(path);
			if (!current) continue;
			const updated = { ...current, parentSessionId: removedParent?.parentSessionId };
			const temporary = `${path}.${process.pid}.cleanup.tmp`;
			writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
			renameSync(temporary, path);
		} catch {
			// Keep the child untouched if the metadata rewrite fails.
		}
	}

	const remainingNodeIds = new Set(
		files(nodesDir)
			.filter((path) => path.endsWith(".json"))
			.map((path) => readJson<CleanupNode>(path)?.sessionId)
			.filter((id): id is string => Boolean(id)),
	);

	for (const path of files(sidebarsDir).filter((file) => file.endsWith(".json"))) {
		const terminalId = readJson<{ terminalId?: string }>(path)?.terminalId;
		let alive = false;
		if (terminalId) {
			try {
				alive = await options.terminalExists(terminalId);
			} catch {
				alive = true;
			}
		}
		if (!alive && remove(path)) result.sidebars++;
	}

	for (const path of files(selectionsDir).filter((file) => file.endsWith(".json"))) {
		const rootId = basename(path, ".json");
		const selectedId = readJson<{ sessionId?: string }>(path)?.sessionId;
		if ((!remainingNodeIds.has(rootId) || !selectedId || !remainingNodeIds.has(selectedId)) && remove(path)) {
			result.selections++;
		}
	}

	for (const path of files(launchersDir)) {
		const id = launcherSessionId(path);
		const isSidebarLauncher = basename(path).startsWith("sidebar-");
		const sidebarRootId = isSidebarLauncher ? basename(path).slice("sidebar-".length, -".sh".length) : undefined;
		if ((id && !remainingNodeIds.has(id)) || (sidebarRootId && !existsSync(join(sidebarsDir, `${sidebarRootId}.json`)))) {
			if (remove(path)) result.launchers++;
		}
	}

	for (const [directory, key] of [
		[requestsDir, "requests"],
		[foldsDir, "folds"],
	] as const) {
		for (const childDirectory of files(directory)) {
			for (const path of files(childDirectory)) {
				const name = basename(path);
				if ((name.includes(".processing-") || name.endsWith(".tmp")) && isOlderThan(path, staleCutoff)) {
					if (remove(path)) result[name.endsWith(".tmp") ? "temporaryFiles" : key]++;
				}
			}
			try {
				if (readdirSync(childDirectory).length === 0) rmSync(childDirectory, { recursive: true, force: true });
			} catch {
				// Ignore races with active writers.
			}
		}
	}

	for (const directory of [options.stateDir, nodesDir, sidebarsDir, selectionsDir, launchersDir]) {
		for (const path of files(directory)) {
			if (basename(path).endsWith(".tmp") && isOlderThan(path, staleCutoff)) {
				if (remove(path)) result.temporaryFiles++;
			}
		}
	}

	return result;
}

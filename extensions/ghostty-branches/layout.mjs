/**
 * Split geometry helpers shared by the sidebar and Pi panes.
 *
 * Ghostty's AppleScript API reports no pane sizes, and `resize_split` moves the
 * nearest ancestor split on an axis by a number of points, not cells. A process
 * can only measure its own pane, so callers resize their own split and converge
 * on a target by watching their own column or row count.
 */

export const OPPOSITE_DIRECTION = Object.freeze({ left: "right", right: "left", up: "down", down: "up" });

/** The two `resize_split` directions that move a split on each axis. */
export const AXIS_DIRECTIONS = Object.freeze({ columns: ["left", "right"], rows: ["up", "down"] });

/**
 * Ghostty parses the resize amount as a UInt16 and clamps every split ratio to
 * 10–90%, so this always pushes a split to its limit without overshooting.
 */
export const MAX_RESIZE_POINTS = 65535;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Wait for Ghostty to apply a split change to this pane, then for the size to
 * settle. Returns the measured size, which is unchanged if nothing happened.
 *
 * @param {() => number} measure
 * @param {number} previous
 * @param {{ timeoutMs?: number, settleMs?: number, pollMs?: number }} [options]
 */
export async function waitForSizeChange(measure, previous, options = {}) {
	const pollMs = options.pollMs ?? 25;
	const settleMs = options.settleMs ?? 60;
	const deadline = Date.now() + (options.timeoutMs ?? 600);
	while (measure() === previous && Date.now() < deadline) await sleep(pollMs);
	let size = measure();
	while (Date.now() < deadline) {
		await sleep(settleMs);
		if (measure() === size) break;
		size = measure();
	}
	return measure();
}

/**
 * Find which `resize_split` direction shrinks this pane along an axis.
 *
 * Ghostty moves the nearest ancestor split on that axis, so whether `left`
 * shrinks or grows a pane depends on which side of that split it sits. Probe
 * with a small step and read the answer from the pane's own size. The second
 * direction is only tried when the first moved nothing, which happens when the
 * split is already at its 10% or 90% limit.
 *
 * @param {{
 *   axis: "columns" | "rows",
 *   measure: () => number,
 *   resize: (direction: string, points: number) => Promise<boolean>,
 *   wait: (previous: number) => Promise<number>,
 *   probePoints?: number,
 * }} options
 * @returns {Promise<{ direction: string, pointsPerCell: number } | undefined>}
 *   undefined when no split on this axis responds.
 */
export async function detectShrinkDirection({ axis, measure, resize, wait, probePoints = 32 }) {
	for (const direction of AXIS_DIRECTIONS[axis]) {
		const before = measure();
		if (!(await resize(direction, probePoints))) return undefined;
		const after = await wait(before);
		if (after === before) continue;
		return {
			direction: after < before ? direction : OPPOSITE_DIRECTION[direction],
			pointsPerCell: probePoints / Math.abs(after - before),
		};
	}
	return undefined;
}

/**
 * Find a split that shrinks this pane without moving a protected pane, such as
 * the branch sidebar, whose width only the user should change.
 *
 * Ghostty resizes the nearest ancestor split on an axis, which may be the
 * sidebar's own split. Each probe is checked against the protected pane's
 * reported size. A probe that moved it is undone and that axis is skipped.
 *
 * @param {{
 *   axes: Array<"columns" | "rows">,
 *   measure: (axis: "columns" | "rows") => number,
 *   resize: (direction: string, points: number) => Promise<boolean>,
 *   wait: (axis: "columns" | "rows", previous: number) => Promise<number>,
 *   protectedSize?: () => number | undefined,
 *   waitForProtected?: (previous: number) => Promise<number | undefined>,
 *   probePoints?: number,
 * }} options
 * @returns {Promise<{ axis: "columns" | "rows", direction: string, pointsPerCell: number, expandedSize: number } | undefined>}
 */
export async function findShrinkSplit({
	axes,
	measure,
	resize,
	wait,
	protectedSize = () => undefined,
	waitForProtected = async () => protectedSize(),
	probePoints,
}) {
	for (const axis of axes) {
		const measureAxis = () => measure(axis);
		const waitAxis = (previous) => wait(axis, previous);
		const expandedSize = measureAxis();
		const protectedBefore = protectedSize();
		const probe = await detectShrinkDirection({ axis, measure: measureAxis, resize, wait: waitAxis, probePoints });
		if (!probe) continue;
		if (protectedBefore !== undefined && (await waitForProtected(protectedBefore)) !== protectedBefore) {
			await convergeSize({
				target: expandedSize,
				growDirection: OPPOSITE_DIRECTION[probe.direction],
				measure: measureAxis,
				resize,
				wait: waitAxis,
				pointsPerCell: probe.pointsPerCell,
			});
			continue;
		}
		return { axis, ...probe, expandedSize };
	}
	return undefined;
}

/**
 * Move this pane's split until the pane measures `target` cells, refining the
 * points-per-cell estimate from each observed step. Returns the final size.
 *
 * @param {{
 *   target: number,
 *   growDirection: string,
 *   measure: () => number,
 *   resize: (direction: string, points: number) => Promise<boolean>,
 *   wait: (previous: number) => Promise<number>,
 *   pointsPerCell?: number,
 *   attempts?: number,
 *   shouldStop?: () => boolean,
 * }} options
 */
export async function convergeSize({
	target,
	growDirection,
	measure,
	resize,
	wait,
	pointsPerCell = 8,
	attempts = 4,
	shouldStop = () => false,
}) {
	let size = measure();
	let estimate = pointsPerCell;
	for (let attempt = 0; attempt < attempts && size !== target && !shouldStop(); attempt++) {
		const missing = target - size;
		const amount = Math.min(MAX_RESIZE_POINTS, Math.max(1, Math.round(Math.abs(missing) * estimate)));
		const direction = missing > 0 ? growDirection : OPPOSITE_DIRECTION[growDirection];
		if (!(await resize(direction, amount))) break;
		const next = await wait(size);
		if (next === size) break;
		estimate = amount / Math.abs(next - size);
		size = next;
	}
	return size;
}

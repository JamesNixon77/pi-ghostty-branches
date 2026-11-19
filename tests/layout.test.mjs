import assert from "node:assert/strict";
import test from "node:test";
import {
	convergeSize,
	detectShrinkDirection,
	findShrinkSplit,
	MAX_RESIZE_POINTS,
	OPPOSITE_DIRECTION,
} from "../extensions/ghostty-branches/layout.mjs";

/**
 * Model one Ghostty split the way SplitTree.resizing does: resize_split moves the
 * ratio by points / split width, clamped to 10–90%, and `left` shrinks the left
 * child. The pane measures itself in whole cells.
 */
function fakeSplit({ side, ratio = 0.5, widthPoints = 1600, cellPoints = 8, hasSplit = true }) {
	const split = { ratio, calls: [] };
	const measure = () => {
		const share = side === "left" ? split.ratio : 1 - split.ratio;
		return Math.floor((share * widthPoints) / cellPoints);
	};
	const resize = async (direction, points) => {
		split.calls.push([direction, points]);
		if (!hasSplit) return true;
		const delta = points / widthPoints;
		const next = direction === "left" ? split.ratio - delta : split.ratio + delta;
		split.ratio = Math.max(0.1, Math.min(0.9, next));
		return true;
	};
	const wait = async () => measure();
	return { split, measure, resize, wait };
}

test("a left child shrinks by moving its split left", async () => {
	const pane = fakeSplit({ side: "left" });
	const probe = await detectShrinkDirection({ axis: "columns", ...pane });
	assert.equal(probe.direction, "left");
	assert.equal(probe.pointsPerCell, 8);
});

test("a right child shrinks by moving its split right", async () => {
	const pane = fakeSplit({ side: "right" });
	const probe = await detectShrinkDirection({ axis: "columns", ...pane });
	assert.equal(probe.direction, "right");
	assert.equal(probe.pointsPerCell, 8);
});

test("a split already at its limit is probed from the other side", async () => {
	const pane = fakeSplit({ side: "left", ratio: 0.1 });
	const probe = await detectShrinkDirection({ axis: "columns", ...pane });
	assert.equal(probe.direction, "left");
	assert.deepEqual(
		pane.split.calls.map(([direction]) => direction),
		["left", "right"],
	);
});

test("no split on the axis reports nothing to shrink", async () => {
	const pane = fakeSplit({ side: "left", hasSplit: false });
	assert.equal(await detectShrinkDirection({ axis: "rows", ...pane }), undefined);
	assert.deepEqual(
		pane.split.calls.map(([direction]) => direction),
		["up", "down"],
	);
});

test("a missing terminal stops probing", async () => {
	const pane = fakeSplit({ side: "left" });
	const probe = await detectShrinkDirection({ axis: "columns", ...pane, resize: async () => false });
	assert.equal(probe, undefined);
});

test("minimizing and expanding restores the original size", async () => {
	for (const side of ["left", "right"]) {
		const pane = fakeSplit({ side, ratio: 0.62, cellPoints: 7.5 });
		const expanded = pane.measure();
		const probe = await detectShrinkDirection({ axis: "columns", ...pane });
		await pane.resize(probe.direction, MAX_RESIZE_POINTS);
		const collapsed = pane.measure();
		assert.equal(collapsed, Math.floor((0.1 * 1600) / 7.5), `${side} pane stops at 10% of its split`);

		const restored = await convergeSize({
			target: expanded,
			growDirection: OPPOSITE_DIRECTION[probe.direction],
			pointsPerCell: probe.pointsPerCell,
			...pane,
		});
		assert.equal(restored, expanded, `${side} pane returns to its size`);
	}
});

test("convergeSize gives up when the split stops moving", async () => {
	const pane = fakeSplit({ side: "left", ratio: 0.9 });
	const size = await convergeSize({ target: 1000, growDirection: "right", ...pane });
	assert.equal(size, pane.measure());
	assert.equal(pane.split.calls.length, 1);
});

/**
 * A pane at the top of `[sidebar | [pane / below]]`: its nearest split on the
 * columns axis is the sidebar's own split, and on the rows axis the split with
 * the pane below.
 */
function paneBesideSidebar() {
	const sidebarSplit = fakeSplit({ side: "right", ratio: 0.15 });
	const rowSplit = fakeSplit({ side: "left", ratio: 0.5, widthPoints: 900, cellPoints: 18 });
	const sidebarColumns = () => Math.floor((sidebarSplit.split.ratio * 1600) / 8);
	const calls = [];
	return {
		sidebarSplit,
		rowSplit,
		calls,
		sidebarColumns,
		options: {
			axes: ["columns", "rows"],
			measure: (axis) => (axis === "columns" ? sidebarSplit.measure() : rowSplit.measure()),
			resize: async (direction, points) => {
				calls.push(direction);
				if (direction === "left" || direction === "right") return sidebarSplit.resize(direction, points);
				// fakeSplit models a left/right split; up shrinks the top child like left.
				return rowSplit.resize(direction === "up" ? "left" : "right", points);
			},
			wait: async (axis) => (axis === "columns" ? sidebarSplit.measure() : rowSplit.measure()),
			protectedSize: sidebarColumns,
		},
	};
}

test("minimize skips the sidebar's split and restores the sidebar width", async () => {
	const pane = paneBesideSidebar();
	const sidebarBefore = pane.sidebarColumns();
	const probe = await findShrinkSplit(pane.options);
	assert.equal(probe.axis, "rows");
	assert.equal(probe.direction, "up");
	assert.equal(pane.sidebarColumns(), sidebarBefore, "the sidebar keeps its width");
	await pane.options.resize(probe.direction, MAX_RESIZE_POINTS);
	assert.equal(pane.sidebarColumns(), sidebarBefore, "collapsing moves only the row split");
	assert.equal(pane.rowSplit.split.ratio, 0.1);
});

test("minimize reports nothing to shrink when only the sidebar's split responds", async () => {
	const pane = paneBesideSidebar();
	const sidebarBefore = pane.sidebarColumns();
	const probe = await findShrinkSplit({ ...pane.options, axes: ["columns"] });
	assert.equal(probe, undefined);
	assert.equal(pane.sidebarColumns(), sidebarBefore);
});

test("without a sidebar the nearest split on the first axis is used", async () => {
	const pane = paneBesideSidebar();
	const probe = await findShrinkSplit({ ...pane.options, protectedSize: () => undefined });
	assert.equal(probe.axis, "columns");
	assert.equal(probe.direction, "right");
});

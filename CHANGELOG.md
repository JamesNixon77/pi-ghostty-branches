# Changelog

## Unreleased

- Add `/push [instructions]` and the sidebar `p Pull` action, which send a child's new findings to its parent without closing the child. Pushes can run mid-turn and share the fold cursor, so each delivery covers only new work.
- Identify each Pi pane by briefly setting a unique title, instead of assuming the focused pane is Pi's own. `/branch` no longer opens next to another session when Pi started or resumed while a different tab had focus.
- Drop a recorded pane ID once that pane is gone, so splits rebind instead of failing with "terminal not found".
- Make `= Equal` share space among the Pi panes only. The sidebar now keeps its width instead of widening to an equal share.

## 0.2.2

- Stop forwarding Pi's installation-specific `PI_PACKAGE_DIR` into new Ghostty panes.
- Keep branching and resuming working from parent panes that remain open across a Pi upgrade.

## 0.2.1

- Remove the pseudo-sticky top title overlays that moved with Ghostty native scrollback.
- Add a persistent bordered branch-status panel beside Pi's bottom editor/footer area.
- Show the current branch name, access mode, branch count, and sidebar-selection highlight in that panel.

## 0.2.0

- Make `/branch`, sidebar `b Branch`, and `Ctrl+Shift+B` create writable branches by default.
- Add `/branch-ro` and `/branch-read` for explicit read-only branches.
- Keep `/branch-write` as a backward-compatible alias.
- Document concurrency failure modes and a phased guarding design.

## 0.1.5

- Add `/branch-close` to close a branch without folding context into its parent.
- Preserve the closed branch's Pi session for later Resume.

## 0.1.4

- Render pane title bars as fixed, non-capturing overlays instead of scrollable transcript headers.
- Keep sidebar-driven selected-pane highlighting visible while conversations scroll.

## 0.1.3

- Wrap sidebar action buttons and footer help across rows instead of truncating content in narrow sidebars.
- Document horizontal Ghostty padding around native split dividers.
- Keep a branch open and avoid sending a parent message when there is nothing new to fold.

## 0.1.2

- Render full-width, theme-aware title banners and horizontal separators in managed Pi panes.
- Strengthen selected-pane highlighting while retaining the header hide shortcut.
- Document Ghostty's native `split-divider-color` option.

## 0.1.1

- Add `/branches cleanup` and the sidebar `d Cleanup` action.
- Remove stale coordination metadata and generated artifacts without deleting saved Pi sessions.
- Add cleanup safety tests.

## 0.1.0

- Initial Ghostty-native parallel Pi session branching.
- Add branch and root-session creation, fold handoff, hide/restore, close/resume, rename, sidebar navigation, pane titles, and layout controls.

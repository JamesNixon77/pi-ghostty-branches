# Changelog

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

# Ghostty Branches for Pi

A Ghostty-native session branch manager for [Pi](https://github.com/earendil-works/pi). It creates parallel Pi sessions in native Ghostty splits, presents them as a clickable tree, and folds child findings back into parent sessions.

## Install

```bash
pi install git:github.com/JamesNixon77/pi-ghostty-branches
```

Restart Pi or run `/reload`. Ghostty and macOS are currently required.

For local development:

```bash
pi install /absolute/path/to/pi-ghostty-branches
```

## Usage

Run Pi inside Ghostty, then:

- `/branches` opens or focuses the native Ghostty sidebar.
- `/branch [goal]` creates a read-only child in a split to the right. If a goal is supplied, the child starts working immediately.
- `/branch-write [goal]` creates a writable child in the same working directory. This is unsafe when multiple agents edit concurrently.
- `/fold [instructions]` summarizes a child branch's new findings into its immediate parent.
- `Ctrl+Shift+B` creates a read-only child while the current agent continues running.

The sidebar supports mouse clicks and these controls:

- Click `n New Root` or press `n` to confirm creation of an independent writable top-level Pi session. It inherits the current model configuration but no conversation context, and appears as another root in the same sidebar forest.
- Click a branch to select it without moving keyboard focus out of the sidebar. The selected Pi pane's title is highlighted. Press Enter to focus the selected live pane, or to confirm restoring an inactive one.
- Click `+ Branch` or press `b` to open an explicit confirmation before branching the selected session.
- Click `Fold` or press `f` to confirm folding the selected child into its parent. A successful fold closes the child pane.
- Click `Rename` or press `r` to edit the selected session's display name and pane title.
- Click `c Close` or press `c` to confirm a graceful pane close; the saved Pi session remains resumable and Ghostty automatically removes the exited surface.
- Closed branches expose `o Resume`, `x Remove`, and `r Rename`. Resume opens the saved Pi session in a new pane. Remove hides the branch from this GUI while retaining its Pi session file.
- Click `h Hide`, press `h` in the sidebar, or press `Ctrl+Shift+H` inside a child Pi pane to hide it. This gracefully pauses the Pi session and removes its Ghostty surface while retaining the session; selecting it later exposes `o Restore`.
- Advanced resize/zoom controls are hidden by default. Click `l Layout` or press `l` to reveal them. `H Left`/`L Right` move a vertical divider to change width; `K Up`/`J Down` move a horizontal divider to change height; `= Equal` redistributes split space; `z Zoom` temporarily expands one pane.
- Use `- Side` and `+ Side`, or the `-`/`+` keys, to resize the sidebar itself.
- Every clickable action includes its keyboard equivalent in the button label.
- Press `Ctrl+Shift+S` from any Pi pane to return focus to the existing sidebar.
- Click `=` to equalize splits.
- Click `Zoom` or press `z` to toggle split zoom.
- Left/right arrows fold and unfold tree nodes.
- `q` closes the sidebar.

Ghostty cannot detach a live TUI process from a split, so Hide behaves as session hibernation: the Pi process stops and the pane disappears, then Restore opens that same saved session in a new pane. It does not continue running while hidden. Hide and Close preserve the same Pi session data; the difference is intent and sidebar state: hidden branches are presented as temporarily restorable, while closed branches are presented as completed and removable.

Child pane headers include `[× hide: Ctrl+Shift+H]`. Stock Pi does not expose mouse hit-testing for header components, so this top control is currently a visible shortcut rather than a plain-click button; the sidebar's `h Hide` remains clickable.

Each Pi pane gets a one-line branch title at the top as well as a Ghostty surface title. Ghostty/macOS may request Automation permission the first time Pi controls Ghostty.

## Safety and current limitations

- Sidebar-created branches and `/branch` are read-only (`read`, `grep`, `find`, `ls`) by default.
- `/branch-write` shares the parent's working directory. A future workspace adapter should create an isolated worktree before writable branches are considered safe.
- An unfinished assistant message is not copied. If a tool batch is active, the snapshot rolls back to the last context point without unmatched tool calls.
- Fold delivery uses files under `~/.pi/agent/ghostty-branches/`, so it survives a temporarily closed parent session.
- The sidebar is a dedicated native Ghostty split because it can own mouse reporting without interfering with Pi's transcript selection and scrolling.

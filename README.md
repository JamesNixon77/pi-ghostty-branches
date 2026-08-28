# Pi Ghostty Branches

A macOS/Ghostty extension for [Pi](https://github.com/earendil-works/pi) that runs parallel conversation branches in native Ghostty splits, presents sessions in a clickable tree sidebar, and folds child findings back into parent sessions.

## Requirements

- macOS
- [Ghostty](https://ghostty.org/) 1.3.1 or newer
- Pi 0.84 or newer
- Node.js 22 or newer (normally supplied by Pi)

The extension intentionally targets Ghostty on macOS. It is not a tmux integration and currently has no compatibility layer for other terminals.

## Install

```bash
pi install git:github.com/JamesNixon77/pi-ghostty-branches
```

Restart Pi or run `/reload` in every already-running Pi pane. Each pane is a separate process, so reloading one pane does not reload the others.

If Shopify's experimental third-party package gate is enabled, explicitly allow the install for that invocation:

```bash
SHOPIFY_PI_ALLOW_3P=1 pi install git:github.com/JamesNixon77/pi-ghostty-branches
```

On first use, macOS may ask whether the process running Pi can automate Ghostty. Approve that request so the extension can create, focus, resize, and close native splits.

### Upgrade

```bash
pi update git:github.com/JamesNixon77/pi-ghostty-branches
```

Then restart Pi or run `/reload` in existing panes.

### Uninstall

```bash
pi remove git:github.com/JamesNixon77/pi-ghostty-branches
```

The command removes the package registration. Runtime/session metadata under `~/.pi/agent/ghostty-branches/` is intentionally retained unless you remove it separately.

## Quick start

Start Pi inside Ghostty and run:

```text
/branches
```

This creates a narrow native Ghostty split containing the branch sidebar. Click a row to select it without transferring keyboard focus; press Enter to focus the selected live Pi pane. From a Pi pane, press `Ctrl+Shift+S` to return to the existing sidebar.

The ordinary workflow is:

1. Select a session in the sidebar.
2. Click `b Branch` to create a read-only child, or use `/branch [goal]` from a Pi pane.
3. Let parent and child sessions run independently.
4. Click `f Fold` or run `/fold [instructions]` in the child.
5. The child summarizes new findings into its parent and closes its Ghostty pane.

## Pi commands and shortcuts

| Command or shortcut | Effect |
| --- | --- |
| `/branches` | Open or focus the branch sidebar |
| `/branches cleanup` | Confirm removal of stale runtime coordination data without deleting Pi sessions |
| `/branch [goal]` | Create a read-only child; a supplied goal starts immediately |
| `/branch-write [goal]` | Create a writable child in the same working directory |
| `/fold [instructions]` | Fold this child branch's new findings into its immediate parent |
| `Ctrl+Shift+B` | Create a read-only child while the current agent continues running |
| `Ctrl+Shift+S` | Return focus to the branch sidebar |
| `Ctrl+Shift+H` | Hide the current child/additional-root pane |

## Sidebar controls

Every clickable action shows its keyboard equivalent.

### Session actions

| Control | Effect |
| --- | --- |
| `n New Root` | Create an independent writable top-level session with no inherited conversation |
| `d Cleanup` | Confirm cleanup of stale metadata, generated launchers, and abandoned temporary claims |
| `b Branch` | Confirm creation of a read-only child from the selected session |
| `f Fold` | Confirm folding a child into its parent; success closes the child pane |
| `r Rename` | Rename the Pi session, sidebar row, and pane title |
| `Enter / Focus` | Focus a live selected pane; offer Resume/Restore for an inactive pane |
| `h Hide` | Hibernate the selected child or additional root session and remove its pane |
| `c Close` | Close the selected pane while retaining its saved Pi session |
| `o Resume` | Reopen a closed saved session in a new pane |
| `o Restore` | Reopen a hidden saved session in a new pane |
| `x Remove` | Remove an inactive entry from this sidebar without deleting its Pi session file |
| `q` | Close the sidebar itself |

A tree-row click only selects and highlights. It does not transfer keyboard focus or immediately open a confirmation. Left/right arrow keys collapse and expand tree nodes.

### Sidebar and advanced layout

Use `- Side` and `+ Side`, or the `-`/`+` keys, to resize the sidebar.

Advanced pane layout controls are hidden by default. Click `l Layout` or press `l` to reveal them:

| Control | Effect |
| --- | --- |
| `H Left` / `L Right` | Move a vertical split boundary to change width |
| `K Up` / `J Down` | Move a horizontal split boundary to change height |
| `= Equal` | Ask Ghostty to distribute split space equally |
| `z Zoom` | Toggle Ghostty zoom for the selected pane |

A direction with no adjacent boundary has no effect. `/branches` detects an existing sidebar by terminal ID and title and will not intentionally create a second sidebar merely because another pane is zoomed.

## Visual separation

Managed Pi panes render a fixed, full-width, theme-aware title banner followed by a horizontal separator. The banner is a non-capturing screen overlay, so it remains visible while the conversation scrolls and does not take keyboard focus. The pane selected in the sidebar uses Pi's accent background and border color; other panes use muted styling.

For a more pronounced native line between every Ghostty split, add a divider color to your Ghostty config:

```ini
split-divider-color = #7aa2f7
window-padding-x = 6
```

`#7aa2f7` is TokyoNight's primary blue. More subdued alternatives are `#565f89` and `#414868`. `window-padding-x` adds breathing room between terminal text and vertical split dividers; it applies to every Ghostty surface. Validate and reload the terminal configuration:

```bash
ghostty +validate-config
```

Then press Ghostty's default `Cmd+Shift+,` shortcut, or use its Reload Configuration action. Ghostty supports divider color but does not currently expose native divider thickness.

## Branch semantics

### Branching while an agent is working

Extension commands and shortcuts execute immediately while Pi is streaming. The original process is not replaced or aborted when a child is created.

Pi only persists finalized messages. A snapshot therefore includes the active user request but not an unfinished assistant response. If a tool batch is active, the extension rolls the child snapshot back to the last protocol-safe point without unmatched tool calls.

### Folding

A fold summarizes only entries created after the fork point (or after the previous fold cursor). The summary includes decisions, evidence, relevant files, commands/tests, changes, risks, and next steps. It is delivered to the parent as a Pi custom context message.

Fold packets are stored durably, so a temporarily unavailable parent can consume them when it runs again. A successful fold closes the child pane but does not delete the child session file.

### Hide versus close

Ghostty cannot detach a live terminal TUI from a split. Hide is therefore session hibernation, not background execution:

- **Hide** stops Pi, removes the pane, and presents the entry as temporarily restorable.
- **Close** stops Pi, removes the pane, and presents the entry as completed/resumable/removable.

Both preserve the same Pi session data. Restore/Resume starts a new Pi process using that saved session.

Child and additional-root headers display `[× hide: Ctrl+Shift+H]`. Stock Pi does not expose mouse hit-testing for header components, so the header X is currently a visible shortcut rather than a plain-click button. The sidebar's `h Hide` control is clickable.

## Concurrency and safety

Read-only children are the default and receive only `read`, `grep`, `find`, and `ls`.

`/branch-write` and `n New Root` use the same working directory as their coordinator. Multiple writable agents can overwrite each other's changes or run conflicting commands. Use writable sessions cautiously until isolated-worktree support exists.

Provider credentials and the invoking Pi environment are inherited by child Ghostty surfaces, while parent-specific session and terminal variables are excluded.

## Runtime state

Runtime data is stored outside the package under:

```text
$PI_CODING_AGENT_DIR/ghostty-branches/
```

or, by default:

```text
~/.pi/agent/ghostty-branches/
```

It contains branch graph records, request/fold inboxes, sidebar selection, and generated launchers. Session conversations remain in Pi's normal session directory. Runtime data and credentials are not committed to this repository.

Run cleanup from Pi or the sidebar:

```text
/branches cleanup
```

or click `d Cleanup`. Cleanup removes only reconstructable or orphaned coordination data: metadata whose process, Ghostty terminal, and saved session are all gone; stale sidebar/selection records; orphaned generated launchers; and abandoned temporary/processing files older than one hour. It never deletes Pi session JSONL files. Closed or hidden branches with an existing session file remain available for Resume/Restore.

## Troubleshooting

### A child says no API key was found

Reload the coordinator so it uses the current extension, then create a new child. The extension passes the parent process environment into Ghostty-created Pi surfaces while excluding stale session metadata.

### A live resumed pane appears closed

Run `/reload` once in that pane. Running panes publish their PID/status heartbeat; the sidebar treats a provisional PID as starting rather than dead.

### `/branches` appears to create another sidebar

Close obsolete sidebar processes with `q`, reload the Pi pane, and run `/branches` once. Current versions recover the existing sidebar by stable Ghostty terminal ID or its surface title, including after zoom.

### Panes visually scroll during split changes

In Pi's regular TUI mode, changing native split geometry causes Ghostty to rewrap scrollback and Pi to redraw at the new width. This is visual reflow, not session navigation or lost history.

### Changes do not appear in an existing pane

Every pane is a separate Pi process. Run `/reload` in each existing pane that needs the new extension version. Newly created and resumed panes load it automatically.

## Development and source control

The canonical repository is:

```text
https://github.com/JamesNixon77/pi-ghostty-branches
```

Clone it and install the checkout while developing:

```bash
git clone https://github.com/JamesNixon77/pi-ghostty-branches.git
pi install /absolute/path/to/pi-ghostty-branches
```

Run checks before committing:

```bash
node --check extensions/ghostty-branches/sidebar.mjs
node --test tests/*.test.mjs
```

Smoke-load the complete package through Pi after changing package layout or Pi APIs:

```bash
PI_CODING_AGENT_DIR="$(mktemp -d)" \
  pi --no-extensions -e "$PWD" --mode json --no-session </dev/null
```

All future functional changes should be made in this repository, tested, committed, and pushed. Do not edit the installed package copy under `~/.pi/agent/git/`. For this development machine, `~/.pi/agent/extensions/branch-window.ts` is only a shim pointing at the checkout.

## License

MIT

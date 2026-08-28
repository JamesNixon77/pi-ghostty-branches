# Repository instructions

This repository is the canonical source for the Pi Ghostty Branches extension.

- Make all extension changes here, never directly in `~/.pi/agent/extensions/`.
- The local file `~/.pi/agent/extensions/branch-window.ts` is only a development shim that re-exports this checkout.
- Keep runtime state out of git. It belongs under `$PI_CODING_AGENT_DIR/ghostty-branches/`.
- Before committing, run `node --check extensions/ghostty-branches/sidebar.mjs` and `node --test tests/*.test.mjs`.
- Also smoke-load the package through Pi when extension APIs or package layout change.
- Commit and push every functional change to `main`; bump `package.json` and add release notes when publishing a user-facing version.
- Writable branches are the product default. Preserve `/branch-ro` and `/branch-read`, keep shared-workspace warnings explicit, and never claim concurrency safety without isolated workspaces.

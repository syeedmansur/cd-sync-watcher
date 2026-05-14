# CD Sync Watcher

macOS menu bar app + CLI for the Claude Design ↔ Claude Code sync pipeline.

## What it does

- Watches `~/Downloads` for Claude Design zip exports
- Auto-converts CD's window-global components to ES modules
- Detects protected files, layout drift, and new exports
- Logs activity to Supabase for team visibility
- Menu bar app shows watcher status, recent activity, and team activity

## Install

Download the latest `.pkg` from Releases and double-click to install.

First time: right-click → Open (unsigned package).

## Build from source

```bash
# Build .pkg installer
bash installer/build-pkg.sh

# Output: ~/Downloads/CDSyncWatcher-<version>.pkg
```

## CLI Usage

```bash
node src/cd-sync.js pull <zip-or-dir>   # Import from CD → repo
node src/cd-sync.js push                # Export repo → cd-changeset/
node src/cd-sync.js push --changed      # Only changed files
node src/cd-sync.js deploy              # Deploy to Vercel production
node src/cd-sync.js watch               # Start watcher daemon
node src/cd-sync.js status              # Show watcher status
```

## Versioning

- **Z (patch)**: Script-only changes (bug fixes, detection patterns)
- **Y (minor)**: Memory/protocol updates (SYNC-GUIDE, workflow steps)
- **X (major)**: Both scripts AND memory/protocol changed

```bash
node src/version-bump.js patch "Fixed asset extraction"
node src/version-bump.js minor "Updated sync guide"
node src/version-bump.js major "New protected files + updated protocol"
```

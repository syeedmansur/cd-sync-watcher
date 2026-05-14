# CD ↔ CC Sync Guide

How Claude Design (CD) and Claude Code (CC) stay in sync for PMPro.

## Architecture

CD owns the **UI prototype** (window-global JSX + inline styles). CC owns the **production app** (Vite + ES modules + Supabase backend). They share component code but use different module systems.

```
CD (Claude Design)              CC (Claude Code)
index.html + components/   ──>  frontend/src/ (ES modules)
window globals                   import/export
assets/                          frontend/public/images/
mock data                        Supabase Auth + REST
```

## Key Files

| File | Purpose |
|---|---|
| `tools/cd-sync.js` | Unified CLI: pull, push, deploy, watch, status |
| `tools/cd-pull.js` | CD→CC converter: window globals → ES modules |
| `tools/cd-push.js` | CC→CD exporter: ES modules → window globals |
| `tools/component-map.json` | Bidirectional map: CD filenames ↔ repo paths, exports, dependencies |
| `cd-changeset/` | CC→CD staging area (gitignored) |
| `.cd-sync-status.json` | Watcher state (gitignored) |

## Workflow

### CD → CC (most common)

1. Download zip from CD (or watcher detects it in ~/Downloads)
2. `node tools/cd-sync.js pull <zip>` — converts, extracts assets, build-verifies
3. Say **"CD sync landed"** in Claude Code for structured review
4. Claude Code: reviews diff, identifies decisions/tasks, commits what's ready
5. `git push` then `node tools/cd-sync.js deploy` (or Claude Code does both)

### CC → CD

1. `node tools/cd-sync.js push` — exports repo → `cd-changeset/`
2. Link `cd-changeset/` folder in CD to read changes

## Critical Gotchas

### 1. Protected Files

Some files have been wired to backend services (Supabase Auth, SDK). CD doesn't know about this wiring and will revert them to mock versions on every export.

**Protected files are marked in `component-map.json`** with `"protected": true`. When cd-pull encounters these, it saves CD's version as `<filename>.cd-incoming` instead of overwriting, and prints a merge warning.

Current protected files:
- `SupabaseClient.js` — CC uses `@supabase/supabase-js` SDK; CD has lightweight REST mock
- `LoginPage.jsx` — CC has `signIn()` import + async auth; CD has `setTimeout()` mock

**Merge strategy:** Diff the `.cd-incoming` file against the repo version. Keep all backend wiring (imports, async functions, SDK calls). Adopt UI-only changes from CD (styles, layout, new fields). Delete the `.cd-incoming` file when done.

### 2. Asset Path Mapping

CD references images as `assets/login-bg.jpeg`. In the Vite app, static assets live in `frontend/public/images/` and are served at `/images/login-bg.jpeg`.

cd-pull copies `assets/` → `frontend/public/images/` automatically. But image `src` attributes in JSX need the `/images/` prefix, not `assets/`.

**Why not `public/assets/`?** Vite's build (`emptyOutDir: true`) wipes the entire `public/` directory. `frontend/public/` is the Vite static source — its contents get copied into `public/` during build without being deleted.

### 3. Layout Drift (index.html vs main.jsx)

CD's `index.html` defines the Mission Control section layout (titles, eyebrows, order). CC's `main.jsx` is the actual entry point. cd-pull does NOT import `index.html` — it prints a layout drift report when the two differ.

**Action:** When cd-pull reports layout drift, manually update the string values in `main.jsx` to match CD's `index.html`. These are title/eyebrow string changes, not structural refactors.

### 4. New Exports

When CD adds a new function/component to an existing file, the `exports` array in `component-map.json` must be updated to include it. Otherwise cd-pull won't add the `export` keyword and the build will fail with missing exports.

### 5. Vercel Deployment

Vercel's Git integration is NOT connected. Pushes to GitHub do NOT trigger auto-deploys. Always run `node tools/cd-sync.js deploy` after pushing, or the live site at pmpro.greenlyne.io goes stale.

## Component Map Format

```json
{
  "ComponentFile.jsx": {
    "cdPath": "components/ComponentFile.jsx",
    "repoPath": "frontend/src/section/ComponentFile.jsx",
    "exports": ["ComponentA", "ComponentB"],
    "dependsOn": {
      "OtherFile.jsx": ["ImportedThing"]
    },
    "protected": true,
    "protectedReason": "Why this file can't be auto-overwritten"
  }
}
```

## For AI Assistants (Claude Code)

When the user says **"CD sync landed"** or similar, follow the protocol in memory (`feedback_cd_sync_landed_protocol.md`). Key steps:

1. Run `git diff` to see changes from cd-pull
2. Check for `.cd-incoming` files — these need manual merge (keep backend wiring, adopt UI changes)
3. Check cd-pull output for layout drift warnings — update `main.jsx` strings to match
4. Check for new unmapped files — update `component-map.json`
5. Restore `SupabaseClient.js` if CD overwrote it (`git checkout -- frontend/src/services/SupabaseClient.js`)
6. Re-apply Supabase Auth wiring to any protected files CD reverted
7. Build verify, commit, push, deploy

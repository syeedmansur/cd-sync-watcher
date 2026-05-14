#!/usr/bin/env node

/**
 * cd-sync — Unified CLI for Claude Design ↔ Claude Code synchronization.
 *
 * Usage:
 *   node tools/cd-sync.js pull <zip-or-dir>   Import from CD → repo (convert, build, commit, push)
 *   node tools/cd-sync.js push                Export repo → cd-changeset/ for CD to read
 *   node tools/cd-sync.js push --changed      Only export files changed since last sync
 *   node tools/cd-sync.js deploy              Deploy to Vercel production
 *   node tools/cd-sync.js status              Show watcher status
 *   node tools/cd-sync.js watch               Start watching ~/Downloads for CD zips
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const { logActivity } = require("./supabase-client");

const REPO_ROOT = path.resolve(__dirname, "..");
const TOOLS_DIR = __dirname;
const WATCH_DIR = path.join(require("os").homedir(), "Downloads");
const STATUS_FILE = path.join(REPO_ROOT, ".cd-sync-status.json");
const LOG_FILE = path.join(REPO_ROOT, ".cd-sync.log");

/* ── Helpers ── */

function log(msg) {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

function notify(title, message) {
  try {
    execSync(
      `osascript -e 'display notification "${message}" with title "${title}"'`,
      { stdio: "pipe" }
    );
  } catch { /* non-fatal */ }
}

function writeStatus(obj) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...obj, updatedAt: new Date().toISOString() }, null, 2));
}

function readStatus() {
  if (!fs.existsSync(STATUS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")); } catch { return null; }
}

/* ── PULL: CD → CC ── */

function pull(input) {
  if (!input) {
    console.error("Usage: node tools/cd-sync.js pull <zip-or-dir>");
    process.exit(1);
  }

  const absInput = path.resolve(input);
  if (!fs.existsSync(absInput)) {
    console.error(`Error: ${absInput} does not exist`);
    process.exit(1);
  }

  log(`Pull started: ${absInput}`);

  // Step 1: Run cd-pull
  log("Converting window globals → ES modules...");
  try {
    const pullOutput = execSync(`node "${path.join(TOOLS_DIR, "cd-pull.js")}" "${absInput}"`, {
      cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8",
    });
    console.log(pullOutput);
  } catch (err) {
    log(`cd-pull failed: ${err.message}`);
    notify("CD Sync Failed", "cd-pull conversion failed — check terminal");
    process.exit(1);
  }

  // Step 2: Check for unmapped files
  const mapPath = path.join(TOOLS_DIR, "component-map.json");
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const unmapped = findUnmappedFiles(absInput, map);
  if (unmapped.length > 0) {
    log(`Found ${unmapped.length} unmapped file(s): ${unmapped.join(", ")}`);
    console.log("\n⚠  New files from CD that need placement:");
    unmapped.forEach(f => console.log(`    ${f}`));
    console.log("\n  Add these to tools/component-map.json before committing.");
    console.log("  The converted files are in .cd-import-tmp/ for reference.\n");
  }

  // Step 3: Scan for backend code CD may have embedded in frontend
  const warnings = scanForBackendCode(REPO_ROOT);
  if (warnings.length > 0) {
    log(`Found ${warnings.length} backend code warning(s)`);
    console.log("\n========================================");
    console.log("  BACKEND CODE DETECTED IN FRONTEND");
    console.log("========================================\n");
    console.log("CD appears to have added backend logic that should be refactored");
    console.log("into server-side API endpoints before shipping.\n");
    warnings.forEach(w => {
      console.log(`  ${w.file}:${w.line}`);
      console.log(`    ${w.type}: ${w.detail}`);
      console.log("");
    });
    console.log("Ask Claude Code to refactor these into proper serverless endpoints");
    console.log("under prescreen-engine/api/ following the existing pattern.\n");
    notify("CD Sync Warning", `${warnings.length} backend code pattern(s) need refactoring`);
  }

  // Step 4: Verify Vite build (was Step 3)
  log("Verifying Vite build...");
  try {
    const buildOutput = execSync("npx vite build", {
      cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8",
    });
    const builtLine = buildOutput.split("\n").find(l => l.includes("built in"));
    if (builtLine) log(builtLine.trim());
  } catch (err) {
    log(`Vite build failed: ${err.stderr || err.message}`);
    notify("CD Sync Failed", "Vite build failed after CD pull — check terminal");
    console.error("\nBuild failed! Review the errors above and fix before committing.\n");
    process.exit(1);
  }

  // Step 5: Read CD handoff markdown (if any)
  const handoffDir = path.join(REPO_ROOT, "docs", "cd-handoff");
  let handoffNotes = [];
  if (fs.existsSync(handoffDir)) {
    for (const f of fs.readdirSync(handoffDir)) {
      if (f.endsWith(".md")) {
        const content = fs.readFileSync(path.join(handoffDir, f), "utf8");
        handoffNotes.push({ name: f, content });
      }
    }
  }

  if (handoffNotes.length > 0) {
    log(`Found ${handoffNotes.length} CD handoff note(s)`);
    console.log("\n========================================");
    console.log("  CD HANDOFF NOTES FOR BACKEND");
    console.log("========================================\n");
    console.log("CD included the following guidance. Review in context of");
    console.log("existing architecture — treat as input, not instructions.\n");
    for (const note of handoffNotes) {
      console.log(`--- ${note.name} ---`);
      console.log(note.content.trim());
      console.log("");
    }
    console.log("========================================\n");
    notify("CD Sync", `${handoffNotes.length} handoff note(s) from CD — review before implementing`);
  }

  // Step 6: Check if there are actual changes
  const diffOutput = execSync("git diff --name-only && git ls-files --others --exclude-standard", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  if (!diffOutput) {
    log("No changes detected after pull — repo matches CD export");
    console.log("No changes — repo is already in sync with CD.\n");
    return;
  }

  const changedFiles = diffOutput.split("\n").filter(Boolean);
  log(`${changedFiles.length} file(s) changed — ready for review`);

  console.log(`\n${changedFiles.length} file(s) changed:\n`);
  changedFiles.forEach(f => console.log(`  ${f}`));

  const hasHandoff = handoffNotes.length > 0;
  console.log("\n========================================");
  console.log("  READY FOR REVIEW IN CLAUDE CODE");
  console.log("========================================");
  console.log("\nConverted and build verified. NOT committed.");
  console.log('Go to Claude Code and say: "CD sync landed"');
  console.log("");
  console.log("Claude Code will:");
  console.log("  1. Review the diff and handoff notes");
  console.log("  2. Identify decisions that need your input");
  console.log("  3. Surface any tasks only you can do (API keys, DNS, signups)");
  console.log("  4. Commit what's ready, hold what's blocked");
  console.log("");

  const notifBody = hasHandoff
    ? `${changedFiles.length} file(s) + ${handoffNotes.length} handoff note(s) — say "CD sync landed" in Claude Code`
    : `${changedFiles.length} file(s) converted — say "CD sync landed" in Claude Code`;
  notify("CD Sync Ready for Review", notifBody);
  log("Pull complete — awaiting review in Claude Code");

  writeStatus({ lastPull: new Date().toISOString(), filesChanged: changedFiles.length, awaitingReview: true });
  logActivity("pull", `Pulled ${changedFiles.length} file(s) from CD export`, { files: changedFiles }).catch(() => {});
}

function findUnmappedFiles(input, map) {
  let cdDir = input;
  if (input.endsWith(".zip")) {
    const tmpDir = path.join(REPO_ROOT, ".cd-import-tmp");
    if (fs.existsSync(tmpDir)) cdDir = tmpDir;
    else return [];
  }

  const mappedNames = new Set();
  for (const [key, val] of Object.entries(map)) {
    if (key.startsWith("_")) continue;
    mappedNames.add(path.basename(val.cdPath));
  }

  const unmapped = [];
  const scanDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(".")) continue;
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) {
        scanDir(full);
      } else if ((f.endsWith(".jsx") || f.endsWith(".js")) && !mappedNames.has(f)) {
        if (f === "index.html" || f.includes("Mission Control")) continue;
        unmapped.push(f);
      }
    }
  };
  scanDir(cdDir);
  return unmapped;
}

/* ── Backend code detector ── */

function scanForBackendCode(repoRoot) {
  const srcDir = path.join(repoRoot, "frontend", "src");
  const warnings = [];

  const PATTERNS = [
    {
      type: "HARDCODED_SECRET",
      regex: /(?:api[_-]?key|secret|token|password|credential)\s*[:=]\s*["'][^"']{8,}["']/gi,
      detail: (m) => `Possible hardcoded secret: ${m[0].slice(0, 40)}...`,
    },
    {
      type: "DIRECT_DB_QUERY",
      regex: /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s+(?:FROM|INTO|TABLE|INDEX)/gi,
      detail: (m) => `SQL query in frontend — should be a server-side endpoint`,
    },
    {
      type: "SERVER_SIDE_IMPORT",
      regex: /require\s*\(\s*["'](?:fs|path|child_process|crypto|http|https|net|os|stream|zlib|pg|mysql|mongodb|redis|nodemailer)["']\s*\)/g,
      detail: (m) => `Node.js server module "${m[0]}" imported in frontend code`,
    },
    {
      type: "DIRECT_EXTERNAL_API",
      regex: /fetch\s*\(\s*["']https?:\/\/(?!localhost)(?!pmpro-app\.vercel\.app)[^"']*(?:api\.|\/v[0-9]\/)[^"']*["']/gi,
      detail: (m) => {
        const url = m[0].match(/["']([^"']+)["']/);
        return `Direct external API call — proxy through backend: ${url ? url[1].slice(0, 60) : "unknown"}`;
      },
    },
    {
      type: "ENV_ACCESS",
      regex: /process\.env\.\w+/g,
      detail: (m) => `Server-side env var access: ${m[0]}`,
    },
    {
      type: "INLINE_BUSINESS_LOGIC",
      regex: /(?:creditScore|dti|ltv|underwriting|riskGrade|preApproval)\s*(?:=|:)\s*(?:function|\(.*\)\s*=>)/gi,
      detail: (m) => `Business logic that likely belongs server-side: ${m[0].slice(0, 50)}`,
    },
    {
      type: "NEW_SUPABASE_DIRECT",
      regex: /(?:supabase\.co|\.supabase\.)/gi,
      detail: (m) => `Direct Supabase URL — use the existing SupabaseClient service layer`,
      allowFile: "SupabaseClient",
    },
    {
      type: "NEW_API_KEY_PATTERN",
      regex: /["'](?:sk-|pk_|sb_|key_|Bearer\s+ey)[A-Za-z0-9_\-]{10,}["']/g,
      detail: (m) => `API key pattern detected: ${m[0].slice(0, 30)}...`,
      allowFile: "SupabaseClient",
    },
  ];

  // Known exceptions — files that legitimately contain these patterns
  const KNOWN_EXCEPTIONS = {
    "PropertyRadarService.js": ["DIRECT_EXTERNAL_API"],
    "SupabaseClient.js": ["NEW_SUPABASE_DIRECT", "NEW_API_KEY_PATTERN", "HARDCODED_SECRET"],
  };

  function scanFile(filePath) {
    const code = fs.readFileSync(filePath, "utf8");
    const lines = code.split("\n");
    const basename = path.basename(filePath);
    const exceptions = KNOWN_EXCEPTIONS[basename] || [];

    for (const pattern of PATTERNS) {
      if (exceptions.includes(pattern.type)) continue;
      if (pattern.allowFile && basename.includes(pattern.allowFile)) continue;

      for (let i = 0; i < lines.length; i++) {
        const matches = lines[i].matchAll(pattern.regex);
        for (const m of matches) {
          // Skip matches inside comments
          const before = lines[i].slice(0, m.index);
          if (before.includes("//") || before.includes("/*")) continue;

          const relFile = path.relative(repoRoot, filePath);
          warnings.push({
            file: relFile,
            line: i + 1,
            type: pattern.type,
            detail: pattern.detail(m),
          });
        }
      }
    }
  }

  function scanDir(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(full);
      } else if (entry.name.endsWith(".jsx") || entry.name.endsWith(".js")) {
        scanFile(full);
      }
    }
  }

  scanDir(srcDir);
  return warnings;
}

/* ── PUSH: CC → CD ── */

function push(args) {
  log("Push started: exporting repo → cd-changeset/");
  const extraArgs = args.join(" ");
  try {
    const output = execSync(`node "${path.join(TOOLS_DIR, "cd-push.js")}" ${extraArgs}`, {
      cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8",
    });
    console.log(output);
    log("Push complete");
    writeStatus({ lastPush: new Date().toISOString() });
    notify("CD Push Complete", "cd-changeset/ updated — link folder in CD to read");
    logActivity("push", "Pushed repo to cd-changeset/").catch(() => {});
  } catch (err) {
    log(`cd-push failed: ${err.message}`);
    console.error("Push failed:", err.stderr || err.message);
    process.exit(1);
  }
}

/* ── WATCH: Auto-sync both directions ── */

function watch() {
  const ZIP_PATTERNS = [
    /^PMPro/i,
    /^Mission\s*Control/i,
    /^claude[_-]?design/i,
    /^pmpro/i,
  ];
  const COOLDOWN_MS = 5000;
  let lastProcessed = null;
  let lastProcessedTime = 0;

  log(`Watcher started — monitoring both directions`);
  notify("CD Sync Watcher", "Watching Downloads (CD→CC) and frontend/src (CC→CD)");
  writeStatus({ watching: true, watchDir: WATCH_DIR, startedAt: new Date().toISOString() });
  logActivity("watch_start", "Watcher started").catch(() => {});

  /* ── Direction 1: CD → CC (watch ~/Downloads for zips) ── */

  fs.watch(WATCH_DIR, (event, filename) => {
    if (!filename || !filename.endsWith(".zip")) return;

    const matchesPattern = ZIP_PATTERNS.some(p => p.test(filename));
    if (!matchesPattern) return;

    const fullPath = path.join(WATCH_DIR, filename);
    if (!fs.existsSync(fullPath)) return;

    const now = Date.now();
    if (filename === lastProcessed && (now - lastProcessedTime) < COOLDOWN_MS) return;

    waitForStableFile(fullPath, () => {
      lastProcessed = filename;
      lastProcessedTime = Date.now();

      log(`Detected CD export: ${filename}`);
      notify("CD Sync", `Detected ${filename} — syncing...`);

      try {
        pull(fullPath);
      } catch (err) {
        log(`Auto-sync failed: ${err.message}`);
        notify("CD Sync Failed", `Failed to sync ${filename} — check terminal`);
      }
    });
  });

  /* ── Direction 2: CC → CD (watch frontend/src for changes, auto-push) ── */

  const SRC_DIR = path.join(REPO_ROOT, "frontend", "src");
  const PUSH_DEBOUNCE_MS = 3000;
  let pushTimer = null;
  let pushInProgress = false;

  function autoPush() {
    if (pushInProgress) return;
    pushInProgress = true;
    log("Source files changed — auto-pushing to cd-changeset/");
    try {
      execSync(`node "${path.join(TOOLS_DIR, "cd-push.js")}"`, {
        cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8",
      });
      log("Auto-push complete — cd-changeset/ updated");
      writeStatus({ lastPush: new Date().toISOString() });
    } catch (err) {
      log(`Auto-push failed: ${err.message}`);
    }
    pushInProgress = false;
  }

  function watchDirRecursive(dir) {
    if (!fs.existsSync(dir)) return;
    try {
      fs.watch(dir, (event, filename) => {
        if (!filename) return;
        if (filename.startsWith(".")) return;
        if (!filename.endsWith(".jsx") && !filename.endsWith(".js") && !filename.endsWith(".css")) return;

        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(autoPush, PUSH_DEBOUNCE_MS);
      });
    } catch { /* non-fatal */ }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        watchDirRecursive(path.join(dir, entry.name));
      }
    }
  }

  watchDirRecursive(SRC_DIR);

  // Also watch tokens.css specifically
  const tokensDir = path.join(SRC_DIR, "design-system");
  if (fs.existsSync(tokensDir)) {
    try { fs.watch(tokensDir, () => {
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(autoPush, PUSH_DEBOUNCE_MS);
    }); } catch { /* non-fatal */ }
  }

  // Do an initial push so cd-changeset/ is current
  autoPush();

  // Keep process alive
  process.on("SIGINT", () => {
    log("Watcher stopped");
    writeStatus({ watching: false });
    notify("CD Sync Watcher", "Stopped");
    process.exit(0);
  });

  console.log(`Watching both directions:`);
  console.log(`  CD → CC: ${WATCH_DIR} (zip patterns: PMPro*, Mission Control*, claude-design*, pmpro*)`);
  console.log(`  CC → CD: ${SRC_DIR} (auto-pushes to cd-changeset/ on save)`);
  console.log("Press Ctrl+C to stop.\n");
}

function waitForStableFile(filePath, callback) {
  let lastSize = -1;
  let checks = 0;
  const interval = setInterval(() => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size === lastSize && stat.size > 0) {
        clearInterval(interval);
        callback();
      } else {
        lastSize = stat.size;
        checks++;
        if (checks > 30) { // 30 seconds max wait
          clearInterval(interval);
          log(`Timeout waiting for ${filePath} to stabilize`);
        }
      }
    } catch {
      clearInterval(interval);
    }
  }, 1000);
}

/* ── STATUS ── */

function status() {
  const s = readStatus();
  if (!s) {
    console.log("No sync activity recorded yet.\n");
    console.log("Run `node tools/cd-sync.js watch` to start the file watcher.");
    return;
  }

  console.log("\n=== CD Sync Status ===\n");

  if (s.watching) {
    console.log(`  Watcher:    ACTIVE (since ${formatTime(s.startedAt)})`);
    console.log(`  Monitoring: ${s.watchDir}`);
  } else {
    console.log("  Watcher:    INACTIVE");
  }

  if (s.lastPull) {
    console.log(`  Last pull:  ${formatTime(s.lastPull)} (${s.filesChanged || "?"} files)`);
  }
  if (s.lastPush) {
    console.log(`  Last push:  ${formatTime(s.lastPush)}`);
  }

  console.log(`  Updated:    ${formatTime(s.updatedAt)}`);
  console.log("");

  // Check if watcher process is actually running
  if (s.watching) {
    try {
      const ps = execSync("pgrep -f 'cd-sync.js watch'", { stdio: "pipe", encoding: "utf8" }).trim();
      if (ps) {
        console.log(`  Process PID(s): ${ps.replace(/\n/g, ", ")}`);
      }
    } catch {
      console.log("  Warning: watcher marked as active but process not found.");
      console.log("  Run `node tools/cd-sync.js watch` to restart.");
    }
  }
  console.log("");
}

function formatTime(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)} hr ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/* ── DEPLOY: Push to Vercel production ── */

function deploy() {
  log("Deploying to Vercel production...");
  try {
    const raw = execSync("npx vercel --prod --yes 2>&1", {
      cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8", timeout: 120000,
    });
    const output = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
    const lines = output.split("\n");
    const aliasLine = lines.find(l => l.includes("Aliased:"));
    const prodLine = lines.find(l => l.includes("Production:"));
    const urlMatch = (aliasLine || prodLine || output).match(/https:\/\/[^\s\[]+/);
    const url = urlMatch ? urlMatch[0] : "deployed (check Vercel dashboard)";
    log(`Deploy complete: ${url}`);
    console.log("\n========================================");
    console.log("  DEPLOYED TO PRODUCTION");
    console.log("========================================");
    console.log(`\n  ${url}\n`);
    notify("Vercel Deploy Complete", url || "Production deployment succeeded");
    writeStatus({ lastDeploy: new Date().toISOString(), deployUrl: url });
    logActivity("deploy", `Deployed to ${url}`).catch(() => {});
    return true;
  } catch (err) {
    const stderr = err.stderr || err.message;
    log(`Deploy failed: ${stderr}`);
    console.error("\nVercel deploy failed:\n", stderr);
    notify("Vercel Deploy Failed", "Check terminal for details");
    return false;
  }
}

/* ── CLI Router ── */

const [,, command, ...args] = process.argv;

switch (command) {
  case "pull":
    pull(args[0]);
    break;
  case "push":
    push(args);
    break;
  case "deploy":
    deploy();
    break;
  case "watch":
    watch();
    break;
  case "status":
    status();
    break;
  default:
    console.log(`
cd-sync — Claude Design ↔ Claude Code synchronization

Usage:
  cd-sync pull <zip-or-dir>   Import CD export → repo (convert, build, commit, push)
  cd-sync push                Export repo → cd-changeset/ for CD to read
  cd-sync push --changed      Only export changed files
  cd-sync deploy              Deploy current state to Vercel production
  cd-sync watch               Watch ~/Downloads for CD zips (auto-pull)
  cd-sync status              Show sync status

Workflow:
  1. Run: cd-sync watch (or install LaunchAgent for auto-start)
  2. Link cd-changeset/ folder in CD
  3. Both directions are now automatic:
     - Edit in CC → cd-changeset/ updates within 3s → CD reads linked folder
     - Download zip from CD → watcher auto-converts, builds, commits, pushes
  4. After "CD sync landed" review in Claude Code → commit, push, deploy
`);
}

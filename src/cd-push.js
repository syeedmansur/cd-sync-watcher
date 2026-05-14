#!/usr/bin/env node

/**
 * cd-push — Export repo (ES module) files to Claude Design format (window globals).
 *
 * Usage:
 *   node tools/cd-push.js                     # Export ALL files
 *   node tools/cd-push.js --changed           # Only files changed since last sync tag
 *   node tools/cd-push.js --files A.jsx B.jsx # Only specific files
 *
 * Conversion: ES modules → window globals
 *   - Strips all `import ... from "..."` lines
 *   - Strips `export` keyword from declarations
 *   - Adds `Object.assign(window, { ...exports })` at end
 *   - Restores `const { hooks } = React;` destructuring where needed
 *
 * CD expects window-global format with no import/export statements.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const MAP_PATH = path.join(__dirname, "component-map.json");
const OUTPUT_DIR = path.join(REPO_ROOT, "cd-changeset");

function loadMap() {
  const raw = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
  const entries = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key.startsWith("_")) continue;
    entries[key] = val;
  }
  return entries;
}

function getChangedFiles() {
  try {
    let base;
    try {
      base = execSync("git describe --tags --match 'cd-sync-*' --abbrev=0", {
        cwd: REPO_ROOT, stdio: "pipe",
      }).toString().trim();
    } catch {
      base = execSync("git rev-list --max-parents=0 HEAD", {
        cwd: REPO_ROOT, stdio: "pipe",
      }).toString().trim();
    }
    const diff = execSync(`git diff --name-only ${base} HEAD -- frontend/`, {
      cwd: REPO_ROOT, stdio: "pipe",
    }).toString().trim();
    return diff ? diff.split("\n") : [];
  } catch { return []; }
}

/**
 * Convert an ES module file to CD's window-global format.
 */
function esmToWindowGlobals(code, exportNames) {
  const lines = code.split("\n");
  const output = [];
  const reactHooks = [];
  let needsReactDefault = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Strip import lines, but capture React hook imports
    if (/^import\s+/.test(trimmed)) {
      // import React, { useState, ... } from "react";
      const reactMatch = trimmed.match(/^import\s+React\s*,\s*\{([^}]+)\}\s*from\s*["']react["']/);
      if (reactMatch) {
        needsReactDefault = true;
        reactHooks.push(...reactMatch[1].split(",").map(s => s.trim()).filter(Boolean));
        continue;
      }
      // import React from "react";
      if (/^import\s+React\s+from\s*["']react["']/.test(trimmed)) {
        needsReactDefault = true;
        continue;
      }
      // import { useState, ... } from "react";
      const hooksMatch = trimmed.match(/^import\s*\{([^}]+)\}\s*from\s*["']react["']/);
      if (hooksMatch) {
        reactHooks.push(...hooksMatch[1].split(",").map(s => s.trim()).filter(Boolean));
        continue;
      }
      // All other imports (component deps) — strip entirely
      if (/from\s*["']/.test(trimmed)) continue;
    }

    // Strip `export` keyword from declarations
    let converted = line;
    converted = converted.replace(/^export (function |const |let |async function |class )/, "$1");

    output.push(converted);
  }

  // Prepend React hooks destructuring if needed
  if (reactHooks.length > 0) {
    const insertIdx = findInsertPoint(output);
    output.splice(insertIdx, 0, `const { ${reactHooks.join(", ")} } = React;`, "");
  }

  // Append Object.assign(window, { ... })
  if (exportNames.length > 0) {
    // Remove trailing blank lines before appending
    while (output.length > 0 && output[output.length - 1].trim() === "") {
      output.pop();
    }
    output.push("");
    output.push(`Object.assign(window, { ${exportNames.join(", ")} });`);
    output.push("");
  }

  return output.join("\n");
}

/**
 * Find the line index after the first leading comment block.
 */
function findInsertPoint(lines) {
  let i = 0;
  let inBlock = false;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === "") { i++; continue; }
    if (inBlock) {
      i++;
      if (t.includes("*/")) inBlock = false;
      continue;
    }
    if (t.startsWith("/*")) {
      inBlock = !t.includes("*/");
      i++;
      continue;
    }
    if (t.startsWith("//")) { i++; continue; }
    break;
  }
  return i;
}

function main() {
  const args = process.argv.slice(2);
  const map = loadMap();

  let filterMode = "all";
  let specificFiles = [];

  if (args.includes("--changed")) {
    filterMode = "changed";
  } else if (args.includes("--files")) {
    filterMode = "specific";
    const idx = args.indexOf("--files");
    specificFiles = args.slice(idx + 1);
    if (specificFiles.length === 0) {
      console.error("Error: --files requires at least one filename");
      process.exit(1);
    }
  } else if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage:");
    console.log("  node tools/cd-push.js              Export ALL files");
    console.log("  node tools/cd-push.js --changed     Only changed since last cd-sync tag");
    console.log("  node tools/cd-push.js --files A B    Only specific component files");
    process.exit(0);
  }

  let changedRepoPaths = null;
  if (filterMode === "changed") {
    changedRepoPaths = new Set(getChangedFiles());
    if (changedRepoPaths.size === 0) {
      console.log("No files changed since last sync. Nothing to export.");
      process.exit(0);
    }
  }

  // Clean output
  if (fs.existsSync(OUTPUT_DIR)) fs.rmSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUTPUT_DIR, "components"), { recursive: true });

  const exported = [];

  for (const [mapKey, entry] of Object.entries(map)) {
    const repoFile = path.join(REPO_ROOT, entry.repoPath);
    if (!fs.existsSync(repoFile)) continue;

    if (filterMode === "changed" && !changedRepoPaths.has(entry.repoPath)) continue;
    if (filterMode === "specific") {
      const matchesAny = specificFiles.some(
        f => mapKey === f || path.basename(entry.repoPath) === f || entry.cdPath.endsWith(f)
      );
      if (!matchesAny) continue;
    }

    // Read and convert
    const code = fs.readFileSync(repoFile, "utf8");
    const converted = esmToWindowGlobals(code, entry.exports || []);

    const destFile = path.join(OUTPUT_DIR, entry.cdPath);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.writeFileSync(destFile, converted);
    exported.push({ mapKey, cdPath: entry.cdPath, repoPath: entry.repoPath });
  }

  // Special files: CSS and index.html (need CD-format index.html)
  const specialFiles = [
    { repoPath: "frontend/src/design-system/tokens.css", cdPath: "colors_and_type.css" },
  ];
  for (const sf of specialFiles) {
    const src = path.join(REPO_ROOT, sf.repoPath);
    if (!fs.existsSync(src)) continue;
    if (filterMode === "changed" && !changedRepoPaths?.has(sf.repoPath)) continue;
    const dest = path.join(OUTPUT_DIR, sf.cdPath);
    fs.copyFileSync(src, dest);
    exported.push({ mapKey: sf.cdPath, cdPath: sf.cdPath, repoPath: sf.repoPath });
  }

  // Generate CD-format index.html (with script type="text/babel" tags)
  const cdIndexHtml = generateCDIndexHtml(map);
  fs.writeFileSync(path.join(OUTPUT_DIR, "index.html"), cdIndexHtml);
  exported.push({ mapKey: "index.html", cdPath: "index.html", repoPath: "(generated)" });

  if (exported.length === 0) {
    console.log("No files to export.");
    process.exit(0);
  }

  // Generate CHANGESET.md
  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const componentFiles = exported.filter(e => e.cdPath.startsWith("components/"));
  const rootFiles = exported.filter(e => !e.cdPath.startsWith("components/"));

  let changeset = `# CD Changeset — ${timestamp}\n\n`;
  changeset += `${exported.length} file(s) to import into Claude Design.\n\n`;
  changeset += `## How to import\n\n`;
  changeset += `Use the **paperclip button** in CD to attach each file listed below.\n`;
  changeset += `Tell CD: "I'm updating these files from the repo. Replace the existing versions."\n\n`;

  if (rootFiles.length > 0) {
    changeset += `### Root files\n`;
    rootFiles.forEach(e => { changeset += `- \`${e.cdPath}\` ← \`${e.repoPath}\`\n`; });
    changeset += `\n`;
  }
  if (componentFiles.length > 0) {
    changeset += `### Component files\n`;
    componentFiles.forEach(e => { changeset += `- \`${e.cdPath}\` ← \`${e.repoPath}\`\n`; });
    changeset += `\n`;
  }

  changeset += `## Paste this into CD chat\n\n`;
  changeset += "```\n";
  changeset += `I'm attaching ${exported.length} updated file(s) from the repo. `;
  changeset += `Please replace the existing versions of these files:\n`;
  exported.forEach(e => { changeset += `  - ${e.cdPath}\n`; });
  changeset += `The files use the window-global pattern. No API changes.\n`;
  changeset += "```\n";

  fs.writeFileSync(path.join(OUTPUT_DIR, "CHANGESET.md"), changeset);

  // Always include the frontend design principles doc for CD to read
  const principlesNames = ["FRONTEND_PRINCIPLES.md"];
  const docsDir = path.join(REPO_ROOT, "docs", "cd-handoff");
  for (const name of principlesNames) {
    const src = path.join(docsDir, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(OUTPUT_DIR, name));
      console.log(`  Included ${name} for CD`);
      break;
    }
  }

  console.log(`\ncd-push: exported ${exported.length} file(s) to cd-changeset/\n`);
  exported.forEach(e => console.log(`  ${e.cdPath}  ←  ${e.repoPath}`));
  console.log(`\nRead cd-changeset/CHANGESET.md for import instructions.`);
  console.log(`Files are in cd-changeset/ ready to paperclip-attach into CD.\n`);

  // Tag sync point
  try {
    const tag = `cd-sync-${Date.now()}`;
    execSync(`git tag ${tag}`, { cwd: REPO_ROOT, stdio: "pipe" });
    console.log(`Tagged current state as ${tag} for future --changed diffs.\n`);
  } catch { }
}

/**
 * Generate a CD-compatible index.html with <script type="text/babel"> tags
 * and React/Babel CDN scripts.
 */
function generateCDIndexHtml(map) {
  // Read the Vite index.html for the <style> block
  const viteHtml = fs.readFileSync(path.join(REPO_ROOT, "frontend", "index.html"), "utf8");
  const styleMatch = viteHtml.match(/<style>([\s\S]*?)<\/style>/);
  const styleBlock = styleMatch ? styleMatch[0] : "";

  // Read main.jsx to extract the inline App code
  const mainJsx = fs.readFileSync(path.join(REPO_ROOT, "frontend", "src", "main.jsx"), "utf8");
  // Strip imports and createRoot, keep the component definitions
  const mainLines = mainJsx.split("\n");
  const appCode = mainLines
    .filter(line => !line.trim().startsWith("import "))
    .filter(line => !line.trim().startsWith("createRoot("))
    .join("\n")
    .trim();

  // Build script tags in load order
  const scriptOrder = [
    "components/Atoms.jsx",
    "components/D3Charts.jsx",
    "components/CollapsibleSection.jsx",
    "components/TopNav.jsx",
    "components/SnapshotStrip.jsx",
    "components/LocalPulseData.jsx",
    "components/LiveMap.jsx",
    "components/MarketPulse.jsx",
    "components/VelocityGauge.jsx",
    "components/PeerActivity.jsx",
    "components/Crews.jsx",
    "components/ShareModal.jsx",
    "components/Leaderboard.jsx",
    "components/LocalPulse.jsx",
    "components/InviteToUnlock.jsx",
    "components/PropertyRadarService.jsx",
    "components/AutoScrollList.jsx",
    "components/SupabaseClient.jsx",
    "components/DraggableChips.jsx",
    "components/TableActions.jsx",
    "components/InlineEmailPreview.jsx",
    "components/LoanCalc.jsx",
    "components/CRMData.jsx",
    "components/CRMDashboard.jsx",
    "components/LeadDetailPanel.jsx",
    "components/PreviewOffer.jsx",
    "components/OneShotPrescreen.jsx",
    "components/GeoPrescreen.jsx",
    "components/FindNewLeads.jsx",
    "components/AnalyticsRow.jsx",
    "components/TakeAction.jsx",
    "components/PipelinePulse.jsx",
    "tweaks-panel.jsx",
  ];

  const scriptTags = scriptOrder
    .map(p => `  <script type="text/babel" src="${p}"></script>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PMPro — Mission Control</title>
  <link rel="stylesheet" href="colors_and_type.css">

  <!-- Leaflet -->
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js"></script>

  <!-- D3 -->
  <script src="https://unpkg.com/d3@7/dist/d3.min.js"></script>

  <!-- React -->
  <script src="https://unpkg.com/react@18.3.1/umd/react.development.js" crossorigin="anonymous"></script>
  <script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" crossorigin="anonymous"></script>
  <script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" crossorigin="anonymous"></script>

  ${styleBlock}
</head>
<body>
  <div id="root"></div>

  <!-- Google Maps -->
  <script src="https://maps.googleapis.com/maps/api/js?key=${process.env.GOOGLE_MAPS_KEY || ''}&libraries=places,geometry,drawing"></script>

${scriptTags}

  <script type="text/babel">
    const { useState, useEffect, useRef } = React;

    ${appCode}

    ReactDOM.createRoot(document.getElementById("root")).render(<App />);
  </script>
</body>
</html>
`;
}

main();

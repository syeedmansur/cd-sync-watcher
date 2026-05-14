#!/usr/bin/env node

/**
 * cd-pull — Import a Claude Design export into the repo (converting to ES modules).
 *
 * Usage:
 *   node tools/cd-pull.js <path-to-cd-export-dir-or-zip>
 *
 * Conversion: window globals → ES modules
 *   - Strips `const { hooks } = React;` destructuring
 *   - Strips `Object.assign(window, { ... })` at end
 *   - Adds `import { hooks } from "react"` at top
 *   - Adds component dependency imports (from component-map.json)
 *   - Adds `export` keyword before each exported declaration
 *
 * Uses component-map.json for dependency resolution (which exports come from which file).
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const MAP_PATH = path.join(__dirname, "component-map.json");

function loadMap() {
  const raw = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
  const entries = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key.startsWith("_")) continue;
    entries[key] = val;
  }
  return entries;
}

function resolveInput(input) {
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) {
    console.error(`Error: ${abs} does not exist`);
    process.exit(1);
  }
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return abs;

  if (abs.endsWith(".zip")) {
    const tmpDir = path.join(REPO_ROOT, ".cd-import-tmp");
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    execSync(`unzip -o "${abs}" -d "${tmpDir}"`, { stdio: "pipe" });
    const contents = fs.readdirSync(tmpDir).filter(f => !f.startsWith("."));
    if (contents.length === 1 && fs.statSync(path.join(tmpDir, contents[0])).isDirectory()) {
      return path.join(tmpDir, contents[0]);
    }
    return tmpDir;
  }

  console.error("Error: input must be a directory or .zip file");
  process.exit(1);
}

function findCDFiles(cdDir) {
  const files = {};
  for (const f of fs.readdirSync(cdDir)) {
    const full = path.join(cdDir, f);
    if (fs.statSync(full).isFile()) files[f] = full;
  }
  for (const subdir of ["components", "assets"]) {
    const sub = path.join(cdDir, subdir);
    if (!fs.existsSync(sub)) continue;
    for (const f of fs.readdirSync(sub)) {
      const full = path.join(sub, f);
      if (fs.statSync(full).isFile()) files[f] = full;
    }
  }
  return files;
}

function filesEqual(a, b) {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
  return fs.readFileSync(a, "utf8") === fs.readFileSync(b, "utf8");
}

/**
 * Build an export→source lookup from the full map.
 * Returns { "Icon": "frontend/src/design-system/Atoms.jsx", ... }
 */
function buildExportLookup(map) {
  const lookup = {};
  for (const [, entry] of Object.entries(map)) {
    for (const exp of (entry.exports || [])) {
      lookup[exp] = entry.repoPath;
    }
  }
  return lookup;
}

/**
 * Compute relative import path from one repo file to another.
 */
function relPath(fromRepoPath, toRepoPath) {
  const fromDir = path.dirname(path.join(REPO_ROOT, fromRepoPath));
  const toAbs = path.join(REPO_ROOT, toRepoPath);
  let rel = path.relative(fromDir, toAbs);
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

/**
 * Convert a CD window-global file to ES module format.
 */
function windowGlobalsToEsm(code, entry, map, exportLookup) {
  const lines = code.split("\n");
  const output = [];
  const reactHooks = [];
  let usesReactDefault = false;

  // Parse the code to extract React hooks and strip CD-specific patterns
  for (const line of lines) {
    const trimmed = line.trim();

    // Capture and strip `const { useState, ... } = React;`
    const hooksMatch = trimmed.match(/^const\s*\{\s*([^}]+)\}\s*=\s*React\s*;/);
    if (hooksMatch) {
      reactHooks.push(...hooksMatch[1].split(",").map(s => s.trim()).filter(Boolean));
      continue;
    }

    // Strip `Object.assign(window, { ... });`
    if (/^Object\.assign\s*\(\s*window\s*,/.test(trimmed)) continue;

    output.push(line);
  }

  // Check if code uses React.xxx pattern (e.g., React.memo, React.useState)
  const codeStr = output.join("\n");
  if (/\bReact\.(memo|createContext|forwardRef|lazy|Suspense|Fragment|createElement)\b/.test(codeStr)) {
    usesReactDefault = true;
  }
  if (/\bReact\.(useState|useEffect|useRef|useMemo|useCallback|useReducer|useContext)\b/.test(codeStr)) {
    usesReactDefault = true;
  }

  // Build import statements
  const imports = [];

  // React imports
  if (usesReactDefault && reactHooks.length > 0) {
    imports.push(`import React, { ${reactHooks.join(", ")} } from "react";`);
  } else if (usesReactDefault) {
    imports.push(`import React from "react";`);
  } else if (reactHooks.length > 0) {
    imports.push(`import { ${reactHooks.join(", ")} } from "react";`);
  }

  // Component dependency imports (from dependsOn in map)
  if (entry.dependsOn) {
    for (const [depFile, depNames] of Object.entries(entry.dependsOn)) {
      const depEntry = map[depFile];
      if (!depEntry) continue;
      const rel = relPath(entry.repoPath, depEntry.repoPath);
      imports.push(`import { ${depNames.join(", ")} } from "${rel}";`);
    }
  }

  // Add `export` before exported declarations
  const exportNames = new Set(entry.exports || []);
  const transformed = [];
  for (const line of output) {
    let l = line;
    for (const expName of exportNames) {
      // function declarations
      l = l.replace(new RegExp(`^(function\\s+${expName}\\s*[(<])`), `export $1`);
      l = l.replace(new RegExp(`^(async\\s+function\\s+${expName}\\s*[(<])`), `export $1`);
      // const/let declarations
      l = l.replace(new RegExp(`^(const\\s+${expName}\\s*=)`), `export $1`);
      l = l.replace(new RegExp(`^(let\\s+${expName}\\s*=)`), `export $1`);
    }
    transformed.push(l);
  }

  // Find insert point (after first leading comment block only)
  let commentEnd = 0;
  let inBlock = false;
  while (commentEnd < transformed.length) {
    const t = transformed[commentEnd].trim();
    if (t === "") { commentEnd++; continue; }
    if (inBlock) {
      commentEnd++;
      if (t.includes("*/")) inBlock = false;
      continue;
    }
    if (t.startsWith("/*")) {
      inBlock = !t.includes("*/");
      commentEnd++;
      continue;
    }
    if (t.startsWith("//")) { commentEnd++; continue; }
    break;
  }

  // Reassemble
  const leading = transformed.slice(0, commentEnd);
  const rest = transformed.slice(commentEnd);

  let final = "";
  if (leading.length > 0) {
    final += leading.join("\n").trimEnd() + "\n\n";
  }
  if (imports.length > 0) {
    final += imports.join("\n") + "\n\n";
  }
  final += rest.join("\n").trimEnd() + "\n";

  return final;
}

function copyAssets(cdDir, category, srcSubdir, destSubdir) {
  const srcDir = path.join(cdDir, srcSubdir);
  if (!fs.existsSync(srcDir)) return [];
  const destDir = path.join(REPO_ROOT, destSubdir);
  fs.mkdirSync(destDir, { recursive: true });
  const copied = [];
  for (const f of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, f);
    const dest = path.join(destDir, f);
    if (!fs.statSync(src).isFile()) continue;
    if (!filesEqual(src, dest)) {
      fs.copyFileSync(src, dest);
      copied.push(`${category}: ${f}`);
    }
  }
  return copied;
}

function main() {
  const input = process.argv[2];
  if (!input) {
    console.log("Usage: node tools/cd-pull.js <cd-export-dir-or-zip>");
    console.log("");
    console.log("Examples:");
    console.log('  node tools/cd-pull.js "/tmp/PMPro Mission Control.zip"');
    console.log("  node tools/cd-pull.js /tmp/pmpro_cd");
    process.exit(0);
  }

  const map = loadMap();
  const cdDir = resolveInput(input);
  const cdFiles = findCDFiles(cdDir);
  const exportLookup = buildExportLookup(map);

  console.log(`\ncd-pull: importing from ${cdDir}`);
  console.log(`Found ${Object.keys(cdFiles).length} files in CD export\n`);

  const changes = [];
  const skipped = [];
  const unmapped = [];
  const protected_ = [];

  // Process mapped component files
  for (const [mapKey, entry] of Object.entries(map)) {
    const cdFileName = path.basename(entry.cdPath);
    const cdFile = cdFiles[cdFileName];
    if (!cdFile) {
      skipped.push(mapKey);
      continue;
    }

    const repoFile = path.join(REPO_ROOT, entry.repoPath);
    const repoDir = path.dirname(repoFile);

    // Read CD file and convert to ES modules
    const cdCode = fs.readFileSync(cdFile, "utf8");
    const esmCode = windowGlobalsToEsm(cdCode, entry, map, exportLookup);

    // Check if different from current repo version
    const existed = fs.existsSync(repoFile);
    const currentCode = existed ? fs.readFileSync(repoFile, "utf8") : "";
    if (esmCode === currentCode) continue;

    // Protected files: CC has added backend wiring that CD doesn't know about.
    // Save CD's version as .cd-incoming for manual merge instead of overwriting.
    if (entry.protected) {
      const incomingPath = repoFile + ".cd-incoming";
      fs.mkdirSync(repoDir, { recursive: true });
      fs.writeFileSync(incomingPath, esmCode);
      protected_.push({ file: entry.repoPath, incoming: incomingPath, reason: entry.protectedReason || "has backend wiring" });
      continue;
    }

    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(repoFile, esmCode);
    changes.push(`${existed ? "Updated" : "Added"}: ${entry.repoPath}  (from ${entry.cdPath})`);
  }

  // Handle CSS
  const cssFile = cdFiles["colors_and_type.css"];
  if (cssFile) {
    const dest = path.join(REPO_ROOT, "frontend/src/design-system/tokens.css");
    if (!filesEqual(cssFile, dest)) {
      fs.copyFileSync(cssFile, dest);
      changes.push("Updated: frontend/src/design-system/tokens.css");
    }
  }

  // Handle index.html — find the highest version (CD may version them)
  const htmlVersions = Object.keys(cdFiles)
    .filter(f => (f.startsWith("Mission Control") || f === "index.html") && f.endsWith(".html"))
    .sort((a, b) => {
      const vA = parseInt((a.match(/v(\d+)/) || [0, 0])[1]);
      const vB = parseInt((b.match(/v(\d+)/) || [0, 0])[1]);
      return vB - vA;
    });

  if (htmlVersions.length > 0) {
    const latest = htmlVersions[0];
    console.log(`  Note: CD index.html (${latest}) found but NOT imported.`);
    console.log(`  The repo uses Vite — main.jsx is the entry point, not the CD HTML.\n`);

    // Diff section titles/layout between CD index.html and main.jsx
    const cdHtml = fs.readFileSync(cdFiles[latest], "utf8");
    const mainJsx = fs.existsSync(path.join(REPO_ROOT, "frontend/src/main.jsx"))
      ? fs.readFileSync(path.join(REPO_ROOT, "frontend/src/main.jsx"), "utf8") : "";
    const sectionRe = /CollapsibleSection[^>]*id="([^"]*)"[^>]*title="([^"]*)"[^>]*eyebrow="([^"]*)"/g;
    const cdSections = [...cdHtml.matchAll(sectionRe)].map(m => ({ id: m[1], title: m[2], eyebrow: m[3] }));
    const ccSections = [...mainJsx.matchAll(sectionRe)].map(m => ({ id: m[1], title: m[2], eyebrow: m[3] }));
    const ccById = Object.fromEntries(ccSections.map(s => [s.id, s]));
    const layoutDiffs = [];
    for (const cd of cdSections) {
      const cc = ccById[cd.id];
      if (!cc) { layoutDiffs.push(`  NEW SECTION: id="${cd.id}" title="${cd.title}" eyebrow="${cd.eyebrow}"`); continue; }
      if (cd.title !== cc.title) layoutDiffs.push(`  TITLE CHANGED: id="${cd.id}"\n    CD: "${cd.title}"\n    CC: "${cc.title}"`);
      if (cd.eyebrow !== cc.eyebrow) layoutDiffs.push(`  EYEBROW CHANGED: id="${cd.id}"\n    CD: "${cd.eyebrow}"\n    CC: "${cc.eyebrow}"`);
    }
    const cdIds = cdSections.map(s => s.id).join(",");
    const ccIds = ccSections.map(s => s.id).join(",");
    if (cdIds !== ccIds) layoutDiffs.push(`  SECTION ORDER CHANGED:\n    CD: ${cdIds}\n    CC: ${ccIds}`);
    if (layoutDiffs.length > 0) {
      console.log("========================================");
      console.log("  LAYOUT DRIFT: main.jsx vs CD index.html");
      console.log("========================================\n");
      console.log("CD's index.html has different section titles/order than main.jsx.");
      console.log("Update main.jsx to match (titles and eyebrows are string-only changes).\n");
      layoutDiffs.forEach(d => console.log(d + "\n"));
    }

    // CSS drift detection: compare CD's <style> block to tokens.css
    const styleMatch = cdHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/);
    if (styleMatch) {
      const cdCSS = styleMatch[1];
      const ruleRe = /([.#][a-zA-Z][\w-]*(?:\s+[a-zA-Z][\w-]*)*)\s*\{([^}]+)\}/g;
      const cdRules = {};
      let m;
      while ((m = ruleRe.exec(cdCSS)) !== null) {
        cdRules[m[1].trim()] = m[2].trim().replace(/\s+/g, " ");
      }

      const tokensPath = path.join(REPO_ROOT, "frontend/src/design-system/tokens.css");
      const tokensCSS = fs.existsSync(tokensPath) ? fs.readFileSync(tokensPath, "utf8") : "";
      const ccRules = {};
      while ((m = ruleRe.exec(tokensCSS)) !== null) {
        ccRules[m[1].trim()] = m[2].trim().replace(/\s+/g, " ");
      }

      const cssDiffs = [];
      for (const [selector, props] of Object.entries(cdRules)) {
        if (selector.startsWith(".live-") || selector.startsWith(".sparkline")) continue;
        if (!ccRules[selector]) {
          cssDiffs.push(`  NEW RULE: ${selector} { ${props.substring(0, 80)}${props.length > 80 ? "..." : ""} }`);
        } else if (ccRules[selector] !== props) {
          cssDiffs.push(`  CHANGED: ${selector}\n    CD: { ${props.substring(0, 80)}${props.length > 80 ? "..." : ""} }\n    CC: { ${ccRules[selector].substring(0, 80)}${ccRules[selector].length > 80 ? "..." : ""} }`);
        }
      }

      if (cssDiffs.length > 0) {
        console.log("========================================");
        console.log("  CSS DRIFT: tokens.css vs CD index.html <style>");
        console.log("========================================\n");
        console.log("CD's <style> block has CSS rules not in tokens.css.");
        console.log("Review and add missing rules to frontend/src/design-system/tokens.css.\n");
        cssDiffs.forEach(d => console.log(d + "\n"));
      }
    }
  }

  // Copy binary assets (images, fonts, uploads)
  changes.push(...copyAssets(cdDir, "Asset", "assets", "frontend/public/images"));
  changes.push(...copyAssets(cdDir, "Font", "fonts", "frontend/src/design-system/fonts"));
  changes.push(...copyAssets(cdDir, "Upload", "uploads", "docs/uploads"));

  // Also grab loose image files at root of CD export
  const IMAGE_EXTS = new Set([".jpeg", ".jpg", ".png", ".gif", ".svg", ".webp", ".ico"]);
  for (const [fileName, filePath] of Object.entries(cdFiles)) {
    const ext = path.extname(fileName).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;
    const destDir = path.join(REPO_ROOT, "frontend/public/images");
    const dest = path.join(destDir, fileName);
    fs.mkdirSync(destDir, { recursive: true });
    if (!filesEqual(filePath, dest)) {
      fs.copyFileSync(filePath, dest);
      changes.push(`Asset: ${fileName} (root-level image → frontend/public/images/)`);
    }
  }

  // Find unmapped component files
  const mappedCDNames = new Set(Object.values(map).map(e => path.basename(e.cdPath)));
  const knownSpecial = new Set(["colors_and_type.css", ...htmlVersions]);
  for (const f of Object.keys(cdFiles)) {
    if (!mappedCDNames.has(f) && !knownSpecial.has(f) && (f.endsWith(".jsx") || f.endsWith(".js"))) {
      unmapped.push(f);
    }
  }

  // Detect and copy CD handoff markdown files
  const mdFiles = [];
  const scanForMd = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(".")) continue;
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) {
        scanForMd(full);
      } else if (f.endsWith(".md") && f.toLowerCase() !== "readme.md" && f.toUpperCase() !== "CHANGESET.MD") {
        mdFiles.push({ name: f, path: full });
      }
    }
  };
  scanForMd(cdDir);

  const handoffDir = path.join(REPO_ROOT, "docs", "cd-handoff");
  if (mdFiles.length > 0) {
    fs.mkdirSync(handoffDir, { recursive: true });
    for (const md of mdFiles) {
      const dest = path.join(handoffDir, md.name);
      fs.copyFileSync(md.path, dest);
      changes.push(`Handoff: docs/cd-handoff/${md.name}`);
    }
  }

  // Summary
  console.log("=== CD Pull Summary ===\n");
  if (changes.length === 0) {
    console.log("No changes detected — repo is up to date with CD export.\n");
  } else {
    console.log(`${changes.length} file(s) changed:\n`);
    changes.forEach(c => console.log(`  ${c}`));
    console.log("");
  }

  if (protected_.length > 0) {
    console.log("========================================");
    console.log("  PROTECTED FILES — MANUAL MERGE NEEDED");
    console.log("========================================\n");
    console.log("These files have backend wiring that CD doesn't know about.");
    console.log("CD's version is saved as .cd-incoming — diff and merge UI changes only.\n");
    for (const p of protected_) {
      console.log(`  ${p.file}  (${p.reason})`);
      console.log(`    CD version: ${p.file}.cd-incoming`);
      console.log(`    Action: diff the two, keep backend wiring, adopt UI changes\n`);
    }
  }

  if (unmapped.length > 0) {
    console.log(`${unmapped.length} unmapped file(s) — add to component-map.json:\n`);
    unmapped.forEach(f => console.log(`  ${f}`));
    console.log("");
  }

  if (skipped.length > 0) {
    console.log(`${skipped.length} mapped file(s) not in CD export (unchanged or removed):`);
    skipped.forEach(f => console.log(`  ${f}`));
    console.log("");
  }

  // Surface handoff markdown
  if (mdFiles.length > 0) {
    console.log("========================================");
    console.log("  CD HANDOFF NOTES");
    console.log("========================================\n");
    console.log("Claude Design included guidance for backend/integration work:\n");
    for (const md of mdFiles) {
      console.log(`  docs/cd-handoff/${md.name}`);
    }
    console.log("\n  These are guidance — review them in context of the existing");
    console.log("  architecture and design patterns before implementing.\n");
  }

  // Cleanup temp dir
  const tmpDir = path.join(REPO_ROOT, ".cd-import-tmp");
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });

  console.log("Done. Run `git diff` to review changes before committing.\n");
}

main();

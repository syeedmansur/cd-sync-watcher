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

/**
 * Parse CSS text into an ordered list of { selector, body, raw } blocks.
 * Handles flat rules only (no @media nesting). Skips :root {} blocks.
 */
function parseCSSRules(css) {
  const rules = [];
  let i = 0;
  while (i < css.length) {
    // Skip whitespace and comments
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    if (/\s/.test(css[i])) { i++; continue; }

    // Find opening brace
    const braceStart = css.indexOf('{', i);
    if (braceStart === -1) break;
    const selector = css.slice(i, braceStart).trim();

    // Match braces (handles nested braces in :root)
    let depth = 1;
    let j = braceStart + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(braceStart + 1, j - 1).trim();
    const raw = css.slice(i, j);

    if (selector !== ':root' && !selector.startsWith('@')) {
      rules.push({ selector, body, raw });
    }
    i = j;
  }
  return rules;
}

/**
 * Parse CSS body into a Map of property-name → full declaration (e.g. "flex" → "flex: 1 1 0%").
 */
function parseProps(body) {
  const map = new Map();
  for (const decl of body.split(';')) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const prop = trimmed.slice(0, colonIdx).trim();
    map.set(prop, trimmed);
  }
  return map;
}

/**
 * Property-level merge: take CD's properties, keep CC-only additions.
 * CD wins when both define the same property; CC-only properties are preserved.
 */
function mergeProps(ccBody, cdBody) {
  const ccProps = parseProps(ccBody);
  const cdProps = parseProps(cdBody);
  const merged = new Map(ccProps);
  for (const [prop, decl] of cdProps) {
    merged.set(prop, decl);
  }
  return [...merged.values()].join(';\n  ');
}

/**
 * Merge CD's <style> CSS into tokens.css.
 * - NEW rules from CD are appended in a marked section.
 * - CHANGED rules get property-level merge (CD wins per-property, CC-only properties kept).
 * - CC-only rules are preserved untouched.
 * - Component-scoped rules (.live-*, .sparkline*) are skipped.
 */
function mergeCSS(cdStyleText) {
  const tokensPath = path.join(REPO_ROOT, "frontend/src/design-system/tokens.css");
  let tokensCSS = fs.existsSync(tokensPath) ? fs.readFileSync(tokensPath, "utf8") : "";

  const cdRules = parseCSSRules(cdStyleText);
  const ccRules = parseCSSRules(tokensCSS);
  const ccBySelector = {};
  for (const rule of ccRules) {
    ccBySelector[rule.selector] = rule;
  }

  const skipPrefixes = [".live-", ".sparkline"];
  const added = [];
  const updated = [];
  const skipped = [];
  const toAppend = [];

  for (const cdRule of cdRules) {
    if (skipPrefixes.some(p => cdRule.selector.startsWith(p))) {
      skipped.push(cdRule.selector);
      continue;
    }

    const existing = ccBySelector[cdRule.selector];
    if (!existing) {
      const formatted = formatRule(cdRule.selector, cdRule.body);
      toAppend.push(formatted);
      added.push(cdRule.selector);
    } else {
      const mergedBody = mergeProps(existing.body, cdRule.body);
      const ccNorm = [...parseProps(existing.body).values()].sort().join('; ');
      const mergedNorm = [...parseProps(mergedBody).values()].sort().join('; ');
      if (ccNorm !== mergedNorm) {
        const formatted = formatRule(cdRule.selector, mergedBody);
        tokensCSS = tokensCSS.replace(existing.raw, formatted);
        updated.push(cdRule.selector);
      }
    }
  }

  if (toAppend.length > 0) {
    const marker = "/* --- CD auto-merged rules --- */";
    const existingMarkerIdx = tokensCSS.indexOf(marker);
    const block = toAppend.join("\n");

    if (existingMarkerIdx !== -1) {
      const insertPoint = tokensCSS.indexOf("\n", existingMarkerIdx) + 1;
      tokensCSS = tokensCSS.slice(0, insertPoint) + block + "\n" + tokensCSS.slice(insertPoint);
    } else {
      tokensCSS = tokensCSS.trimEnd() + "\n\n" + marker + "\n" + block + "\n";
    }
  }

  fs.writeFileSync(tokensPath, tokensCSS);
  return { added, updated, skipped };
}

/**
 * Format a CSS rule block with consistent indentation.
 */
function formatRule(selector, body) {
  const props = body.split(';').map(p => p.trim()).filter(Boolean);
  if (props.length <= 2) {
    return `${selector} { ${props.join('; ')}; }`;
  }
  return `${selector} {\n${props.map(p => `  ${p};`).join('\n')}\n}`;
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

    // CSS auto-merge: extract CD's <style> rules and merge into tokens.css
    const styleMatch = cdHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/);
    if (styleMatch) {
      const merged = mergeCSS(styleMatch[1]);
      if (merged.added.length > 0 || merged.updated.length > 0) {
        console.log("========================================");
        console.log("  CSS AUTO-MERGE: CD <style> → tokens.css");
        console.log("========================================\n");
        merged.added.forEach(s => console.log(`  ADDED: ${s}`));
        merged.updated.forEach(s => console.log(`  UPDATED: ${s}`));
        merged.skipped.forEach(s => console.log(`  SKIPPED (component-scoped): ${s}`));
        console.log("");
        changes.push(`Updated: frontend/src/design-system/tokens.css  (${merged.added.length} new, ${merged.updated.length} changed rules from CD <style>)`);
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

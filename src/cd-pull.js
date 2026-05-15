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
 * Parse the trailing `Object.assign(window, { a, b, c })` block in a CD file
 * and return the list of exported identifier names. Returns null if no such
 * block is found. This is the source-of-truth for what a CD file exports;
 * cd-pull uses it instead of relying on a possibly stale component-map.
 */
function extractObjectAssignExports(code) {
  const match = code.match(/Object\.assign\s*\(\s*window\s*,\s*\{([\s\S]*?)\}\s*\)\s*;?/);
  if (!match) return null;
  const inside = match[1]
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const names = inside
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const colonIdx = s.indexOf(":");
      return colonIdx === -1 ? s : s.slice(0, colonIdx).trim();
    })
    .filter(n => /^[A-Za-z_$][\w$]*$/.test(n));
  return names.length > 0 ? names : null;
}

/**
 * Strip JS strings, template literals, and comments from code so identifier
 * scanning doesn't get false positives from string contents.
 */
function stripStringsAndComments(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const nxt = code[i + 1];
    // line comment
    if (c === "/" && nxt === "/") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    // block comment
    if (c === "/" && nxt === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // string (single, double, template)
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        if (code[i] === "\\") { i += 2; continue; }
        if (code[i] === quote) { i++; break; }
        // template literal expression `${...}` — preserve as code so identifiers inside stay scannable
        if (quote === "`" && code[i] === "$" && code[i + 1] === "{") {
          out += "${";
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (code[i] === "{") depth++;
            else if (code[i] === "}") depth--;
            if (depth > 0) out += code[i];
            i++;
          }
          out += "}";
          continue;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const JS_KEYWORDS = new Set([
  "if","else","for","while","do","switch","case","break","continue","return",
  "function","var","let","const","class","extends","new","delete","typeof",
  "instanceof","in","of","this","super","void","null","undefined","true","false",
  "try","catch","finally","throw","async","await","yield","import","from","export",
  "default","static","get","set","Object","Array","String","Number","Boolean",
  "Math","JSON","Date","RegExp","Error","Promise","Map","Set","WeakMap","WeakSet",
  "console","window","document","globalThis","arguments","NaN","Infinity",
]);

/**
 * Extract the set of identifier names *referenced* in code (used but possibly not defined).
 * Excludes keywords, builtins, and identifiers that look like property accesses (foo.bar — bar is excluded).
 */
function extractReferencedIdentifiers(code) {
  const cleaned = stripStringsAndComments(code);
  const refs = new Set();
  // Match identifiers NOT preceded by a dot (so we skip foo.bar's "bar")
  const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const name = m[2];
    if (JS_KEYWORDS.has(name)) continue;
    if (/^[0-9]/.test(name)) continue;
    refs.add(name);
  }
  return refs;
}

/**
 * Extract the set of identifiers *defined* locally in the file:
 * function declarations, const/let/var bindings, parameter names, destructured names.
 */
function extractLocalDefinitions(code) {
  const cleaned = stripStringsAndComments(code);
  const defs = new Set();
  // function name() { ... }
  for (const m of cleaned.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) defs.add(m[1]);
  for (const m of cleaned.matchAll(/\basync\s+function\s+([A-Za-z_$][\w$]*)/g)) defs.add(m[1]);
  // const/let/var name = ...
  for (const m of cleaned.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defs.add(m[1]);
  // const { a, b: x } = ... — destructured names
  for (const m of cleaned.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const name = part.split(":").pop().split("=")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) defs.add(name);
    }
  }
  // class Name { ... }
  for (const m of cleaned.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) defs.add(m[1]);
  // Common function parameters — best-effort: scan `function foo(a, b, { c }) {` and arrow `(a, b) =>`
  for (const m of cleaned.matchAll(/\bfunction[^(]*\(([^)]*)\)/g)) {
    addParamsToSet(m[1], defs);
  }
  for (const m of cleaned.matchAll(/\(([^)]*)\)\s*=>/g)) {
    addParamsToSet(m[1], defs);
  }
  return defs;
}

function addParamsToSet(params, set) {
  const cleaned = params.replace(/\{[^}]*\}/g, p => p); // keep destructured names visible
  for (const part of cleaned.split(",")) {
    const inner = part.replace(/[{}]/g, " ");
    for (const sub of inner.split(/[,\s:]/)) {
      const name = sub.split("=")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) set.add(name);
    }
  }
}

/**
 * Heuristic to pick a repoPath for a new file: look at existing map entries and
 * find the one whose filename shares the longest prefix; use that entry's directory.
 * Falls back to `frontend/src/auto-imported/`.
 */
function inferRepoPath(fileName, map) {
  let best = null;
  let bestLen = 0;
  for (const [, entry] of Object.entries(map)) {
    const otherName = path.basename(entry.repoPath);
    let prefix = 0;
    while (
      prefix < fileName.length &&
      prefix < otherName.length &&
      fileName[prefix] === otherName[prefix]
    ) prefix++;
    if (prefix > bestLen && prefix >= 3) {
      bestLen = prefix;
      best = entry;
    }
  }
  if (best) {
    return path.join(path.dirname(best.repoPath), fileName);
  }
  return path.join("frontend/src/auto-imported", fileName);
}

/**
 * Write the component-map back to disk preserving custom fields.
 * Only `cdPath`, `repoPath`, `exports`, `dependsOn` may be overwritten by cd-pull;
 * everything else (protected, protectedReason, notes, etc.) is preserved.
 */
function saveMap(map) {
  const SYSTEM_FIELDS = new Set(["cdPath", "repoPath", "exports", "dependsOn"]);
  const raw = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
  for (const [key, entry] of Object.entries(map)) {
    const existing = raw[key] || {};
    const merged = { ...existing };
    for (const [k, v] of Object.entries(entry)) {
      if (SYSTEM_FIELDS.has(k) || !(k in existing)) merged[k] = v;
    }
    raw[key] = merged;
  }
  fs.writeFileSync(MAP_PATH, JSON.stringify(raw, null, 2) + "\n");
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
 *
 * Strategy (hardened, v2):
 *   - Auto-detect exports from the trailing `Object.assign(window, {...})` block.
 *     This is the source-of-truth; the component-map's `exports` field is used
 *     only as a fallback when the block is missing.
 *   - Auto-reconcile imports: after the export pass, find all identifiers used
 *     but not defined or imported, look them up in the global export catalog,
 *     and auto-add imports. This makes stale `dependsOn` self-correcting.
 */
function windowGlobalsToEsm(code, entry, map, exportLookup) {
  const lines = code.split("\n");
  const output = [];
  const reactHooks = [];
  let usesReactDefault = false;

  // Parse the code to extract React hooks and strip CD-specific patterns.
  // The Object.assign block can span multiple lines; we strip the entire block.
  let inObjectAssign = false;
  let objAssignDepth = 0;
  for (const line of lines) {
    const trimmed = line.trim();

    // Capture and strip `const { useState, ... } = React;`
    const hooksMatch = trimmed.match(/^const\s*\{\s*([^}]+)\}\s*=\s*React\s*;/);
    if (hooksMatch) {
      reactHooks.push(...hooksMatch[1].split(",").map(s => s.trim()).filter(Boolean));
      continue;
    }

    // Strip multi-line `Object.assign(window, { ... });`
    if (!inObjectAssign && /^Object\.assign\s*\(\s*window\s*,/.test(trimmed)) {
      inObjectAssign = true;
      objAssignDepth = (line.match(/[{(]/g) || []).length - (line.match(/[})]/g) || []).length;
      if (objAssignDepth <= 0) inObjectAssign = false;
      continue;
    }
    if (inObjectAssign) {
      objAssignDepth += (line.match(/[{(]/g) || []).length - (line.match(/[})]/g) || []).length;
      if (objAssignDepth <= 0) inObjectAssign = false;
      continue;
    }

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

  // ─── Determine export list (auto-detect from Object.assign, fallback to map) ───
  const autoExports = extractObjectAssignExports(code);
  const exportNames = new Set(autoExports || entry.exports || []);

  // ─── Build initial imports ───
  const imports = [];
  const alreadyImported = new Set();

  // React imports
  if (usesReactDefault && reactHooks.length > 0) {
    imports.push(`import React, { ${reactHooks.join(", ")} } from "react";`);
  } else if (usesReactDefault) {
    imports.push(`import React from "react";`);
  } else if (reactHooks.length > 0) {
    imports.push(`import { ${reactHooks.join(", ")} } from "react";`);
  }
  if (usesReactDefault) alreadyImported.add("React");
  for (const h of reactHooks) alreadyImported.add(h);

  // ─── Auto-reconcile component imports via identifier scanning ───
  // (This replaces the brittle "trust dependsOn blindly" approach.)
  const refs = extractReferencedIdentifiers(codeStr);
  const localDefs = extractLocalDefinitions(codeStr);

  // Group needed imports by source file
  const importsBySource = new Map(); // repoPath -> Set<name>
  for (const ref of refs) {
    if (alreadyImported.has(ref)) continue;
    if (localDefs.has(ref)) continue;
    if (exportNames.has(ref)) continue; // own export
    const sourcePath = exportLookup[ref];
    if (!sourcePath || sourcePath === entry.repoPath) continue;
    if (!importsBySource.has(sourcePath)) importsBySource.set(sourcePath, new Set());
    importsBySource.get(sourcePath).add(ref);
  }
  for (const [sourcePath, names] of importsBySource) {
    const rel = relPath(entry.repoPath, sourcePath);
    imports.push(`import { ${[...names].sort().join(", ")} } from "${rel}";`);
    for (const n of names) alreadyImported.add(n);
  }

  // Add `export` before exported declarations
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

  // If any export wasn't matched by the declaration regexes above (e.g., destructured
  // function calls or values defined elsewhere), emit a trailing `export { ... }`
  // block so the build doesn't break.
  const declaredExportNames = new Set();
  for (const line of transformed) {
    const m = line.match(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/);
    if (m) declaredExportNames.add(m[1]);
  }
  const trailingExports = [...exportNames].filter(n => !declaredExportNames.has(n) && localDefs.has(n));
  if (trailingExports.length > 0) {
    transformed.push("");
    transformed.push(`export { ${trailingExports.join(", ")} };`);
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

  console.log(`\ncd-pull: importing from ${cdDir}`);
  console.log(`Found ${Object.keys(cdFiles).length} files in CD export\n`);

  // ── Auto-map: discover unmapped .jsx/.js files and create entries ──
  const mappedCDNames = new Set(Object.values(map).map(e => path.basename(e.cdPath)));
  const autoMapped = [];
  const knownNonComponent = new Set(["colors_and_type.css"]);
  for (const [fileName, filePath] of Object.entries(cdFiles)) {
    if (!fileName.endsWith(".jsx") && !fileName.endsWith(".js")) continue;
    if (mappedCDNames.has(fileName)) continue;
    if (knownNonComponent.has(fileName)) continue;
    if (fileName.startsWith("Mission Control") || fileName === "index.html") continue;
    const code = fs.readFileSync(filePath, "utf8");
    const exports = extractObjectAssignExports(code);
    if (!exports || exports.length === 0) continue; // not a component file
    const repoPath = inferRepoPath(fileName, map);
    const cdPath = path.relative(cdDir, filePath);
    const mapKey = fileName;
    map[mapKey] = {
      cdPath,
      repoPath,
      exports,
      dependsOn: {}, // imports will be auto-resolved via identifier scanning
    };
    autoMapped.push({ mapKey, repoPath, exports });
  }

  // Refresh exports list for already-mapped files (auto-detect from Object.assign).
  // Preserves all custom fields including `protected` per saveMap()'s logic.
  for (const [mapKey, entry] of Object.entries(map)) {
    const cdFileName = path.basename(entry.cdPath);
    const cdFile = cdFiles[cdFileName];
    if (!cdFile) continue;
    const code = fs.readFileSync(cdFile, "utf8");
    const detected = extractObjectAssignExports(code);
    if (detected && detected.length > 0) {
      const before = JSON.stringify(entry.exports || []);
      const after = JSON.stringify(detected);
      if (before !== after) entry.exports = detected;
    }
  }

  // Build the export lookup AFTER auto-mapping so new files contribute their exports.
  const exportLookup = buildExportLookup(map);

  const changes = [];
  const skipped = [];
  const unmapped = [];
  const protected_ = [];

  // ── Snapshot machinery for build-verify rollback ──
  const writeSnapshot = new Map(); // absPath -> originalContent (null if didn't exist)
  function writeFileSnapshotted(absPath, content) {
    if (!writeSnapshot.has(absPath)) {
      writeSnapshot.set(absPath, fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : null);
    }
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }
  function restoreAllSnapshotted() {
    for (const [absPath, original] of writeSnapshot.entries()) {
      if (original === null) {
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      } else {
        fs.writeFileSync(absPath, original);
      }
    }
  }

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
      writeFileSnapshotted(incomingPath, esmCode);
      protected_.push({ file: entry.repoPath, incoming: incomingPath, reason: entry.protectedReason || "has backend wiring" });
      continue;
    }

    writeFileSnapshotted(repoFile, esmCode);
    changes.push(`${existed ? "Updated" : "Added"}: ${entry.repoPath}  (from ${entry.cdPath})`);
  }

  // Handle CSS
  const cssFile = cdFiles["colors_and_type.css"];
  if (cssFile) {
    const dest = path.join(REPO_ROOT, "frontend/src/design-system/tokens.css");
    if (!filesEqual(cssFile, dest)) {
      writeFileSnapshotted(dest, fs.readFileSync(cssFile, "utf8"));
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
      // Snapshot tokens.css before mergeCSS rewrites it, so rollback works.
      const tokensPathAbs = path.join(REPO_ROOT, "frontend/src/design-system/tokens.css");
      if (!writeSnapshot.has(tokensPathAbs)) {
        writeSnapshot.set(tokensPathAbs, fs.existsSync(tokensPathAbs) ? fs.readFileSync(tokensPathAbs, "utf8") : null);
      }
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

  // Find truly unmapped component files (files we couldn't auto-map either)
  const mappedCDNamesNow = new Set(Object.values(map).map(e => path.basename(e.cdPath)));
  const knownSpecial = new Set(["colors_and_type.css", ...htmlVersions]);
  for (const f of Object.keys(cdFiles)) {
    if (!mappedCDNamesNow.has(f) && !knownSpecial.has(f) && (f.endsWith(".jsx") || f.endsWith(".js"))) {
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

  if (autoMapped.length > 0) {
    console.log("========================================");
    console.log("  AUTO-MAPPED NEW FILES");
    console.log("========================================\n");
    console.log("These files were not in component-map.json — cd-pull added them automatically:\n");
    for (const a of autoMapped) {
      console.log(`  ${a.mapKey}  →  ${a.repoPath}  (exports: ${a.exports.slice(0, 4).join(", ")}${a.exports.length > 4 ? ", …" : ""})`);
    }
    console.log("");
  }

  if (unmapped.length > 0) {
    console.log(`${unmapped.length} unmapped file(s) — no Object.assign(window,...) block found, manual mapping needed:\n`);
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

  // Persist component-map (preserves protected/custom fields per saveMap()'s allow-list).
  // Snapshot the map file first so it also rolls back on build failure.
  if (!writeSnapshot.has(MAP_PATH)) {
    writeSnapshot.set(MAP_PATH, fs.existsSync(MAP_PATH) ? fs.readFileSync(MAP_PATH, "utf8") : null);
  }
  saveMap(map);

  // ── Build-verify with rollback ──
  const skipBuildVerify = process.argv.includes("--no-build-verify");
  if (!skipBuildVerify && writeSnapshot.size > 0) {
    console.log("Verifying Vite build...");
    try {
      execSync("npx vite build", { cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8" });
      console.log("Build verified ✓\n");
    } catch (err) {
      const stderr = (err.stdout || "") + "\n" + (err.stderr || "");
      console.error("\n========================================");
      console.error("  BUILD FAILED — rolling back cd-pull writes");
      console.error("========================================\n");
      console.error(stderr.split("\n").slice(-30).join("\n"));
      restoreAllSnapshotted();
      console.error("\nRepo restored to pre-pull state. The CD export is preserved in .cd-import-tmp/");
      console.error("for inspection. Re-run with --no-build-verify to skip rollback.\n");
      process.exit(1);
    }
  }

  // Cleanup temp dir
  const tmpDir = path.join(REPO_ROOT, ".cd-import-tmp");
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });

  console.log("Done. Run `git diff` to review changes before committing.\n");
}

main();

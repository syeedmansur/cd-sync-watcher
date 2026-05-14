#!/usr/bin/env node
// Auto-increment version and log to Supabase changelog
// Usage: node src/version-bump.js <patch|minor|major> "description"

const fs = require("fs");
const path = require("path");
const { logChangelog } = require("./supabase-client");

const VERSION_FILE = path.resolve(__dirname, "..", "version.json");

function bump(type) {
  const pkg = JSON.parse(fs.readFileSync(VERSION_FILE, "utf8"));
  const [major, minor, patch] = pkg.version.split(".").map(Number);

  switch (type) {
    case "major":
      pkg.version = `${major + 1}.0.0`;
      break;
    case "minor":
      pkg.version = `${major}.${minor + 1}.0`;
      break;
    case "patch":
      pkg.version = `${major}.${minor}.${patch + 1}`;
      break;
    default:
      console.error(`Unknown bump type: ${type}. Use patch, minor, or major.`);
      process.exit(1);
  }

  pkg.build = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(VERSION_FILE, JSON.stringify(pkg, null, 2) + "\n");
  return pkg.version;
}

async function main() {
  const [, , type, description] = process.argv;

  if (!type || !description) {
    console.log("Usage: node src/version-bump.js <patch|minor|major> \"description\"");
    console.log("  patch: script-only changes (bug fixes, detection patterns)");
    console.log("  minor: memory/protocol updates (SYNC-GUIDE, workflow steps)");
    console.log("  major: both scripts AND memory/protocol changed");
    process.exit(1);
  }

  const newVersion = bump(type);
  console.log(`Bumped to v${newVersion} (${type})`);

  await logChangelog(newVersion, type, description);
  console.log(`Logged to changelog: "${description}"`);
}

main().catch(console.error);

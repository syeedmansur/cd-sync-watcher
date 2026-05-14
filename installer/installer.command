#!/bin/bash
# ============================================================
#  CD Sync Watcher — Installer
#  Double-click this file in Finder to install.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_DIR="$SCRIPT_DIR/CDSyncWatcher"
TOOLS_SRC="$BUNDLE_DIR/tools"
APP_SRC="$BUNDLE_DIR/CDSyncMenu.app"
VERSION=$(python3 -c "import json; print(json.load(open('$TOOLS_SRC/version.json'))['version'])" 2>/dev/null || echo "?.?.?")

# --- Target paths ---
REPO_DIR="$HOME/glyne_repo/PMProSmartPosProto"
TOOLS_DST="$REPO_DIR/tools"
APP_DST="/Applications/CDSyncMenu.app"
PLIST_LABEL="com.pmpro.cd-sync-watcher"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_PATH="$REPO_DIR/.cd-sync.log"

# Find node
NODE_BIN="/opt/homebrew/bin/node"
if [ ! -x "$NODE_BIN" ]; then
    NODE_BIN="$(which node 2>/dev/null || true)"
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

clear
echo ""
echo -e "${BLUE}${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}${BOLD}║  CD Sync Watcher v${VERSION} — Installer            ║${NC}"
echo -e "${BLUE}${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# --- Preflight checks ---
ERRORS=0

if [ ! -d "$BUNDLE_DIR" ]; then
    echo -e "${RED}✗ CDSyncWatcher bundle not found next to this script${NC}"
    ERRORS=1
fi

if [ ! -d "$REPO_DIR" ]; then
    echo -e "${RED}✗ Repo not found at $REPO_DIR${NC}"
    echo "  Clone PMProSmartPosProto to ~/glyne_repo/ first."
    ERRORS=1
else
    echo -e "${GREEN}✓${NC} Repo found at ${BLUE}$REPO_DIR${NC}"
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo -e "${RED}✗ Node.js not found — install it first${NC}"
    ERRORS=1
else
    NODE_VERSION=$("$NODE_BIN" --version 2>/dev/null || echo "unknown")
    echo -e "${GREEN}✓${NC} Node.js $NODE_VERSION at ${BLUE}$NODE_BIN${NC}"
fi

if [ "$ERRORS" -gt 0 ]; then
    echo ""
    echo -e "${RED}Fix the errors above before installing.${NC}"
    echo "Press any key to close..."
    read -n 1
    exit 1
fi

# Check existing version
CURRENT_VERSION="none"
if [ -f "$TOOLS_DST/version.json" ]; then
    CURRENT_VERSION=$(python3 -c "import json; print(json.load(open('$TOOLS_DST/version.json'))['version'])" 2>/dev/null || echo "unknown")
fi
echo ""
echo -e "  Current version: ${YELLOW}${CURRENT_VERSION}${NC}"
echo -e "  New version:     ${GREEN}${VERSION}${NC}"
echo ""

echo -e "${BOLD}This will:${NC}"
echo "  1. Stop any running watcher and menu bar app"
echo "  2. Remove old CDSyncMenu.app from /Applications"
echo "  3. Install new app + tools (overwrites existing tools)"
echo "  4. Start the LaunchAgent (auto-starts on login)"
echo "  5. Launch the menu bar app"
echo ""
read -p "Proceed? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
fi

echo ""

# === Step 1: Stop running processes ===
echo -e "${YELLOW}[1/5] Stopping running processes...${NC}"

if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    echo "  ✓ Unloaded LaunchAgent"
else
    echo "  - LaunchAgent not loaded (OK)"
fi

if pgrep -x CDSyncMenu >/dev/null 2>&1; then
    killall CDSyncMenu 2>/dev/null || true
    sleep 0.5
    echo "  ✓ Killed CDSyncMenu"
else
    echo "  - CDSyncMenu not running (OK)"
fi

WATCHER_PIDS=$(pgrep -f "cd-sync.js watch" 2>/dev/null || true)
if [ -n "$WATCHER_PIDS" ]; then
    echo "$WATCHER_PIDS" | xargs kill 2>/dev/null || true
    sleep 0.5
    echo "  ✓ Killed watcher process(es)"
else
    echo "  - No watcher processes (OK)"
fi

# === Step 2: Remove old app ===
echo -e "${YELLOW}[2/5] Removing old installation...${NC}"

if [ -d "$APP_DST" ]; then
    rm -rf "$APP_DST"
    echo "  ✓ Removed $APP_DST"
else
    echo "  - No old app found (OK)"
fi

# === Step 3: Install new files ===
echo -e "${YELLOW}[3/5] Installing new files...${NC}"

cp -R "$APP_SRC" "$APP_DST"
echo "  ✓ Installed CDSyncMenu.app → /Applications"

INSTALLED=0
for f in cd-sync.js cd-pull.js cd-push.js component-map.json SYNC-GUIDE.md version.json; do
    if [ -f "$TOOLS_SRC/$f" ]; then
        cp "$TOOLS_SRC/$f" "$TOOLS_DST/$f"
        INSTALLED=$((INSTALLED + 1))
    fi
done
chmod +x "$TOOLS_DST/cd-sync.js" "$TOOLS_DST/cd-pull.js" "$TOOLS_DST/cd-push.js" 2>/dev/null || true
echo "  ✓ Installed $INSTALLED tool files → $TOOLS_DST"

# === Step 4: Create and load LaunchAgent ===
echo -e "${YELLOW}[4/5] Configuring LaunchAgent...${NC}"

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_PATH" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${TOOLS_DST}/cd-sync.js</string>
        <string>watch</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_PATH}</string>
    <key>WorkingDirectory</key>
    <string>${REPO_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
</dict>
</plist>
PLIST_EOF

launchctl load "$PLIST_PATH"
echo "  ✓ LaunchAgent loaded (auto-starts on login)"

sleep 1
if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
    echo -e "  ${GREEN}✓ Watcher is running${NC}"
else
    echo -e "  ${RED}✗ LaunchAgent may not have started — check: launchctl list | grep pmpro${NC}"
fi

# === Step 5: Launch menu bar app ===
echo -e "${YELLOW}[5/5] Launching menu bar app...${NC}"

open "$APP_DST"
sleep 1

if pgrep -x CDSyncMenu >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓ Menu bar app running — look for the eye icon${NC}"
else
    echo -e "  ${YELLOW}⏳ App may still be starting...${NC}"
fi

# === Done ===
echo ""
echo -e "${GREEN}${BOLD}══════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  ✓ CD Sync Watcher v${VERSION} installed!${NC}"
echo -e "${GREEN}${BOLD}══════════════════════════════════════════════${NC}"
echo ""
echo "  Menu bar:  Eye icon in your menu bar (click for options)"
echo "  Watching:  ~/Downloads for CD zip exports"
echo "  Log:       $LOG_PATH"
echo "  Guide:     $TOOLS_DST/SYNC-GUIDE.md"
echo ""
echo "  Workflow:"
echo "    1. Export zip from Claude Design"
echo "    2. Watcher auto-converts and build-verifies"
echo '    3. Say "CD sync landed" in Claude Code'
echo "    4. Claude Code reviews, commits, pushes, deploys"
echo ""
echo "Press any key to close..."
read -n 1

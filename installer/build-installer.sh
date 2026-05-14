#!/bin/bash
# Build a self-contained installer for CD Sync Watcher
# Output: ~/Downloads/Install-CDSyncWatcher-<version>.command
# Teammates double-click this ONE file — no DMG, no drag-and-drop.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS_DIR="$REPO_DIR/tools"
VERSION=$(python3 -c "import json; print(json.load(open('$TOOLS_DIR/version.json'))['version'])")
OUT_FILE="$HOME/Downloads/Install-CDSyncWatcher-${VERSION}.command"

echo "Building CD Sync Watcher v${VERSION} self-contained installer..."

# Step 1: Compile menu bar app
echo "[1/3] Compiling menu bar app..."
bash "$TOOLS_DIR/menu-app-src/build.sh"
APP_DIR="$TOOLS_DIR/menu-app-src/build/CDSyncMenu.app"

if [ ! -d "$APP_DIR" ]; then
    echo "ERROR: App build failed"
    exit 1
fi

# Step 2: Create base64-encoded payload of the app binary
echo "[2/3] Encoding payload..."
APP_BINARY="$APP_DIR/Contents/MacOS/CDSyncMenu"
APP_B64=$(base64 < "$APP_BINARY")

# Step 3: Generate the self-contained installer script
echo "[3/3] Generating installer..."

cat > "$OUT_FILE" << 'HEADER_EOF'
#!/bin/bash
# ============================================================
#  CD Sync Watcher — Self-Contained Installer
#  Just double-click this file. That's it.
# ============================================================

set -euo pipefail
HEADER_EOF

# Inject version
echo "VERSION=\"${VERSION}\"" >> "$OUT_FILE"
echo "BUILD_DATE=\"$(date +%Y-%m-%d)\"" >> "$OUT_FILE"

cat >> "$OUT_FILE" << 'BODY_EOF'

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
DIM='\033[2m'
NC='\033[0m'

clear
echo ""
echo -e "${BLUE}${BOLD}  ╔══════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}${BOLD}  ║                                              ║${NC}"
echo -e "${BLUE}${BOLD}  ║   CD Sync Watcher  v${VERSION}                     ║${NC}"
echo -e "${BLUE}${BOLD}  ║   Claude Design ↔ Claude Code Pipeline       ║${NC}"
echo -e "${BLUE}${BOLD}  ║                                              ║${NC}"
echo -e "${BLUE}${BOLD}  ╚══════════════════════════════════════════════╝${NC}"
echo ""

# --- Preflight ---
ERRORS=0

if [ ! -d "$REPO_DIR" ]; then
    echo -e "  ${RED}✗${NC} Repo not found at $REPO_DIR"
    echo -e "    ${DIM}Clone PMProSmartPosProto to ~/glyne_repo/ first.${NC}"
    ERRORS=1
else
    echo -e "  ${GREEN}✓${NC} Repo: ${DIM}$REPO_DIR${NC}"
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo -e "  ${RED}✗${NC} Node.js not found"
    echo -e "    ${DIM}Install Node.js first: https://nodejs.org${NC}"
    ERRORS=1
else
    NODE_V=$("$NODE_BIN" --version 2>/dev/null || echo "?")
    echo -e "  ${GREEN}✓${NC} Node: ${DIM}$NODE_V${NC}"
fi

if [ "$ERRORS" -gt 0 ]; then
    echo ""
    echo -e "  ${RED}Fix the errors above before installing.${NC}"
    echo ""
    echo "Press any key to close..."
    read -n 1
    exit 1
fi

CURRENT="none"
if [ -f "$TOOLS_DST/version.json" ]; then
    CURRENT=$(python3 -c "import json; print(json.load(open('$TOOLS_DST/version.json'))['version'])" 2>/dev/null || echo "?")
fi

echo ""
if [ "$CURRENT" = "$VERSION" ]; then
    echo -e "  ${YELLOW}Reinstalling v${VERSION}${NC}"
elif [ "$CURRENT" = "none" ]; then
    echo -e "  ${GREEN}Fresh install → v${VERSION}${NC}"
else
    echo -e "  ${YELLOW}Upgrading: v${CURRENT} → v${VERSION}${NC}"
fi

echo ""
echo -e "  ${BOLD}What this does:${NC}"
echo "    • Stops any running watcher"
echo "    • Installs menu bar app to /Applications"
echo "    • Updates sync tools in your repo"
echo "    • Starts watcher (auto-starts on login)"
echo ""
read -p "  Install? [Y/n] " confirm
confirm=${confirm:-Y}
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "  Cancelled."
    exit 0
fi

echo ""

# === Step 1: Stop ===
echo -e "  ${YELLOW}Stopping old watcher...${NC}"
launchctl unload "$PLIST_PATH" 2>/dev/null || true
killall CDSyncMenu 2>/dev/null || true
PIDS=$(pgrep -f "cd-sync.js watch" 2>/dev/null || true)
[ -n "$PIDS" ] && echo "$PIDS" | xargs kill 2>/dev/null || true
sleep 0.5

# === Step 2: Remove old app ===
rm -rf "$APP_DST"

# === Step 3: Install app ===
echo -e "  ${YELLOW}Installing app...${NC}"
mkdir -p "$APP_DST/Contents/MacOS"

# Decode embedded binary
BODY_EOF

# Inject the base64 payload
echo "base64 -d << 'B64_EOF' > \"\$APP_DST/Contents/MacOS/CDSyncMenu\"" >> "$OUT_FILE"
echo "$APP_B64" >> "$OUT_FILE"
echo "B64_EOF" >> "$OUT_FILE"

cat >> "$OUT_FILE" << PLIST_INJECT
chmod +x "\$APP_DST/Contents/MacOS/CDSyncMenu"

cat > "\$APP_DST/Contents/Info.plist" << 'IPEOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>CD Sync Menu</string>
    <key>CFBundleIdentifier</key>
    <string>com.pmpro.cd-sync-menu</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleExecutable</key>
    <string>CDSyncMenu</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
</dict>
</plist>
IPEOF

PLIST_INJECT

cat >> "$OUT_FILE" << 'TAIL_EOF'

# === Step 4: Update tools ===
echo -e "  ${YELLOW}Updating sync tools...${NC}"

# Write version.json
TAIL_EOF

# Inject version.json content
echo "cat > \"\$TOOLS_DST/version.json\" << 'VJEOF'" >> "$OUT_FILE"
cat "$TOOLS_DIR/version.json" >> "$OUT_FILE"
echo "VJEOF" >> "$OUT_FILE"
echo "" >> "$OUT_FILE"

# Inject each tool file
for f in cd-sync.js cd-pull.js cd-push.js SYNC-GUIDE.md; do
    echo "# --- $f ---" >> "$OUT_FILE"
    echo "cat > \"\$TOOLS_DST/$f\" << 'TOOLEOF_${f//[.-]/_}'" >> "$OUT_FILE"
    cat "$TOOLS_DIR/$f" >> "$OUT_FILE"
    echo "" >> "$OUT_FILE"
    echo "TOOLEOF_${f//[.-]/_}" >> "$OUT_FILE"
    echo "" >> "$OUT_FILE"
done

# component-map.json needs special handling (contains single quotes)
echo "python3 -c \"" >> "$OUT_FILE"
echo "import base64, sys" >> "$OUT_FILE"
echo "data = base64.b64decode('$(base64 < "$TOOLS_DIR/component-map.json")')" >> "$OUT_FILE"
echo "with open('$' + 'TOOLS_DST/component-map.json', 'wb') as f: f.write(data)" >> "$OUT_FILE"
echo "\"" >> "$OUT_FILE"

cat >> "$OUT_FILE" << 'FINAL_EOF'

chmod +x "$TOOLS_DST/cd-sync.js" "$TOOLS_DST/cd-pull.js" "$TOOLS_DST/cd-push.js" 2>/dev/null || true

# === Step 5: LaunchAgent ===
echo -e "  ${YELLOW}Configuring watcher service...${NC}"
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_PATH" << LAEOF
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
LAEOF

launchctl load "$PLIST_PATH"

# === Step 6: Launch app ===
echo -e "  ${YELLOW}Starting menu bar app...${NC}"
open "$APP_DST"
sleep 1.5

# === Verify ===
echo ""
ALL_OK=true
if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
    echo -e "  ${GREEN}✓${NC} Watcher service running"
else
    echo -e "  ${RED}✗${NC} Watcher service not started"
    ALL_OK=false
fi

if pgrep -x CDSyncMenu >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Menu bar app running"
else
    echo -e "  ${YELLOW}⏳${NC} Menu bar app starting..."
fi

echo ""
if $ALL_OK; then
    echo -e "  ${GREEN}${BOLD}✓ CD Sync Watcher v${VERSION} installed!${NC}"
else
    echo -e "  ${YELLOW}Installed with warnings — check above.${NC}"
fi

echo ""
echo -e "  ${DIM}Look for the eye icon (👁) in your menu bar.${NC}"
echo -e "  ${DIM}The watcher monitors ~/Downloads for CD zip exports.${NC}"
echo -e "  ${DIM}Read tools/SYNC-GUIDE.md for the full workflow.${NC}"
echo ""
echo "Press any key to close..."
read -n 1
FINAL_EOF

chmod +x "$OUT_FILE"

# Cleanup
rm -rf "$TOOLS_DIR/menu-app-src/build"

SIZE=$(du -h "$OUT_FILE" | cut -f1 | tr -d ' ')
echo ""
echo "✓ Built: ~/Downloads/Install-CDSyncWatcher-${VERSION}.command ($SIZE)"
echo "  Teammates double-click this file to install. Nothing else needed."

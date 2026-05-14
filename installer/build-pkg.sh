#!/bin/bash
# Build a native macOS .pkg installer for CD Sync Watcher
# Output: ~/Downloads/CDSyncWatcher-<version>.pkg
# Teammates double-click → standard macOS installer GUI → done.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(python3 -c "import json; print(json.load(open('$REPO_DIR/version.json'))['version'])")
PKG_NAME="CDSyncWatcher-${VERSION}.pkg"
BUILD_DIR="/tmp/pkg-build-$$"

echo "Building CD Sync Watcher v${VERSION} .pkg installer..."

# --- Step 1: Compile menu bar app ---
echo "[1/4] Compiling menu bar app..."
bash "$REPO_DIR/menu-app/build.sh"
APP_BUILD="$REPO_DIR/menu-app/build/CDSyncMenu.app"

if [ ! -d "$APP_BUILD" ]; then
    echo "ERROR: App build failed"
    exit 1
fi

# --- Step 2: Stage payload ---
echo "[2/4] Staging payload..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/payload/Applications"
mkdir -p "$BUILD_DIR/payload/tmp/cdsync-tools"
mkdir -p "$BUILD_DIR/scripts"

# App → /Applications
cp -R "$APP_BUILD" "$BUILD_DIR/payload/Applications/CDSyncMenu.app"

# Tools → temp staging (postinstall moves to user home)
for f in cd-sync.js cd-pull.js cd-push.js supabase-client.js; do
    cp "$REPO_DIR/src/$f" "$BUILD_DIR/payload/tmp/cdsync-tools/"
done
cp "$REPO_DIR/config/component-map.json" "$BUILD_DIR/payload/tmp/cdsync-tools/"
cp "$REPO_DIR/docs/SYNC-GUIDE.md" "$BUILD_DIR/payload/tmp/cdsync-tools/"
cp "$REPO_DIR/version.json" "$BUILD_DIR/payload/tmp/cdsync-tools/"

# Include principles docs (for CD and CC to read)
mkdir -p "$BUILD_DIR/payload/tmp/cdsync-cd-handoff"
for f in FRONTEND_PRINCIPLES.md DEV_PRINCIPLES.md; do
    if [ -f "$REPO_DIR/docs/$f" ]; then
        cp "$REPO_DIR/docs/$f" "$BUILD_DIR/payload/tmp/cdsync-cd-handoff/"
    fi
done
chmod +x "$BUILD_DIR/payload/tmp/cdsync-tools/cd-sync.js" \
         "$BUILD_DIR/payload/tmp/cdsync-tools/cd-pull.js" \
         "$BUILD_DIR/payload/tmp/cdsync-tools/cd-push.js"

# --- Step 3: Write postinstall script ---
echo "[3/4] Writing postinstall script..."

cat > "$BUILD_DIR/scripts/postinstall" << 'POSTINSTALL_EOF'
#!/bin/bash

REAL_USER="${SUDO_USER:-$(stat -f '%Su' /dev/console 2>/dev/null || echo "$USER")}"
REAL_HOME=$(eval echo "~$REAL_USER")
REAL_UID=$(id -u "$REAL_USER")
REPO_DIR="$REAL_HOME/glyne_repo/PMProSmartPosProto"
TOOLS_DST="$REPO_DIR/tools"
PLIST_LABEL="com.pmpro.cd-sync-watcher"
PLIST_PATH="$REAL_HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_PATH="$REPO_DIR/.cd-sync.log"
STAGING="/tmp/cdsync-tools"

# Find node
NODE_BIN="/opt/homebrew/bin/node"
if [ ! -x "$NODE_BIN" ]; then
    NODE_BIN="$(which node 2>/dev/null || true)"
fi

# --- Stop old watcher ---
launchctl asuser "$REAL_UID" launchctl unload "$PLIST_PATH" 2>/dev/null || true
killall CDSyncMenu 2>/dev/null || true
PIDS=$(pgrep -f "cd-sync.js watch" 2>/dev/null || true)
[ -n "$PIDS" ] && echo "$PIDS" | xargs kill 2>/dev/null || true
sleep 0.5

# --- Copy tools to repo (if repo exists) ---
if [ -d "$REPO_DIR" ] && [ -d "$STAGING" ]; then
    mkdir -p "$TOOLS_DST"
    cp -f "$STAGING"/* "$TOOLS_DST/"
    chmod +x "$TOOLS_DST/cd-sync.js" "$TOOLS_DST/cd-pull.js" "$TOOLS_DST/cd-push.js" 2>/dev/null || true
fi

# --- Copy frontend principles doc to cd-handoff (for CD to read) ---
HANDOFF_STAGING="/tmp/cdsync-cd-handoff"
HANDOFF_DST="$REPO_DIR/docs/cd-handoff"
if [ -d "$HANDOFF_STAGING" ] && [ -d "$REPO_DIR" ]; then
    mkdir -p "$HANDOFF_DST"
    cp -f "$HANDOFF_STAGING"/* "$HANDOFF_DST/" 2>/dev/null || true
fi
rm -rf "$HANDOFF_STAGING"

# Clean up staging
rm -rf "$STAGING"

# --- Create LaunchAgent (only if node + repo exist) ---
if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] && [ -d "$REPO_DIR" ]; then
    mkdir -p "$REAL_HOME/Library/LaunchAgents"

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

    launchctl asuser "$REAL_UID" launchctl load "$PLIST_PATH" 2>/dev/null || true
fi

# --- Launch menu bar app ---
if [ -d "/Applications/CDSyncMenu.app" ]; then
    sudo -u "$REAL_USER" open "/Applications/CDSyncMenu.app" 2>/dev/null || true
fi

exit 0
POSTINSTALL_EOF

chmod +x "$BUILD_DIR/scripts/postinstall"

# --- Step 4: Build .pkg ---
echo "[4/4] Building .pkg..."
rm -f "$HOME/Downloads/$PKG_NAME"

pkgbuild \
    --root "$BUILD_DIR/payload" \
    --scripts "$BUILD_DIR/scripts" \
    --identifier "com.pmpro.cd-sync-watcher-pkg" \
    --version "$VERSION" \
    --install-location "/" \
    "$HOME/Downloads/$PKG_NAME"

# Cleanup
rm -rf "$BUILD_DIR"
rm -rf "$REPO_DIR/menu-app/build"

SIZE=$(du -h "$HOME/Downloads/$PKG_NAME" | cut -f1 | tr -d ' ')
echo ""
echo "✓ Built: ~/Downloads/$PKG_NAME ($SIZE)"
echo "  Teammates double-click → macOS installer GUI → done."
echo "  First time: right-click → Open (unsigned package)."

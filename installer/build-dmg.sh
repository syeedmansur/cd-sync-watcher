#!/bin/bash
# Build a distributable DMG for CD Sync Watcher
# Usage: ./tools/build-dmg.sh
# Output: ~/Downloads/CDSyncWatcher-<version>.dmg

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS_DIR="$REPO_DIR/tools"
VERSION=$(python3 -c "import json; print(json.load(open('$TOOLS_DIR/version.json'))['version'])")
DMG_NAME="CDSyncWatcher-${VERSION}.dmg"
BUILD_DIR="/tmp/dmg-build-$$"

echo "Building CD Sync Watcher v${VERSION} DMG..."

# Step 1: Build the menu bar app
echo "[1/3] Compiling menu bar app..."
bash "$TOOLS_DIR/menu-app-src/build.sh"
APP_BUILD="$TOOLS_DIR/menu-app-src/build/CDSyncMenu.app"

if [ ! -d "$APP_BUILD" ]; then
    echo "ERROR: App build failed"
    exit 1
fi

# Step 2: Stage DMG contents
echo "[2/3] Staging DMG contents..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/CDSyncWatcher/tools"

cp -R "$APP_BUILD" "$BUILD_DIR/CDSyncWatcher/"
for f in cd-sync.js cd-pull.js cd-push.js component-map.json SYNC-GUIDE.md version.json; do
    cp "$TOOLS_DIR/$f" "$BUILD_DIR/CDSyncWatcher/tools/"
done
chmod +x "$BUILD_DIR/CDSyncWatcher/tools/cd-sync.js" "$BUILD_DIR/CDSyncWatcher/tools/cd-pull.js" "$BUILD_DIR/CDSyncWatcher/tools/cd-push.js"

# Copy installer
cp "$TOOLS_DIR/installer.command" "$BUILD_DIR/Install CD Sync Watcher.command"
chmod +x "$BUILD_DIR/Install CD Sync Watcher.command"

# Step 3: Create DMG
echo "[3/3] Creating DMG..."
rm -f "$HOME/Downloads/$DMG_NAME"
hdiutil create \
    -volname "CD Sync Watcher v${VERSION}" \
    -srcfolder "$BUILD_DIR" \
    -ov -format UDZO \
    "$HOME/Downloads/$DMG_NAME" > /dev/null 2>&1

# Cleanup
rm -rf "$BUILD_DIR"
rm -rf "$TOOLS_DIR/menu-app-src/build"

echo ""
echo "✓ Built: ~/Downloads/$DMG_NAME"
echo "  Share this file with teammates."

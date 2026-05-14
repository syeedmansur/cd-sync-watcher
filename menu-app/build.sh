#!/bin/bash
# Build the CDSyncMenu.app menu bar app
# Requires Xcode Command Line Tools (swiftc)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/build"
APP_DIR="$OUT_DIR/CDSyncMenu.app/Contents"

rm -rf "$OUT_DIR"
mkdir -p "$APP_DIR/MacOS"

echo "Compiling CDSyncMenu..."
swiftc -O -target arm64-apple-macosx13.0 -framework Cocoa \
    -o "$APP_DIR/MacOS/CDSyncMenu" \
    "$SCRIPT_DIR/CDSyncMenu.swift"

VERSION=$(python3 -c "import json; print(json.load(open('$SCRIPT_DIR/../version.json'))['version'])" 2>/dev/null || echo "0.0.0")

cat > "$APP_DIR/Info.plist" << EOF
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
EOF

echo "Built: $OUT_DIR/CDSyncMenu.app (v$VERSION)"

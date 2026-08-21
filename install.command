#!/bin/bash
# Plexlytics installer -- installs the same way Tautulli's own macOS .pkg
# does: app code lives inside Plexlytics.app in /Applications, while the
# database and logs live in the standard per-user location for application
# data (~/Library/Application Support/Plexlytics/), same as Tautulli's own
# ~/Library/Application Support/Tautulli/. That split matters because
# /Applications is expected to be replaceable at any time (an update,
# a reinstall) without losing anything -- so nothing this app *writes* at
# runtime lives there.
#
# Safe to run more than once, including to pick up an update: existing data
# is never touched, an existing venv is reused rather than rebuilt, and any
# database from the old app-folder-based layout is migrated automatically
# by the app itself the first time it starts against the new location (see
# models.py's _migrate_legacy_database).
#
# This is meant to be double-clicked in Finder (that's what the .command
# extension is for -- it opens Terminal and runs this automatically), or
# run directly with `bash install.command`.
set -e
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Plexlytics Installer ==="

# ---------------------------------------------------------------------------
# 1. Where things go
# ---------------------------------------------------------------------------
if [ -w "/Applications" ]; then
  APP_BUNDLE="/Applications/Plexlytics.app"
else
  mkdir -p "$HOME/Applications"
  APP_BUNDLE="$HOME/Applications/Plexlytics.app"
fi
RESOURCES_DIR="$APP_BUNDLE/Contents/Resources"
APP_SUPPORT_DIR="$HOME/Library/Application Support/Plexlytics"
LOGS_DIR="$APP_SUPPORT_DIR/logs"

echo "App code:  $RESOURCES_DIR"
echo "App data:  $APP_SUPPORT_DIR"
echo ""

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python isn't installed. Get it from https://www.python.org/downloads/ and run this again."
  exit 1
fi

mkdir -p "$APP_SUPPORT_DIR" "$LOGS_DIR"

# ---------------------------------------------------------------------------
# 2. Install app code into the bundle. rsync merges into any existing
# Resources dir rather than wiping it first -- an existing venv (which is
# never part of the source zip, only ever created by this script) is left
# alone, so re-running this to pick up an update doesn't force a slow full
# dependency reinstall every time.
# ---------------------------------------------------------------------------
echo "Installing app files..."
mkdir -p "$RESOURCES_DIR"
rsync -a \
  --exclude 'Plexlytics.app' \
  --exclude 'Plexlytics.iconset' \
  --exclude 'app-icon-1024.png' \
  --exclude 'install.command' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '.git' \
  "$SOURCE_DIR"/ "$RESOURCES_DIR"/

cd "$RESOURCES_DIR"

# ---------------------------------------------------------------------------
# 3. Python virtual environment + dependencies
# ---------------------------------------------------------------------------
if [ ! -d "venv" ]; then
  echo "Creating Python environment..."
  python3 -m venv venv
else
  echo "Python environment already exists, skipping."
fi

source venv/bin/activate

echo "Installing dependencies (this can take a minute)..."
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

# ---------------------------------------------------------------------------
# 4. Chart library
# ---------------------------------------------------------------------------
if [ ! -f "static/js/vendor/chart.umd.min.js" ]; then
  echo "Downloading chart library..."
  mkdir -p static/js/vendor
  curl -s -o static/js/vendor/chart.umd.min.js https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.0/chart.umd.min.js
else
  echo "Chart library already present, skipping."
fi

# If the menu bar icon was set up before (its plist already exists), that's
# a real signal someone opted into that feature -- but its dependencies
# (rumps/pyobjc) live in this venv, not in the plist, so recreating the
# venv from scratch would silently lose them with nothing telling you why
# the icon stopped appearing. Catch that here rather than leaving it a
# silent, confusing failure discoverable only by reading the logs.
MENUBAR_PLIST=~/Library/LaunchAgents/com.plexstats.menubar.plist
if [ -f "$MENUBAR_PLIST" ] && ! python3 -c "import AppKit" 2>/dev/null; then
  echo "Menu bar icon was set up before -- reinstalling its dependencies..."
  pip install --quiet rumps pyobjc-framework-Cocoa || echo "  (couldn't reinstall automatically -- if the menu bar icon doesn't appear, run: pip install rumps pyobjc-framework-Cocoa)"
fi

# ---------------------------------------------------------------------------
# 5. Main app launchd service. Regenerated every run (not just created
# once) so that anyone upgrading from the old ~/plex-stats-app-based setup
# actually gets pointed at the new in-bundle location -- but RunAtLoad is
# read from the existing plist first and carried over, so this can't
# silently undo someone's own "Launch at Startup: Disabled" choice from
# the Settings page.
# ---------------------------------------------------------------------------
mkdir -p ~/Library/LaunchAgents
APP_PLIST=~/Library/LaunchAgents/com.plexstats.app.plist

APP_RUN_AT_LOAD="true"
if [ -f "$APP_PLIST" ]; then
  APP_RUN_AT_LOAD=$(python3 -c "
import plistlib
try:
    with open('$APP_PLIST', 'rb') as f:
        print('true' if plistlib.load(f).get('RunAtLoad', True) else 'false')
except Exception:
    print('true')
" 2>/dev/null || echo "true")
fi

echo "Setting up the background service..."
RUN_AT_LOAD="$APP_RUN_AT_LOAD" LOGS_DIR="$LOGS_DIR" python3 > "$APP_PLIST" << 'PY'
import os
app_dir = os.getcwd()
logs_dir = os.environ["LOGS_DIR"]
run_at_load = os.environ["RUN_AT_LOAD"]
print(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key><string>com.plexstats.app</string>
<key>ProgramArguments</key>
<array>
<string>{app_dir}/venv/bin/python3</string>
<string>{app_dir}/app.py</string>
</array>
<key>WorkingDirectory</key><string>{app_dir}</string>
<key>RunAtLoad</key><{run_at_load}/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>{logs_dir}/plexstats.log</string>
<key>StandardErrorPath</key><string>{logs_dir}/plexstats.err</string>
</dict>
</plist>""")
PY

plutil -lint "$APP_PLIST" >/dev/null

launchctl bootout "gui/$(id -u)/com.plexstats.app" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$APP_PLIST"
launchctl enable "gui/$(id -u)/com.plexstats.app" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/com.plexstats.app"

# ---------------------------------------------------------------------------
# 6. Menu bar service -- only touched if it's been set up before (see step
# 4). Same regenerate-but-preserve-RunAtLoad treatment as the main app.
# ---------------------------------------------------------------------------
if [ -f "$MENUBAR_PLIST" ]; then
  echo "Updating the menu bar service..."
  MENUBAR_RUN_AT_LOAD=$(python3 -c "
import plistlib
try:
    with open('$MENUBAR_PLIST', 'rb') as f:
        print('true' if plistlib.load(f).get('RunAtLoad') else 'false')
except Exception:
    print('false')
" 2>/dev/null || echo "false")

  RUN_AT_LOAD="$MENUBAR_RUN_AT_LOAD" LOGS_DIR="$LOGS_DIR" python3 > "$MENUBAR_PLIST" << 'PY'
import os
app_dir = os.getcwd()
logs_dir = os.environ["LOGS_DIR"]
run_at_load = os.environ["RUN_AT_LOAD"]
print(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key><string>com.plexstats.menubar</string>
<key>ProgramArguments</key>
<array>
<string>{app_dir}/venv/bin/python3</string>
<string>{app_dir}/menubar.py</string>
</array>
<key>WorkingDirectory</key><string>{app_dir}</string>
<key>RunAtLoad</key><{run_at_load}/>
<key>StandardOutPath</key><string>{logs_dir}/plexstats-menubar.log</string>
<key>StandardErrorPath</key><string>{logs_dir}/plexstats-menubar.err</string>
</dict>
</plist>""")
PY

  plutil -lint "$MENUBAR_PLIST" >/dev/null
  launchctl bootout "gui/$(id -u)/com.plexstats.menubar" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$MENUBAR_PLIST"
  if [ "$MENUBAR_RUN_AT_LOAD" = "true" ]; then
    launchctl kickstart -k "gui/$(id -u)/com.plexstats.menubar"
  fi
fi

# ---------------------------------------------------------------------------
# 7. Build Plexlytics.app's icon and install the finished bundle
# ---------------------------------------------------------------------------
echo "Finishing up the app icon..."

PORT="$(python3 -c "import config; print(config.DASHBOARD_PORT)" 2>/dev/null || echo 5055)"

# The launcher script and Info.plist come from the skeleton bundle in the
# source zip; everything else (app code, venv) is already sitting in
# Contents/Resources from step 2 above, since RESOURCES_DIR points there.
cp "$SOURCE_DIR/Plexlytics.app/Contents/Info.plist" "$APP_BUNDLE/Contents/Info.plist"
cp "$SOURCE_DIR/Plexlytics.app/Contents/MacOS/Plexlytics" "$APP_BUNDLE/Contents/MacOS/Plexlytics"
sed -i '' "s/__PLEXLYTICS_PORT__/${PORT}/" "$APP_BUNDLE/Contents/MacOS/Plexlytics"
chmod +x "$APP_BUNDLE/Contents/MacOS/Plexlytics"

if command -v iconutil >/dev/null 2>&1 && [ -d "$SOURCE_DIR/Plexlytics.iconset" ]; then
  iconutil -c icns "$SOURCE_DIR/Plexlytics.iconset" -o "$RESOURCES_DIR/Plexlytics.icns"
else
  echo "  (skipping custom icon -- iconutil not found; the app will still work, just with a generic icon)"
fi

# Clear macOS's cached "this is unidentified" flag so double-clicking from
# Launchpad doesn't immediately bounce with a Gatekeeper warning before
# you've even had a chance to right-click -> Open it the first time.
xattr -dr com.apple.quarantine "$APP_BUNDLE" 2>/dev/null || true

echo ""
echo "=== Done ==="
echo "Plexlytics is running at http://127.0.0.1:${PORT}"
echo "App: $APP_BUNDLE"
echo "Data: $APP_SUPPORT_DIR"
echo ""
echo "Look for \"Plexlytics\" in Launchpad. The very first time you open it,"
echo "macOS may still say it's from an unidentified developer -- if so,"
echo "right-click (or Control-click) it and choose Open once. After that"
echo "first time, opening it normally will just work."
echo ""
echo "The menu bar icon is a separate, optional step -- see the README's"
echo "\"Menu Bar Icon\" section if you want that too."

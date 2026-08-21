"""Plexlytics menu bar icon -- a small, separate macOS status-bar helper.

This is deliberately its own process/launchd service rather than something
bolted onto app.py: macOS's status-bar APIs (via the `rumps` library, which
wraps AppKit/Cocoa) need to own the main thread of whatever process runs
them, and app.py's own main thread is already busy running the Flask
server's request loop. Running both in one process would mean putting one
of them on a background thread, which AppKit's UI APIs don't reliably
support.

Instead, this talks to the already-running Flask server over local HTTP for
anything that touches shared state (the "Start at Login" checkbox reads/
writes the SAME settings the Settings page's own Launch at Startup control
uses; Restart and Quit call the same endpoints the Settings page's buttons
already call) -- so there's exactly one source of truth for each setting,
not two copies that could drift out of sync.

One-time setup is required before this can run -- see the README's "Menu
Bar Icon" section. Once set up, the Settings > Web Interface page's "Show
Icon in Menu Bar" toggle starts and stops it going forward.
"""
import logging
import os
import plistlib
import webbrowser

from AppKit import NSApplication, NSApplicationActivationPolicyAccessory

import requests
import rumps

import config

# stderr is redirected to /tmp/plexstats-menubar.err by the plist (see the
# README's "Menu Bar Icon" setup) -- logging here, rather than silently
# swallowing failures, is what makes a problem like "Quit doesn't actually
# stop the server" show up somewhere instead of just looking like nothing
# happened.
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] menubar: %(message)s")
log = logging.getLogger(__name__)

API_BASE = f"http://127.0.0.1:{config.DASHBOARD_PORT}"
MENUBAR_LAUNCHD_LABEL = "com.plexstats.menubar"
MENUBAR_PLIST_PATH = os.path.expanduser(f"~/Library/LaunchAgents/{MENUBAR_LAUNCHD_LABEL}.plist")
ICON_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "img", "logo-menubar.png")


def _get_menubar_settings():
    try:
        r = requests.get(f"{API_BASE}/api/settings/menubar", timeout=3)
        if r.status_code != 200:
            log.warning("GET /api/settings/menubar returned %s: %s", r.status_code, r.text[:200])
            return {}
        data = r.json()
        return data.get("settings", {}) if data.get("ok") else {}
    except Exception as e:
        log.warning("Could not reach the app to load menu bar settings: %s", e)
        return {}


def _save_menubar_setting(key, value):
    try:
        r = requests.post(f"{API_BASE}/api/settings/menubar", json={key: value}, timeout=3)
        if r.status_code != 200:
            log.warning("POST /api/settings/menubar returned %s: %s", r.status_code, r.text[:200])
    except Exception as e:
        log.warning("Could not reach the app to save a menu bar setting: %s", e)


def _read_start_at_login():
    """This app's own plist (com.plexstats.menubar.plist), not the main
    server's -- the menu bar icon and the main server are two separate
    launchd services, each with their own independent 'start at login'."""
    if not os.path.exists(MENUBAR_PLIST_PATH):
        return False
    try:
        with open(MENUBAR_PLIST_PATH, "rb") as f:
            return bool(plistlib.load(f).get("RunAtLoad", False))
    except Exception:
        return False


def _write_start_at_login(enabled):
    if not os.path.exists(MENUBAR_PLIST_PATH):
        return
    try:
        with open(MENUBAR_PLIST_PATH, "rb") as f:
            plist = plistlib.load(f)
        plist["RunAtLoad"] = enabled
        with open(MENUBAR_PLIST_PATH, "wb") as f:
            plistlib.dump(plist, f)
    except Exception:
        pass


class PlexlyticsMenuBarApp(rumps.App):
    def __init__(self):
        icon = ICON_PATH if os.path.exists(ICON_PATH) else None
        # template=True lets macOS auto-recolor the icon for the current
        # menu bar (light icon on a dark bar, dark icon on a light bar),
        # the standard look for a menu bar icon rather than a fixed color.
        super().__init__("Plexlytics", icon=icon, template=True, quit_button=None)

        settings = _get_menubar_settings()

        self.start_at_login_item = rumps.MenuItem("Start at Login", callback=self.toggle_start_at_login)
        self.start_at_login_item.state = _read_start_at_login()

        self.open_browser_item = rumps.MenuItem(
            "Open Browser when Plexlytics Starts", callback=self.toggle_open_browser
        )
        self.open_browser_item.state = bool(settings.get("open_browser_on_start", False))

        self.menu = [
            rumps.MenuItem("Open Plexlytics", callback=self.open_app),
            self.start_at_login_item,
            self.open_browser_item,
            None,  # separator
            rumps.MenuItem("Restart", callback=self.restart_app),
            rumps.MenuItem("Quit", callback=self.quit_app),
        ]

        if self.open_browser_item.state:
            webbrowser.open(API_BASE)

    def open_app(self, _sender):
        webbrowser.open(API_BASE)

    def toggle_start_at_login(self, sender):
        sender.state = not sender.state
        _write_start_at_login(bool(sender.state))

    def toggle_open_browser(self, sender):
        sender.state = not sender.state
        _save_menubar_setting("open_browser_on_start", bool(sender.state))

    def restart_app(self, _sender):
        rumps.notification("Plexlytics", "", "Restarting the app…")
        try:
            r = requests.post(f"{API_BASE}/api/system/restart", timeout=3)
            if r.status_code != 200:
                log.warning("Restart request returned %s: %s", r.status_code, r.text[:200])
        except Exception as e:
            log.warning("Could not reach the app to restart it: %s", e)

    def quit_app(self, _sender):
        # Quitting fully stops the app (server included), same as the
        # Settings page's own Shutdown button -- not just this menu bar
        # icon. It doesn't change the "Start at Login" checkboxes for
        # either service, matching how quitting a normal Mac app doesn't
        # silently turn off its own "Open at Login" setting.
        try:
            r = requests.post(f"{API_BASE}/api/system/shutdown", timeout=3)
            if r.status_code != 200:
                log.warning("Shutdown request returned %s: %s", r.status_code, r.text[:200])
        except Exception as e:
            log.warning("Could not reach the app to shut it down: %s", e)
        rumps.quit_application()


if __name__ == "__main__":
    app = PlexlyticsMenuBarApp()
    # Without this, macOS treats this as a regular foreground app -- a
    # bouncing Python icon in the Dock and an entry in Cmd+Tab, neither of
    # which makes sense for something that's supposed to live quietly in
    # the menu bar. Bundled .app packages solve this via an LSUIElement key
    # in their Info.plist, but this runs as a plain script with no bundle
    # of its own, so it's set here in code instead, right after the
    # underlying NSApplication exists (created when PlexlyticsMenuBarApp()
    # was constructed above) but before the event loop starts.
    NSApplication.sharedApplication().setActivationPolicy_(NSApplicationActivationPolicyAccessory)
    app.run()

import os
from dotenv import load_dotenv

load_dotenv()

PLEX_BASE_URL = os.getenv("PLEX_BASE_URL", "http://127.0.0.1:32400")
# Optional fallback -- the normal path is logging in via the web UI's /login
# page, which stores its own token in the database. This only matters if
# you set the app up before that existed, or prefer setting it manually.
PLEX_TOKEN = os.getenv("PLEX_TOKEN", "")

POLL_INTERVAL_SECONDS = int(os.getenv("POLL_INTERVAL_SECONDS", "10"))
HISTORY_SYNC_INTERVAL_MINUTES = int(os.getenv("HISTORY_SYNC_INTERVAL_MINUTES", "15"))

# Matches how Tautulli's own macOS .pkg installation splits things: app
# code can live wherever it's installed (e.g. inside Plexlytics.app in
# /Applications), but the database and logs live in the standard per-user
# location for application data, same as Tautulli's own
# ~/Library/Application Support/Tautulli/ -- so reinstalling or updating
# the app itself never touches them. Auto-created if it doesn't exist yet.
APP_SUPPORT_DIR = os.getenv(
    "PLEXLYTICS_APP_SUPPORT_DIR", os.path.expanduser("~/Library/Application Support/Plexlytics")
)
os.makedirs(APP_SUPPORT_DIR, exist_ok=True)

DATABASE_PATH = os.getenv("DATABASE_PATH", os.path.join(APP_SUPPORT_DIR, "plex_stats.db"))

DASHBOARD_HOST = os.getenv("DASHBOARD_HOST", "0.0.0.0")
DASHBOARD_PORT = int(os.getenv("DASHBOARD_PORT", "5055"))

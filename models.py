import json
import logging
import os
import shutil
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta

from config import DATABASE_PATH

log = logging.getLogger(__name__)
_lock = threading.Lock()

TABLES_SCHEMA = """
CREATE TABLE IF NOT EXISTS session_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    session_key TEXT,
    user TEXT,
    title TEXT,
    full_title TEXT,
    media_type TEXT,
    player TEXT,
    player_platform TEXT,
    state TEXT,
    is_transcode INTEGER,
    video_decision TEXT,
    bandwidth_kbps REAL,
    progress_percent REAL,
    ip_address TEXT,
    location TEXT
);

CREATE TABLE IF NOT EXISTS watch_history (
    history_key TEXT PRIMARY KEY,
    viewed_at TEXT NOT NULL,
    user TEXT,
    title TEXT,
    full_title TEXT,
    media_type TEXT,
    grandparent_title TEXT,
    account_id TEXT,
    device TEXT,
    library_section TEXT,
    duration_ms INTEGER,
    source TEXT DEFAULT 'plex',
    thumb TEXT,
    genre_key TEXT,
    season_number INTEGER,
    episode_number INTEGER,
    platform TEXT,
    start_time TEXT,
    paused_time TEXT,
    stopped_time TEXT,
    ip_address TEXT,
    product TEXT,
    video_decision TEXT,
    paused_duration_ms INTEGER
);

-- Individual pause/resume events within one viewing, so a single history row
-- (which may have been paused and resumed several times) can be expanded to
-- show each segment. Only populated for viewings this app tracked itself in
-- real time -- Plex's own history data has no equivalent.
CREATE TABLE IF NOT EXISTS watch_pause_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    history_key TEXT NOT NULL,
    paused_at TEXT NOT NULL,
    resumed_at TEXT
);

-- Genres live on the movie/show itself, not on every history row, so they're
-- cached separately per rating key (movie's own key, or the show's key for
-- episodes) and fetched from Plex lazily in the background.
CREATE TABLE IF NOT EXISTS media_genre_cache (
    rating_key TEXT PRIMARY KEY,
    genres TEXT,
    fetched_at TEXT
);

-- Per-library catalog totals (how many movies/shows/seasons/episodes exist),
-- refreshed periodically in the background since these rarely change and
-- computing them requires a Plex API call per library.
CREATE TABLE IF NOT EXISTS library_stats_cache (
    library_key TEXT PRIMARY KEY,
    name TEXT,
    type TEXT,
    total_items INTEGER,
    total_seasons INTEGER,
    total_episodes INTEGER,
    fetched_at TEXT
);

-- Small key/value store for app-level settings that need to persist across
-- restarts but don't fit a dedicated table: the Plex token obtained via
-- logging in through the web UI, the Flask session-signing secret, etc.
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Full metadata (synopsis, director, cast, release date, etc.) for the movie
-- detail / show detail drilldown pages. Fetched on demand the first time
-- someone opens that title, then cached since this data rarely changes.
CREATE TABLE IF NOT EXISTS media_details_cache (
    rating_key TEXT PRIMARY KEY,
    details_json TEXT,
    fetched_at TEXT
);

-- Tracks rating keys the genre/poster backfill couldn't resolve, even after
-- the title-search fallback (see fetch_genres_for_keys). Plex reassigns a
-- new rating key whenever an item is re-matched, moved, or rescanned, so an
-- old key genuinely 404ing doesn't necessarily mean the title is gone --
-- the fallback usually finds it again under its current key. But if BOTH
-- attempts fail repeatedly, the title really is gone, and this lets
-- get_keys_needing_sync stop retrying it every cycle forever -- otherwise a
-- handful of permanently-dead keys can keep getting reselected every 5
-- minutes and crowd out titles that could actually be fixed.
CREATE TABLE IF NOT EXISTS genre_sync_failures (
    rating_key TEXT PRIMARY KEY,
    fail_count INTEGER DEFAULT 0,
    last_attempt TEXT
);

-- A row with no captured duration (a botched sync, a session that never
-- really played, etc.) isn't a meaningful watch -- it shouldn't appear in
-- the History table, count toward any play count, or feed any stat or
-- widget. Rather than repeating "AND duration_ms > 0" at every one of the
-- many call sites that read watch history for exactly those purposes, they
-- all read through this view instead, so the definition of "a real play"
-- lives in exactly one place. The few call sites that legitimately need
-- every row regardless of duration -- import dedup, the genre/poster
-- backfill job, and the full history wipe -- deliberately query
-- watch_history directly instead of this view.
CREATE VIEW IF NOT EXISTS watch_history_valid AS
SELECT * FROM watch_history WHERE duration_ms IS NOT NULL AND duration_ms > 0;
"""

# Indexes are created separately from table creation, AFTER migrations run --
# an index on a column (like genre_key) can't be created until that column
# is guaranteed to actually exist, which for an existing pre-upgrade database
# only becomes true once the ALTER TABLE migration below has run.
INDEXES_SCHEMA = """
CREATE INDEX IF NOT EXISTS idx_snap_time ON session_snapshots(captured_at);
CREATE INDEX IF NOT EXISTS idx_hist_time ON watch_history(viewed_at);
CREATE INDEX IF NOT EXISTS idx_hist_user ON watch_history(user);
CREATE INDEX IF NOT EXISTS idx_hist_title ON watch_history(full_title);
CREATE INDEX IF NOT EXISTS idx_hist_genre_key ON watch_history(genre_key);
CREATE INDEX IF NOT EXISTS idx_pause_history_key ON watch_pause_segments(history_key);
"""


@contextmanager
def get_conn():
    conn = sqlite3.connect(DATABASE_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def _migrate_legacy_database():
    """One-time move for anyone upgrading from before the database lived in
    ~/Library/Application Support/Plexlytics/ (see config.py) -- if the new
    location doesn't have a database yet, but an old app-folder-relative
    one does, move it there instead of silently starting fresh and making
    existing watch history look like it vanished. Safe to call on every
    startup: it's a no-op once the move has already happened once."""
    if os.path.exists(DATABASE_PATH):
        return
    legacy_candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "plex_stats.db"),
        os.path.expanduser("~/plex-stats-app/plex_stats.db"),
    ]
    for old_path in legacy_candidates:
        if os.path.abspath(old_path) == os.path.abspath(DATABASE_PATH):
            continue
        if os.path.exists(old_path):
            os.makedirs(os.path.dirname(DATABASE_PATH), exist_ok=True)
            shutil.move(old_path, DATABASE_PATH)
            log.info("Migrated database from %s to %s", old_path, DATABASE_PATH)
            return


def init_db():
    _migrate_legacy_database()
    with get_conn() as conn:
        conn.executescript(TABLES_SCHEMA)
        # Migration: older databases were created before these columns
        # existed. CREATE TABLE IF NOT EXISTS won't add them to an existing
        # table, so add them by hand if missing.
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(watch_history)").fetchall()]
        if "source" not in cols:
            conn.execute("ALTER TABLE watch_history ADD COLUMN source TEXT DEFAULT 'plex'")
        if "thumb" not in cols:
            conn.execute("ALTER TABLE watch_history ADD COLUMN thumb TEXT")
        if "genre_key" not in cols:
            conn.execute("ALTER TABLE watch_history ADD COLUMN genre_key TEXT")
        if "season_number" not in cols:
            conn.execute("ALTER TABLE watch_history ADD COLUMN season_number INTEGER")
        if "episode_number" not in cols:
            conn.execute("ALTER TABLE watch_history ADD COLUMN episode_number INTEGER")
        if "platform" not in cols:
            conn.execute("ALTER TABLE watch_history ADD COLUMN platform TEXT")
        if "start_time" not in cols:
            conn.execute("ALTER TABLE watch_history ADD COLUMN start_time TEXT")
        if "paused_time" not in cols:
            conn.execute("ALTER TABLE watch_history ADD COLUMN paused_time TEXT")
        if "stopped_time" not in cols:
            conn.execute("ALTER TABLE watch_history ADD COLUMN stopped_time TEXT")
        if "ip_address" not in cols:
            conn.execute("ALTER TABLE watch_history ADD COLUMN ip_address TEXT")
        if "product" not in cols:
            conn.execute("ALTER TABLE watch_history ADD COLUMN product TEXT")
        if "video_decision" not in cols:
            conn.execute("ALTER TABLE watch_history ADD COLUMN video_decision TEXT")
        if "paused_duration_ms" not in cols:
            conn.execute("ALTER TABLE watch_history ADD COLUMN paused_duration_ms INTEGER")
        conn.commit()
        # Now that every column is guaranteed to exist, it's safe to create
        # indexes that reference them.
        conn.executescript(INDEXES_SCHEMA)
        conn.commit()


def insert_snapshot(row):
    with _lock, get_conn() as conn:
        conn.execute(
            """
            INSERT INTO session_snapshots
            (captured_at, session_key, user, title, full_title, media_type, player,
             player_platform, state, is_transcode, video_decision, bandwidth_kbps,
             progress_percent, ip_address, location)
            VALUES (:captured_at, :session_key, :user, :title, :full_title, :media_type,
                    :player, :player_platform, :state, :is_transcode, :video_decision,
                    :bandwidth_kbps, :progress_percent, :ip_address, :location)
            """,
            row,
        )
        conn.commit()


MIN_LOGGED_DURATION_MS = 120_000  # 2 minutes -- see upsert_history / insert_local_watch_event
# Generous enough to cover even a full audiobook file played as a single
# track (this app's longest legitimate single "play"), but anything beyond
# it is almost certainly corrupted source data rather than a real viewing --
# e.g. Tautulli occasionally has a history record for a session that never
# got a proper stop time, and whatever computed its "duration" falls back to
# something nonsensical (seen in practice: a handful of records with
# durations of hundreds of hours, all sharing suspiciously identical
# timestamps -- clearly not real, continuous plays).
MAX_LOGGED_DURATION_MS = 18 * 60 * 60 * 1000  # 18 hours


def upsert_history(row):
    """Insert a watch history row sourced from Plex's own official history
    (also reused by the Tautulli importer). If the row already exists (from
    a prior sync, possibly before a field like 'thumb' was being captured),
    fill in any newly-available fields rather than silently skipping the
    row. Streams under MIN_LOGGED_DURATION_MS are never logged at all --
    almost always an accidental click-through or a quick preview, not a
    real watch, and there's no reason to write a row that watch_history_valid
    (and every stat built on it) would just exclude anyway."""
    row = dict(row)
    duration_ms = row.get("duration_ms")
    if duration_ms is not None and (duration_ms < MIN_LOGGED_DURATION_MS or duration_ms > MAX_LOGGED_DURATION_MS):
        return False
    row.setdefault("source", "plex")
    row.setdefault("thumb", None)
    row.setdefault("genre_key", None)
    row.setdefault("season_number", None)
    row.setdefault("episode_number", None)
    row.setdefault("platform", None)
    row.setdefault("start_time", None)
    row.setdefault("paused_time", None)
    row.setdefault("stopped_time", None)
    row.setdefault("ip_address", None)
    row.setdefault("product", None)
    row.setdefault("video_decision", None)
    row.setdefault("paused_duration_ms", None)
    with _lock, get_conn() as conn:
        conn.execute(
            """
            INSERT INTO watch_history
            (history_key, viewed_at, user, title, full_title, media_type,
             grandparent_title, account_id, device, library_section, duration_ms, source, thumb, genre_key,
             season_number, episode_number, platform, start_time, paused_time, stopped_time,
             ip_address, product, video_decision, paused_duration_ms)
            VALUES (:history_key, :viewed_at, :user, :title, :full_title, :media_type,
                    :grandparent_title, :account_id, :device, :library_section, :duration_ms, :source, :thumb, :genre_key,
                    :season_number, :episode_number, :platform, :start_time, :paused_time, :stopped_time,
                    :ip_address, :product, :video_decision, :paused_duration_ms)
            ON CONFLICT(history_key) DO UPDATE SET
                thumb = COALESCE(excluded.thumb, watch_history.thumb),
                grandparent_title = COALESCE(excluded.grandparent_title, watch_history.grandparent_title),
                device = COALESCE(excluded.device, watch_history.device),
                library_section = COALESCE(excluded.library_section, watch_history.library_section),
                genre_key = COALESCE(excluded.genre_key, watch_history.genre_key),
                season_number = COALESCE(excluded.season_number, watch_history.season_number),
                episode_number = COALESCE(excluded.episode_number, watch_history.episode_number),
                platform = COALESCE(excluded.platform, watch_history.platform),
                start_time = COALESCE(excluded.start_time, watch_history.start_time),
                paused_time = COALESCE(excluded.paused_time, watch_history.paused_time),
                stopped_time = COALESCE(excluded.stopped_time, watch_history.stopped_time),
                ip_address = COALESCE(excluded.ip_address, watch_history.ip_address),
                product = COALESCE(excluded.product, watch_history.product),
                video_decision = COALESCE(excluded.video_decision, watch_history.video_decision),
                paused_duration_ms = COALESCE(excluded.paused_duration_ms, watch_history.paused_duration_ms)
            """,
            row,
        )
        conn.commit()
    return True


def insert_local_watch_event(row):
    """Insert a watch history row this app observed itself by tracking live
    sessions, independent of whether Plex's own history has logged it yet.
    Streams under MIN_LOGGED_DURATION_MS are never logged at all -- see
    upsert_history for why. Returns whether the row was actually written,
    so the caller can skip saving pause segments or running dedup
    reconciliation against a history_key that was never inserted."""
    row = dict(row)
    duration_ms = row.get("duration_ms")
    if duration_ms is not None and (duration_ms < MIN_LOGGED_DURATION_MS or duration_ms > MAX_LOGGED_DURATION_MS):
        return False
    row["source"] = "local"
    row.setdefault("thumb", None)
    row.setdefault("genre_key", None)
    row.setdefault("season_number", None)
    row.setdefault("episode_number", None)
    row.setdefault("platform", None)
    row.setdefault("start_time", None)
    row.setdefault("paused_time", None)
    row.setdefault("stopped_time", None)
    row.setdefault("ip_address", None)
    row.setdefault("product", None)
    row.setdefault("video_decision", None)
    row.setdefault("paused_duration_ms", None)
    with _lock, get_conn() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO watch_history
            (history_key, viewed_at, user, title, full_title, media_type,
             grandparent_title, account_id, device, library_section, duration_ms, source, thumb, genre_key,
             season_number, episode_number, platform, start_time, paused_time, stopped_time,
             ip_address, product, video_decision, paused_duration_ms)
            VALUES (:history_key, :viewed_at, :user, :title, :full_title, :media_type,
                    :grandparent_title, :account_id, :device, :library_section, :duration_ms, :source, :thumb, :genre_key,
                    :season_number, :episode_number, :platform, :start_time, :paused_time, :stopped_time,
                    :ip_address, :product, :video_decision, :paused_duration_ms)
            """,
            row,
        )
        conn.commit()
    return True


SOURCE_PRIORITY = {"local": 3, "tautulli": 2, "plex": 1}


def reconcile_duplicate_sources(full_title, user, viewed_at_iso, window_minutes=45):
    """Whenever multiple rows exist for what's really the same viewing (same
    title, same user, viewed_at within the window) but were logged by
    different sources, keep only the richest version and delete the rest.

    Preference order: this app's own real-time tracking ('local', most
    precise -- exact pause segments, IP, platform) > an imported Tautulli
    history ('tautulli', comparably rich) > Plex's own official history
    ('plex', sparsest -- no IP, no pause detail, an estimated duration).

    Deliberately symmetric: called after inserting a row from ANY of the
    three sources, so it doesn't matter which order they happen to arrive
    in. This matters more than it might seem -- a Tautulli import in
    particular pulls Tautulli's *entire* history regardless of when this
    app's own sync last ran, so anything watched around the same time this
    app was also independently tracking it (live, or via its own Plex sync)
    will get logged by both paths, with nothing to reconcile between them
    unless this runs for every source, not just two of the three.

    Matches on user as well as title, not title alone -- two different
    people watching the same movie around the same time should never be
    merged into one row."""
    try:
        target = datetime.fromisoformat(viewed_at_iso)
    except (ValueError, TypeError):
        return 0
    window = timedelta(minutes=window_minutes)

    with _lock, get_conn() as conn:
        rows = conn.execute(
            "SELECT history_key, viewed_at, source FROM watch_history WHERE full_title = ? AND user = ?",
            (full_title, user),
        ).fetchall()

        matches = []
        for r in rows:
            try:
                t = datetime.fromisoformat(r["viewed_at"])
            except (ValueError, TypeError):
                continue
            if abs(t - target) <= window:
                matches.append(r)

        if len(matches) < 2:
            return 0  # nothing to reconcile

        best = max(matches, key=lambda r: SOURCE_PRIORITY.get(r["source"], 0))
        to_delete = [r["history_key"] for r in matches if r["history_key"] != best["history_key"]]

        for hk in to_delete:
            conn.execute("DELETE FROM watch_history WHERE history_key = ?", (hk,))
        if to_delete:
            conn.commit()
        return len(to_delete)


def prune_old_snapshots(days=30):
    """Keep the snapshots table from growing forever. Watch history is kept indefinitely."""
    with _lock, get_conn() as conn:
        conn.execute(
            "DELETE FROM session_snapshots WHERE captured_at < datetime('now', ?)",
            (f"-{days} days",),
        )
        conn.commit()


def get_uncached_genre_keys(media_type, limit=40):
    """Rating keys that appear in watch_history for this media type but don't
    have genre data cached yet -- candidates for the background genre-fetch job."""
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT DISTINCT genre_key FROM watch_history
            WHERE media_type = ? AND genre_key IS NOT NULL
              AND genre_key NOT IN (SELECT rating_key FROM media_genre_cache)
            LIMIT ?
            """,
            (media_type, limit),
        ).fetchall()
    return [r["genre_key"] for r in rows]


MAX_GENRE_SYNC_ATTEMPTS = 3


def get_keys_needing_sync(media_type, limit=40):
    """Rating keys for this media type that are missing genre data, a poster
    thumbnail on at least one row, or both -- a single combined candidate
    list for the background sync job, since fetching an item's metadata
    gets both pieces of data at once anyway. This deliberately doesn't just
    reuse get_uncached_genre_keys: a title can still be missing its
    thumbnail on some rows even after its genre was already cached (e.g. an
    older Plex-synced viewing cached the genre, then a later Tautulli import
    added more thumb-less rows for that same title).

    Also returns a representative title alongside each key (the show's
    title for episodes, since genre_key is the show's rating key there) --
    fetch_genres_for_keys uses it to search Plex by title if the key itself
    no longer resolves. Keys that have already failed
    MAX_GENRE_SYNC_ATTEMPTS times (direct fetch AND the title-search
    fallback both failed, repeatedly) are excluded -- see
    genre_sync_failures."""
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT wh.genre_key AS genre_key,
                   MAX(CASE WHEN wh.media_type IN ('episode', 'track') THEN wh.grandparent_title ELSE wh.full_title END) AS title
            FROM watch_history wh
            LEFT JOIN media_genre_cache g ON g.rating_key = wh.genre_key
            LEFT JOIN genre_sync_failures f ON f.rating_key = wh.genre_key
            WHERE wh.media_type = ? AND wh.genre_key IS NOT NULL
              AND (g.rating_key IS NULL OR wh.thumb IS NULL OR wh.thumb = '')
              AND (f.fail_count IS NULL OR f.fail_count < ?)
            GROUP BY wh.genre_key
            LIMIT ?
            """,
            (media_type, MAX_GENRE_SYNC_ATTEMPTS, limit),
        ).fetchall()
    return [{"genre_key": r["genre_key"], "title": r["title"]} for r in rows]


def record_genre_sync_failure(rating_key):
    """Bump the failure count for a rating key that couldn't be resolved
    even via the title-search fallback. Once it hits MAX_GENRE_SYNC_ATTEMPTS,
    get_keys_needing_sync stops selecting it, so a title that's genuinely
    gone from Plex doesn't get retried every cycle forever."""
    with _lock, get_conn() as conn:
        conn.execute(
            """
            INSERT INTO genre_sync_failures (rating_key, fail_count, last_attempt)
            VALUES (?, 1, ?)
            ON CONFLICT(rating_key) DO UPDATE SET
                fail_count = fail_count + 1,
                last_attempt = excluded.last_attempt
            """,
            (rating_key, datetime.utcnow().isoformat()),
        )
        conn.commit()


def clear_genre_sync_failure(rating_key):
    """Remove any recorded failure for a rating key once it resolves
    successfully (directly or via the title-search fallback)."""
    with _lock, get_conn() as conn:
        conn.execute("DELETE FROM genre_sync_failures WHERE rating_key = ?", (rating_key,))
        conn.commit()


def remap_genre_key(old_key, new_key, media_type):
    """Point every watch_history row still using a dead rating key at the
    current one found via the title-search fallback, so future syncs (and
    anything else keyed off genre_key) use the working key from now on
    instead of re-discovering the same remap every cycle."""
    if not new_key or old_key == new_key:
        return 0
    with _lock, get_conn() as conn:
        cur = conn.execute(
            "UPDATE watch_history SET genre_key = ? WHERE genre_key = ? AND media_type = ?",
            (new_key, old_key, media_type),
        )
        conn.commit()
        return cur.rowcount


def backfill_thumb_for_key(genre_key, thumb):
    """Fill in the poster thumbnail for any watch_history rows sharing this
    media identity (genre_key) that don't have one yet. Used by the
    background sync job, which already fetches full item metadata per
    rating key for genres and can grab the thumb from that same fetch."""
    if not thumb:
        return 0
    with _lock, get_conn() as conn:
        cur = conn.execute(
            "UPDATE watch_history SET thumb = ? WHERE genre_key = ? AND (thumb IS NULL OR thumb = '')",
            (thumb, genre_key),
        )
        conn.commit()
        return cur.rowcount


def save_genre_cache(rating_key, genres):
    """Store the genre list (a Python list of strings) for one rating key,
    as a JSON array so SQLite's json_each() can explode it back out later."""
    with _lock, get_conn() as conn:
        conn.execute(
            """
            INSERT INTO media_genre_cache (rating_key, genres, fetched_at)
            VALUES (?, ?, ?)
            ON CONFLICT(rating_key) DO UPDATE SET genres = excluded.genres, fetched_at = excluded.fetched_at
            """,
            (rating_key, json.dumps(genres or []), datetime.utcnow().isoformat()),
        )
        conn.commit()


def get_top_genres(media_type, cutoff=None, limit=6):
    """Top genres for movies or TV shows, weighted by how many times each
    title was played in the window. A title with multiple genres contributes
    its full play count to each of its genres."""
    query = """
        SELECT j.value AS genre, SUM(t.plays) AS weight
        FROM (
            SELECT genre_key, COUNT(*) AS plays
            FROM watch_history_valid
            WHERE media_type = ? AND genre_key IS NOT NULL
    """
    params = [media_type]
    if cutoff:
        query += " AND viewed_at >= ?"
        params.append(cutoff)
    query += """
            GROUP BY genre_key
        ) t
        JOIN media_genre_cache c ON c.rating_key = t.genre_key
        JOIN json_each(c.genres) j
        GROUP BY j.value
        ORDER BY weight DESC
        LIMIT ?
    """
    params.append(limit)
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
    return [dict(r) for r in rows]


def get_cached_details(rating_key):
    """Return the cached full-metadata dict for a rating key, or None if it
    hasn't been fetched yet."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT details_json FROM media_details_cache WHERE rating_key = ?",
            (rating_key,),
        ).fetchone()
    if not row:
        return None
    return json.loads(row["details_json"])


def save_details_cache(rating_key, details):
    with _lock, get_conn() as conn:
        conn.execute(
            """
            INSERT INTO media_details_cache (rating_key, details_json, fetched_at)
            VALUES (?, ?, ?)
            ON CONFLICT(rating_key) DO UPDATE SET details_json = excluded.details_json, fetched_at = excluded.fetched_at
            """,
            (rating_key, json.dumps(details), datetime.utcnow().isoformat()),
        )
        conn.commit()


def get_media_watch_events(media_key, media_type, page=1, page_size=25):
    """Who watched this specific movie/show, most recent first. media_key is
    the same rating key used for genre/details caching -- the movie's own
    rating key, or the show's rating key for episodes."""
    with get_conn() as conn:
        total = conn.execute(
            "SELECT COUNT(*) AS c FROM watch_history_valid WHERE genre_key = ? AND media_type = ?",
            (media_key, media_type),
        ).fetchone()["c"]
        rows = conn.execute(
            """
            SELECT user, viewed_at, duration_ms, title, season_number, episode_number
            FROM watch_history_valid
            WHERE genre_key = ? AND media_type = ?
            ORDER BY viewed_at DESC
            LIMIT ? OFFSET ?
            """,
            (media_key, media_type, page_size, (page - 1) * page_size),
        ).fetchall()
    return total, [dict(r) for r in rows]


def get_play_stats_for_keys(rating_keys):
    """Total plays and last-played timestamp for a batch of rating keys, one
    row per key -- powers the Total Plays / Last Played columns on the
    library Media table, which lists live items straight from Plex's
    catalog rather than watch_history rows, so those two columns need a
    separate lookup keyed the same way genre/thumb data already is (a
    movie's own rating key, or a show's rating key for episodes). Keys with
    no matching plays simply won't appear in the returned dict -- the
    caller treats a missing key as zero plays / never watched."""
    if not rating_keys:
        return {}
    placeholders = ",".join("?" for _ in rating_keys)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT genre_key, COUNT(*) AS plays, MAX(viewed_at) AS last_played
            FROM watch_history_valid
            WHERE genre_key IN ({placeholders})
            GROUP BY genre_key
            """,
            rating_keys,
        ).fetchall()
    return {r["genre_key"]: {"plays": r["plays"], "last_played": r["last_played"]} for r in rows}


def get_setting(key, default=None):
    with get_conn() as conn:
        row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key, value):
    with _lock, get_conn() as conn:
        conn.execute(
            """
            INSERT INTO app_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (key, value),
        )
        conn.commit()


def delete_setting(key):
    with _lock, get_conn() as conn:
        conn.execute("DELETE FROM app_settings WHERE key = ?", (key,))
        conn.commit()


def save_pause_segments(history_key, segments):
    """Store the individual pause/resume events for one viewing. segments is
    a list of dicts: [{"paused_at": iso_str, "resumed_at": iso_str_or_None}, ...]"""
    if not segments:
        return
    with _lock, get_conn() as conn:
        conn.executemany(
            "INSERT INTO watch_pause_segments (history_key, paused_at, resumed_at) VALUES (?, ?, ?)",
            [(history_key, s["paused_at"], s.get("resumed_at")) for s in segments],
        )
        conn.commit()


def get_pause_segments(history_key):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT paused_at, resumed_at FROM watch_pause_segments WHERE history_key = ? ORDER BY paused_at ASC",
            (history_key,),
        ).fetchall()
    return [dict(r) for r in rows]


def save_server_users(names):
    """Caches the current list of every user with access to the Plex
    server (see plex_client.fetch_server_users) -- a simple JSON blob under
    a settings key rather than its own table, since it's just a flat list
    of names with no per-row metadata worth a schema for."""
    set_setting("server_users_cache", json.dumps(sorted(names)))


def get_cached_server_users():
    raw = get_setting("server_users_cache")
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) else []
    except (ValueError, TypeError):
        return []


def save_library_stats(libraries):
    """Replace the cached catalog totals for every library in one go --
    simpler than per-row upserts since the whole library list is always
    refetched together, and a library that's been removed from Plex should
    disappear from here too."""
    with _lock, get_conn() as conn:
        conn.execute("DELETE FROM library_stats_cache")
        conn.executemany(
            """
            INSERT INTO library_stats_cache
            (library_key, name, type, total_items, total_seasons, total_episodes, fetched_at)
            VALUES (:key, :name, :type, :total_items, :total_seasons, :total_episodes, :fetched_at)
            """,
            libraries,
        )
        conn.commit()


def get_library_stats():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM library_stats_cache ORDER BY name COLLATE NOCASE ASC").fetchall()
    return [dict(r) for r in rows]


def backfill_missing_library_sections():
    """Older watch_history rows (mostly ones this app tracked itself in real
    time before library_section was being captured at all) can have it as
    NULL. If there's exactly one movie library, one show library, and/or one
    Music (artist-type) library, that's enough to safely infer which one any
    given row belongs to from its media_type alone -- deliberately
    conservative: if there's more than one library of a given type, that
    type is skipped rather than guessing wrong and silently misattributing
    history to the wrong library."""
    catalog = get_library_stats()
    movie_libs = [l["name"] for l in catalog if l["type"] == "movie"]
    show_libs = [l["name"] for l in catalog if l["type"] == "show"]
    artist_libs = [l["name"] for l in catalog if l["type"] == "artist"]

    updated = 0
    with _lock, get_conn() as conn:
        if len(movie_libs) == 1:
            cur = conn.execute(
                "UPDATE watch_history SET library_section = ? "
                "WHERE media_type = 'movie' AND (library_section IS NULL OR library_section = '')",
                (movie_libs[0],),
            )
            updated += cur.rowcount
        if len(show_libs) == 1:
            cur = conn.execute(
                "UPDATE watch_history SET library_section = ? "
                "WHERE media_type = 'episode' AND (library_section IS NULL OR library_section = '')",
                (show_libs[0],),
            )
            updated += cur.rowcount
        if len(artist_libs) == 1:
            cur = conn.execute(
                "UPDATE watch_history SET library_section = ? "
                "WHERE media_type = 'track' AND (library_section IS NULL OR library_section = '')",
                (artist_libs[0],),
            )
            updated += cur.rowcount
        conn.commit()
    return updated


def get_library_watch_summary():
    """Per-library aggregates from this app's own watch history: total plays,
    total time watched, when it was last streamed, and what was last played.
    Keyed by library name, since that's what's stored on each history row."""
    with get_conn() as conn:
        totals = conn.execute(
            """
            SELECT library_section,
                   COUNT(*) AS total_plays,
                   SUM(COALESCE(duration_ms, 0)) AS total_duration_ms,
                   MAX(viewed_at) AS last_streamed
            FROM watch_history_valid
            WHERE library_section IS NOT NULL AND library_section != ''
            GROUP BY library_section
            """
        ).fetchall()

        summary = {}
        for row in totals:
            lib = row["library_section"]
            last_played = conn.execute(
                """
                SELECT full_title, media_type, season_number, episode_number
                FROM watch_history_valid
                WHERE library_section = ?
                ORDER BY viewed_at DESC
                LIMIT 1
                """,
                (lib,),
            ).fetchone()
            summary[lib] = {
                "total_plays": row["total_plays"],
                "total_duration_ms": row["total_duration_ms"],
                "last_streamed": row["last_streamed"],
                "last_played_title": last_played["full_title"] if last_played else None,
                "last_played_type": last_played["media_type"] if last_played else None,
                "last_played_season": last_played["season_number"] if last_played else None,
                "last_played_episode": last_played["episode_number"] if last_played else None,
            }
    return summary


def get_library_period_stats(library_name):
    """Plays + total watch time for one library, broken into the same time
    buckets Tautulli shows: last 24h, last 7 days, last 30 days, all time."""
    now = datetime.utcnow()
    periods = {
        "last_24h": now - timedelta(hours=24),
        "last_7d": now - timedelta(days=7),
        "last_30d": now - timedelta(days=30),
        "all_time": None,
    }
    results = {}
    with get_conn() as conn:
        for key, cutoff in periods.items():
            if cutoff:
                row = conn.execute(
                    """
                    SELECT COUNT(*) AS plays, SUM(COALESCE(duration_ms, 0)) AS duration_ms
                    FROM watch_history_valid WHERE library_section = ? AND viewed_at >= ?
                    """,
                    (library_name, cutoff.isoformat()),
                ).fetchone()
            else:
                row = conn.execute(
                    """
                    SELECT COUNT(*) AS plays, SUM(COALESCE(duration_ms, 0)) AS duration_ms
                    FROM watch_history_valid WHERE library_section = ?
                    """,
                    (library_name,),
                ).fetchone()
            results[key] = {"plays": row["plays"] or 0, "duration_ms": row["duration_ms"] or 0}
    return results


def get_library_user_stats(library_name):
    """Every user who's watched something in this library, most plays first."""
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT user, COUNT(*) AS plays
            FROM watch_history_valid
            WHERE library_section = ?
            GROUP BY user
            ORDER BY plays DESC
            """,
            (library_name,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_library_recent_plays(library_name, limit=12):
    """The most recently-played *distinct* titles in this library, for the
    'Recently Played' carousel -- each title appears once, positioned by
    whenever it was most recently played, so a rewatch bumps it back to the
    front instead of creating a duplicate card.

    Groups by genre_key (the same media-identity key used everywhere else in
    the app -- a movie's own key, or a show's key for episodes, so rewatching
    different episodes of one show still collapses to a single card), falling
    back to full_title for older rows synced before that field existed.

    Relies on a SQLite-specific (not general-SQL) guarantee: when a query has
    exactly one MIN()/MAX() aggregate, any other "bare" selected columns are
    taken from the same row that produced that MIN/MAX value -- so thumb,
    full_title, etc. below correctly come from the single most recent viewing
    in each group, not an arbitrary row in it."""
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT full_title, thumb, media_type, genre_key AS media_key, MAX(viewed_at) AS viewed_at
            FROM watch_history_valid
            WHERE library_section = ?
            GROUP BY COALESCE(genre_key, full_title)
            ORDER BY viewed_at DESC
            LIMIT ?
            """,
            (library_name, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def delete_history_entry(history_key):
    """Permanently delete one specific watch history row (and any
    pause-segment detail for it) -- e.g. to remove a single corrupted or
    mistaken entry from the History table without needing to touch the
    database directly. Returns True if a row was actually deleted, False
    if nothing matched that history_key."""
    with _lock, get_conn() as conn:
        conn.execute("DELETE FROM watch_pause_segments WHERE history_key = ?", (history_key,))
        cur = conn.execute("DELETE FROM watch_history WHERE history_key = ?", (history_key,))
        conn.commit()
        return cur.rowcount > 0


def clear_watch_history():
    """Permanently delete all watch history and its pause-segment detail.
    Deliberately leaves everything else alone: session snapshots (live
    bandwidth/trend data), the genre/poster/details caches, library catalog
    stats, and app settings (Plex token, session secret) are untouched --
    this only clears the history rows themselves, e.g. to start clean before
    a Tautulli import rather than ending up with a mix of both.

    Also records when this happened (see get_history_cleared_at) so the
    background sync doesn't immediately undo it by re-pulling Plex's own
    still-intact history the next time the app starts."""
    with _lock, get_conn() as conn:
        count = conn.execute("SELECT COUNT(*) AS c FROM watch_history").fetchone()["c"]
        conn.execute("DELETE FROM watch_pause_segments")
        conn.execute("DELETE FROM watch_history")
        conn.commit()
    set_setting("history_cleared_at", datetime.utcnow().isoformat())
    return count


def get_history_cleared_at():
    """ISO timestamp of the last Clear Watch History action, or None if
    it's never been used. Used to cap how far back the startup sync will
    pull from Plex, so a clear stays cleared instead of getting silently
    undone by the next full resync."""
    return get_setting("history_cleared_at")

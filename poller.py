import logging
from datetime import datetime, timedelta

from apscheduler.schedulers.background import BackgroundScheduler

import models
import plex_client
from config import HISTORY_SYNC_INTERVAL_MINUTES, POLL_INTERVAL_SECONDS

log = logging.getLogger(__name__)

_account_map_cache = {}

# Tracks sessions currently believed to be playing, keyed by Plex's
# sessionKey, so we can notice when one disappears (the stream ended) and log
# it ourselves -- independent of whether it ever crosses Plex's own 90%
# "played" threshold for its official history.
_active_sessions = {}

# Ignore session blips shorter than this many seconds -- avoids logging a
# "watch" for something that flickered on/off across a single poll cycle.
MIN_LOCAL_WATCH_SECONDS = 5


def get_active_session_live_info():
    """session_key -> {start_time, paused_duration_ms} for sessions this
    poller is currently tracking. Used to show accurate 'Started' and
    'Paused' values for in-progress streams in the History table -- accurate
    because it's based on wall-clock tracking, not back-calculated from
    playback position (which would be thrown off by any time spent paused)."""
    now = datetime.utcnow()
    result = {}
    for key, entry in _active_sessions.items():
        paused_ms = 0
        for seg in entry["pause_segments"]:
            end = seg["resumed_at"] or now
            paused_ms += (end - seg["paused_at"]).total_seconds() * 1000
        result[key] = {
            "start_time": entry["first_seen"].isoformat(),
            "paused_duration_ms": int(paused_ms),
        }
    return result


def poll_live_sessions():
    try:
        plex = plex_client.connect()
        sessions = plex_client.get_live_sessions(plex)
        now_dt = datetime.utcnow()
        now = now_dt.isoformat()

        current_keys = set()
        for s in sessions:
            key = s.get("session_key")
            if key:
                current_keys.add(key)
                is_paused_now = s.get("state") == "paused"
                if key in _active_sessions:
                    entry = _active_sessions[key]
                    entry["last_seen"] = now_dt
                    entry["info"] = s
                    was_paused = entry["currently_paused"]
                    if is_paused_now and not was_paused:
                        # Just paused -- open a new segment.
                        entry["pause_segments"].append({"paused_at": now_dt, "resumed_at": None})
                    elif not is_paused_now and was_paused:
                        # Just resumed -- close the most recent open segment.
                        if entry["pause_segments"]:
                            entry["pause_segments"][-1]["resumed_at"] = now_dt
                    entry["currently_paused"] = is_paused_now
                else:
                    _active_sessions[key] = {
                        "first_seen": now_dt,
                        "last_seen": now_dt,
                        "info": s,
                        "pause_segments": [{"paused_at": now_dt, "resumed_at": None}] if is_paused_now else [],
                        "currently_paused": is_paused_now,
                    }

            snapshot_row = dict(s)
            snapshot_row["captured_at"] = now
            models.insert_snapshot(snapshot_row)

        if not sessions:
            # No active streams right now -- still record a snapshot (with
            # no session_key, so COUNT(DISTINCT session_key) correctly reads
            # it as zero) so the Concurrent Streams & Bandwidth chart keeps
            # advancing to the current time every poll cycle instead of its
            # last data point staying frozen at whenever the last stream
            # actually ended.
            models.insert_snapshot(
                {
                    "captured_at": now,
                    "session_key": None,
                    "user": None,
                    "title": None,
                    "full_title": None,
                    "media_type": None,
                    "player": None,
                    "player_platform": None,
                    "state": None,
                    "is_transcode": None,
                    "video_decision": None,
                    "bandwidth_kbps": 0,
                    "progress_percent": None,
                    "ip_address": None,
                    "location": None,
                }
            )

        _handle_ended_sessions(current_keys)

        if sessions:
            log.info("Captured %d live session(s)", len(sessions))
    except Exception as e:
        log.error("Live session poll failed: %s", e)


def _handle_ended_sessions(current_keys):
    ended_keys = [k for k in _active_sessions if k not in current_keys]
    for key in ended_keys:
        entry = _active_sessions.pop(key)
        watched_seconds = (entry["last_seen"] - entry["first_seen"]).total_seconds()
        if watched_seconds < MIN_LOCAL_WATCH_SECONDS:
            continue
        _log_local_watch_event(
            entry["info"], entry["first_seen"], entry["pause_segments"], entry["last_seen"], watched_seconds
        )


def _log_local_watch_event(info, first_seen, pause_segments, last_seen, watched_seconds):
    # If the stream was still paused when it disappeared, close that last
    # segment out at the stop time rather than leaving it open forever.
    closed_segments = []
    total_paused_seconds = 0.0
    for seg in pause_segments:
        resumed_at = seg["resumed_at"] or last_seen
        total_paused_seconds += (resumed_at - seg["paused_at"]).total_seconds()
        closed_segments.append(
            {"paused_at": seg["paused_at"].isoformat(), "resumed_at": resumed_at.isoformat()}
        )

    history_key = f"local:{info.get('session_key')}:{last_seen.isoformat()}"
    row = {
        "history_key": history_key,
        "viewed_at": last_seen.isoformat(),
        "user": info.get("user", "Unknown"),
        "title": info.get("title"),
        "full_title": info.get("full_title"),
        "media_type": info.get("media_type"),
        "grandparent_title": info.get("grandparent_title"),
        "account_id": None,
        "device": info.get("player"),
        "library_section": info.get("library_section"),
        "duration_ms": int(watched_seconds * 1000),
        "thumb": info.get("thumb"),
        "genre_key": info.get("genre_key"),
        "season_number": info.get("season_number"),
        "episode_number": info.get("episode_number"),
        "platform": info.get("player_platform"),
        "product": info.get("product"),
        "ip_address": info.get("ip_address"),
        "video_decision": info.get("video_decision"),
        "start_time": first_seen.isoformat(),
        "paused_time": closed_segments[0]["paused_at"] if closed_segments else None,
        "stopped_time": last_seen.isoformat(),
        "paused_duration_ms": int(total_paused_seconds * 1000),
    }
    try:
        logged = models.insert_local_watch_event(row)
        if not logged:
            log.info(
                "Skipped logging watch event (local): %s by %s (%ds, under the 120s minimum)",
                row["full_title"], row["user"], int(watched_seconds),
            )
            return
        if closed_segments:
            models.save_pause_segments(history_key, closed_segments)
        # If Plex's own history already logged this same viewing (a common
        # ordering, since Plex often records it around the 90%-watched mark
        # while the session is still actually running), remove that sparser
        # version now that the richer local one has arrived.
        removed = models.reconcile_duplicate_sources(row["full_title"], row["user"], row["viewed_at"])
        if removed:
            log.info("Removed %d sparser Plex-sourced duplicate row(s) for this viewing", removed)
        log.info(
            "Logged watch event (local): %s by %s (%ds, %d pause segment(s))",
            row["full_title"], row["user"], int(watched_seconds), len(closed_segments),
        )
    except Exception as e:
        log.warning("Failed to log local watch event: %s", e)


def sync_history(initial=False):
    global _account_map_cache
    try:
        plex = plex_client.connect()
        if not _account_map_cache:
            _account_map_cache = plex_client.get_account_map(plex)

        if initial:
            # A full backfill (mindate=None) is the right call for a brand
            # new install with an empty database -- but if someone has since
            # used Clear Watch History, doing that same full pull on every
            # restart would immediately re-pull everything from Plex's own
            # (still-intact) history and silently undo the clear. Once a
            # clear has happened, cap how far back this goes to that point
            # instead, so only genuinely new viewings come back.
            cleared_at = models.get_history_cleared_at()
            mindate = datetime.fromisoformat(cleared_at) if cleared_at else None
        else:
            mindate = datetime.utcnow() - timedelta(days=2)

        rows = plex_client.get_history_batch(
            plex, _account_map_cache, size=2000 if initial else 300, mindate=mindate
        )
        logged = 0
        for r in rows:
            if models.upsert_history(r):
                logged += 1
            # If a locally-tracked version of this same viewing exists (or
            # shows up shortly), keep that richer version and drop this
            # sparser Plex-sourced one instead.
            models.reconcile_duplicate_sources(r["full_title"], r["user"], r["viewed_at"])
        skipped_short = len(rows) - logged
        log.info(
            "Synced %d history row(s) (initial=%s)%s",
            logged, initial, f", {skipped_short} skipped (under 120s)" if skipped_short else "",
        )
    except Exception as e:
        log.error("History sync failed: %s", e)


def sync_genres(limit_per_type=40):
    """Backfills genre data AND poster thumbnails for titles that need
    either one -- fetching an item's metadata gets both at once, so this
    covers rows missing a poster (e.g. imported from Tautulli, which
    doesn't supply a usable poster path directly) at the same time as the
    original genre backfill. Runs in small batches so it doesn't hammer
    Plex with a huge burst of requests -- it just gradually catches up over
    a few cycles.

    A rating key can also fail to resolve because Plex reassigned it (a
    re-match, a move, a library rescan) rather than because the title was
    actually removed -- fetch_genres_for_keys falls back to a title search
    in that case, and any row still pointing at the old dead key gets
    remapped to the current one so it doesn't need rediscovering every
    cycle. If a key fails even that (title genuinely gone), it's recorded
    so get_keys_needing_sync stops retrying it forever."""
    try:
        plex = plex_client.connect()
        total_genres = 0
        total_thumbs = 0
        total_remapped = 0
        for media_type in ("movie", "episode", "track"):
            items = models.get_keys_needing_sync(media_type, limit=limit_per_type)
            if not items:
                continue
            for it in items:
                it["media_type"] = media_type
            info_map = plex_client.fetch_genres_for_keys(plex, items)

            for key, info in info_map.items():
                resolved_key = info.get("resolved_key") or key
                # Backfill against the key rows still actually have *before*
                # remapping them.
                total_thumbs += models.backfill_thumb_for_key(key, info.get("thumb"))
                if resolved_key != key:
                    total_remapped += models.remap_genre_key(key, resolved_key, media_type)
                models.save_genre_cache(resolved_key, info["genres"])
                total_genres += 1
                models.clear_genre_sync_failure(key)

            attempted_keys = {it["genre_key"] for it in items}
            for key in attempted_keys - info_map.keys():
                models.record_genre_sync_failure(key)

        if total_genres or total_thumbs or total_remapped:
            log.info(
                "Cached genres for %d title(s), backfilled poster on %d row(s), remapped %d row(s) to a current rating key",
                total_genres, total_thumbs, total_remapped,
            )
    except Exception as e:
        log.error("Genre/poster sync failed: %s", e)


def sync_libraries():
    """Refresh per-library catalog totals from Plex. These rarely change, so
    this runs occasionally in the background rather than on every page load."""
    try:
        plex = plex_client.connect()
        libraries = plex_client.fetch_library_stats(plex)
        models.save_library_stats(libraries)
        log.info("Synced stats for %d librar(y/ies)", len(libraries))
        updated = models.backfill_missing_library_sections()
        if updated:
            log.info("Backfilled library_section for %d older history row(s)", updated)
    except Exception as e:
        log.error("Library sync failed: %s", e)


def sync_server_users():
    """Refresh the cached list of everyone with access to the Plex server
    (not just people who've actually watched something) -- access grants
    change rarely, same reasoning as sync_libraries above."""
    try:
        plex = plex_client.connect()
        users = plex_client.fetch_server_users(plex)
        models.save_server_users(users)
        log.info("Synced %d Plex server user(s)", len(users))
    except Exception as e:
        log.error("Server user sync failed: %s", e)


def start_scheduler():
    models.init_db()
    # Do an initial full history backfill and one live poll synchronously so the
    # dashboard has data the moment it's opened.
    sync_history(initial=True)
    poll_live_sessions()
    sync_genres(limit_per_type=100)
    sync_libraries()
    sync_server_users()

    scheduler = BackgroundScheduler()
    scheduler.add_job(poll_live_sessions, "interval", seconds=POLL_INTERVAL_SECONDS, id="live_poll")
    scheduler.add_job(
        sync_history, "interval", minutes=HISTORY_SYNC_INTERVAL_MINUTES, id="history_sync"
    )
    scheduler.add_job(sync_genres, "interval", minutes=5, id="genre_sync")
    scheduler.add_job(sync_libraries, "interval", minutes=60, id="library_sync")
    scheduler.add_job(sync_server_users, "interval", minutes=60, id="server_users_sync")
    scheduler.add_job(models.prune_old_snapshots, "interval", hours=24, id="prune")
    scheduler.start()
    return scheduler

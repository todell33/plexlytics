"""Import watch history from an existing Tautulli install via its own API.

Tautulli tracks much of the same data this app does (start/stop times,
paused duration, platform, IP address, transcode decision), and its
rating_key / grandparent_rating_key fields are genuine Plex rating keys
(Tautulli gets them from Plex directly) -- so imported rows plug straight
into this app's existing genre/poster/detail-page machinery without any
special-casing, the same way a freshly-synced Plex row would.

What deliberately isn't imported:
  - Individual pause segments (Tautulli's history is one summary row per
    viewing with a total paused_counter, not a segment-by-segment log like
    this app's own real-time tracker produces) -- the total still populates
    the "Paused" column correctly, there just won't be an expandable
    breakdown for older imported rows.
  - Poster thumbnails aren't stored directly at import time; they're picked
    up automatically the next time this app's own genre/poster fetching
    runs against the same rating keys.
  - library_section is left blank at import time and filled in afterward by
    the existing backfill_missing_library_sections() logic already used for
    older locally-tracked rows.
"""

import logging
from datetime import datetime, timezone

import requests

log = logging.getLogger(__name__)

DECISION_MAP = {
    "direct play": "direct_play",
    "copy": "direct_stream",
    "transcode": "transcode",
}


def _to_iso(unix_ts):
    if not unix_ts:
        return None
    try:
        return datetime.fromtimestamp(int(unix_ts), tz=timezone.utc).replace(tzinfo=None).isoformat()
    except (ValueError, TypeError, OSError):
        return None


def fetch_history_page(base_url, api_key, start=0, length=500, timeout=30):
    """One page of Tautulli history, oldest-first pagination isn't
    guaranteed stable across Tautulli itself changing rows mid-import, so we
    page newest-first (the default) and just keep going until a short page
    signals we've reached the end."""
    url = f"{base_url.rstrip('/')}/api/v2"
    params = {
        "apikey": api_key,
        "cmd": "get_history",
        "start": start,
        "length": length,
        "order_column": "date",
        "order_dir": "desc",
    }
    resp = requests.get(url, params=params, timeout=timeout)
    resp.raise_for_status()
    payload = resp.json()
    if payload.get("response", {}).get("result") != "success":
        raise RuntimeError(payload.get("response", {}).get("message") or "Tautulli API request failed")
    data = payload["response"]["data"]
    rows = data.get("data", [])
    total = data.get("recordsFiltered", data.get("recordsTotal", len(rows)))
    return rows, total


def convert_record(record):
    """One Tautulli history record -> a row dict shaped for
    models.upsert_history(), reusing that same 'plex' insert path (marked
    with source='tautulli' for traceability) since the shape matches."""
    media_type = record.get("media_type")
    # Episodes group by show (their grandparent), same as elsewhere in this
    # app; music tracks have the identical three-level hierarchy (track ->
    # album -> artist), so they group by artist for the same reason.
    is_grouped_type = media_type in ("episode", "track")

    genre_key = record.get("grandparent_rating_key") if is_grouped_type else record.get("rating_key")
    decision = DECISION_MAP.get((record.get("transcode_decision") or "").lower())

    row_id = record.get("id") or record.get("reference_id") or record.get("row_id")
    stopped = _to_iso(record.get("stopped"))
    started = _to_iso(record.get("started"))

    return {
        "history_key": f"tautulli:{row_id}",
        "viewed_at": stopped or started or _to_iso(record.get("date")),
        "user": record.get("user") or record.get("friendly_name") or "Unknown",
        "title": record.get("title"),
        "full_title": record.get("full_title") or record.get("title"),
        "media_type": media_type,
        "grandparent_title": record.get("grandparent_title"),
        "account_id": str(record["user_id"]) if record.get("user_id") is not None else None,
        "device": record.get("player"),
        "library_section": None,  # filled in later by the existing backfill pass
        "duration_ms": int((record.get("duration") or 0) * 1000),
        "source": "tautulli",
        "thumb": None,  # picked up later by the existing genre/poster sync
        "genre_key": str(genre_key) if genre_key else None,
        "season_number": record.get("parent_media_index"),
        "episode_number": record.get("media_index"),
        "platform": record.get("platform"),
        "start_time": started,
        "paused_time": None,  # Tautulli only gives a total, not per-segment timestamps
        "stopped_time": stopped,
        "ip_address": record.get("ip_address"),
        "product": None,
        "video_decision": decision,
        "paused_duration_ms": int((record.get("paused_counter") or 0) * 1000),
    }


def import_history(base_url, api_key, models_module, page_size=500, max_pages=200):
    """Pulls Tautulli's full history and inserts it via the same upsert path
    Plex-synced rows use, so re-running this (or overlapping with a normal
    Plex sync covering the same viewings) is safe -- duplicates are ignored
    by history_key, and real Plex data always takes priority on conflict."""
    imported = 0
    skipped = 0
    start = 0
    total = None

    for _ in range(max_pages):
        rows, total = fetch_history_page(base_url, api_key, start=start, length=page_size)
        if not rows:
            break
        for record in rows:
            try:
                row = convert_record(record)
                if not row["viewed_at"]:
                    skipped += 1
                    continue
                if not models_module.upsert_history(row):
                    # Under the 120s minimum -- see upsert_history.
                    skipped += 1
                    continue
                imported += 1
                # This app's own Plex sync and live tracking run continuously
                # in the background, independent of when an import happens --
                # so a viewing that occurred recently can easily already be
                # logged by this app too. Reconcile against those every time,
                # not just against other Tautulli-imported rows.
                models_module.reconcile_duplicate_sources(row["full_title"], row["user"], row["viewed_at"])
            except Exception as e:
                log.warning("Skipped a Tautulli history record: %s", e)
                skipped += 1
        start += len(rows)
        if total is not None and start >= total:
            break

    return {"imported": imported, "skipped": skipped, "total_seen": start}

import logging
import json
import os
import plistlib
import secrets
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps
from urllib.parse import urlparse

import requests
from flask import Flask, Response, jsonify, redirect, render_template, request, session, url_for
from plexapi.myplex import MyPlexAccount, MyPlexPinLogin
from plexapi.server import PlexServer

import config
import models
import plex_client
import poller
import tautulli_import

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
log = logging.getLogger(__name__)

app = Flask(__name__)

# The database needs to exist before we can read/write settings like the
# secret key below -- normally this happens inside poller.start_scheduler(),
# but that runs later. init_db() is safe to call more than once.
models.init_db()

# Flask needs a stable secret to sign session cookies. Generate one once and
# persist it in the database, so sessions survive app restarts instead of
# invalidating everyone's login every time the service restarts.
_secret = models.get_setting("flask_secret_key")
if not _secret:
    _secret = secrets.token_hex(32)
    models.set_setting("flask_secret_key", _secret)
app.secret_key = _secret
app.permanent_session_lifetime = timedelta(days=90)

# In-memory store for Plex OAuth logins that are in progress (waiting for the
# person to approve on plex.tv). Keyed by a random id handed to the browser.
# This is fine to keep in memory only -- an in-progress login that gets lost
# on a restart just means starting the login over, no real data at stake.
_pending_logins = {}


# ---------------------------------------------------------------------------
# Auth -- a successful Plex login grants a session; there's no separate
# app password to manage anymore.
# ---------------------------------------------------------------------------
def requires_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if session.get("plex_authed"):
            return f(*args, **kwargs)
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "error": "not authenticated"}), 401
        return redirect(url_for("login_page"))

    return decorated


def requires_auth_or_local(f):
    """Same as requires_auth, but also allows requests from localhost with
    no browser session at all -- used only on the handful of endpoints the
    menu bar helper (menubar.py) needs to call. It's a separate local
    process with no cookie jar shared with any browser, so it can never
    satisfy the normal session check; a plain requests.post() from it was
    silently getting rejected with 401 before this existed, which is why
    Restart/Quit from the menu bar looked like they were doing nothing.

    Deliberately not used broadly: only for app-lifecycle and menu-bar-
    preference endpoints, never anything that exposes the person's actual
    Plex data, so the exemption stays as narrow as what actually needs it."""

    @wraps(f)
    def decorated(*args, **kwargs):
        if session.get("plex_authed") or request.remote_addr in ("127.0.0.1", "::1"):
            return f(*args, **kwargs)
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "error": "not authenticated"}), 401
        return redirect(url_for("login_page"))

    return decorated


def period_to_cutoff(period):
    now = datetime.utcnow()
    if period == "7d":
        return (now - timedelta(days=7)).isoformat()
    if period == "30d":
        return (now - timedelta(days=30)).isoformat()
    if period == "60d":
        return (now - timedelta(days=60)).isoformat()
    if period == "90d":
        return (now - timedelta(days=90)).isoformat()
    return None  # "all"


# ---------------------------------------------------------------------------
# Login (Plex OAuth)
# ---------------------------------------------------------------------------
@app.route("/login")
def login_page():
    if session.get("plex_authed"):
        return redirect(url_for("dashboard"))
    return render_template("login.html")


@app.route("/login/start", methods=["POST"])
def login_start():
    pinlogin = MyPlexPinLogin(oauth=True)
    pinlogin.run(timeout=300)
    login_id = str(uuid.uuid4())
    _pending_logins[login_id] = pinlogin
    return jsonify({"ok": True, "login_id": login_id, "url": pinlogin.oauthUrl()})


@app.route("/login/poll")
def login_poll():
    login_id = request.args.get("login_id", "")
    pinlogin = _pending_logins.get(login_id)
    if not pinlogin:
        return jsonify({"ok": False, "status": "unknown"}), 404

    # run() started a background thread that handles the actual polling of
    # plex.tv and updates these attributes -- we just read the current state
    # here rather than polling again ourselves, which would race with it.
    if pinlogin.finished and pinlogin.token:
        token = pinlogin.token
        del _pending_logins[login_id]

        # Confirm this Plex account actually has access to *this* server --
        # not just any valid Plex.tv login -- before granting a session.
        try:
            PlexServer(plex_client.get_server_url(), token)
        except Exception as e:
            log.warning("Plex login succeeded but server access check failed: %s", e)
            return jsonify(
                {"ok": False, "status": "no_access", "error": "This Plex account doesn't have access to this server."}
            )

        try:
            account = MyPlexAccount(token=token)
            username = account.username
        except Exception:
            username = None

        models.set_setting("plex_token", token)
        if username:
            models.set_setting("plex_username", username)
        session.permanent = True
        session["plex_authed"] = True
        session["plex_username"] = username
        return jsonify({"ok": True, "status": "success"})

    if pinlogin.expired:
        del _pending_logins[login_id]
        return jsonify({"ok": False, "status": "expired"})

    return jsonify({"ok": True, "status": "pending"})


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login_page"))


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
@app.route("/")
@requires_auth
def dashboard():
    return render_template("dashboard.html", plex_username=session.get("plex_username"))


# ---------------------------------------------------------------------------
# API: live data
# ---------------------------------------------------------------------------
@app.route("/api/live")
@requires_auth
def api_live():
    try:
        plex = plex_client.connect()
        sessions = plex_client.get_live_sessions(plex)
        live_info = poller.get_active_session_live_info()
        for s in sessions:
            info = live_info.get(s.get("session_key"), {})
            s["start_time"] = info.get("start_time")
            s["paused_duration_ms"] = info.get("paused_duration_ms")
        return jsonify({"ok": True, "count": len(sessions), "sessions": sessions})
    except Exception as e:
        log.error("api_live error: %s", e)
        return jsonify({"ok": False, "error": str(e), "sessions": [], "count": 0})


@app.route("/api/bandwidth-trend")
@requires_auth
def api_bandwidth_trend():
    hours = int(request.args.get("hours", 6))
    cutoff = (datetime.utcnow() - timedelta(hours=hours)).isoformat()
    with models.get_conn() as conn:
        rows = conn.execute(
            """
            SELECT captured_at,
                   COUNT(DISTINCT session_key) AS streams,
                   SUM(bandwidth_kbps) AS total_kbps
            FROM session_snapshots
            WHERE captured_at >= ?
            GROUP BY captured_at
            ORDER BY captured_at ASC
            """,
            (cutoff,),
        ).fetchall()
    return jsonify({"ok": True, "points": [dict(r) for r in rows]})


# In-memory cache for the Media tab's per-library genre list (see
# api_library_media_genres) -- {library_key: (genres, fetched_at_monotonic)}.
# Deliberately in-memory rather than in the DB: it's fine to recompute once
# after a restart, and this avoids a schema change for something this cheap
# to regenerate.
_library_genres_cache = {}
LIBRARY_GENRES_CACHE_TTL_SECONDS = 600

# ---------------------------------------------------------------------------
# Analytics widgets -- a full query builder over this app's own captured
# data. A widget picks a dimension (what to group by -- the X axis), a
# measure (what to aggregate -- the Y axis), optional filters, a chart type
# and orientation, a size, and a position. Widgets live in sections, and
# sections live on pages -- each page is an independently named, reorderable
# sub-tab under the Analytics tab, so someone can build out e.g. a
# "Household Overview" page and a separate "Kids' Profiles" page, each with
# its own sections. The whole layout is saved server-side so it persists
# across sessions.
#
# DIMENSIONS/MEASURES are deliberately a fixed allowlist mapping straight to
# known-safe SQL fragments -- nothing here is ever built from a raw
# user-provided column/expression string, even though the person has a lot
# of freedom in how they combine these.
# ---------------------------------------------------------------------------
DIMENSIONS = {
    "user": {"label": "User", "expr": "user"},
    "title": {"label": "Title", "expr": "full_title"},
    "media_type": {"label": "Media Type", "expr": "media_type"},
    "platform": {"label": "Platform", "expr": "platform"},
    "product": {"label": "Product", "expr": "product"},
    "player": {"label": "Player / Device", "expr": "device"},
    "video_decision": {"label": "Playback Decision", "expr": "video_decision"},
    "library": {"label": "Library", "expr": "library_section"},
    "genre": {"label": "Genre", "expr": None},  # handled specially -- needs a json_each join
    # viewed_at is stored as naive UTC (see fmtDateTime's comment on the JS
    # side for the matching display-side logic). Every one of these four
    # time-based dimensions converts to the server's local time before
    # bucketing -- without 'localtime', a play just after local midnight
    # but still on the previous UTC day (or vice versa) would land in a
    # different day/hour/weekday bucket here than the local calendar date
    # it's displayed under everywhere else in the app (History table, Media
    # table, etc.), which is exactly the kind of mismatch that made an
    # Analytics widget's count for a given day disagree with the History
    # table's count for that same day.
    "day": {"label": "Date", "expr": "date(viewed_at, 'localtime')"},
    "hour_of_day": {"label": "Hour of Day", "expr": "CAST(strftime('%H', viewed_at, 'localtime') AS INTEGER)"},
    "weekday": {"label": "Day of Week", "expr": "CAST(strftime('%w', viewed_at, 'localtime') AS INTEGER)"},
    "month": {"label": "Month", "expr": "CAST(strftime('%m', viewed_at, 'localtime') AS INTEGER)"},
}

# Measures that only make sense computed once per row-group and then summed
# again (as genre does, since one title can carry several genres) --
# COUNT(*) and SUM(...) compose correctly through a second SUM; AVG(...) and
# COUNT(DISTINCT ...) do not, so genre deliberately doesn't offer those.
MEASURES = {
    "plays": {"label": "Play Count", "expr": "COUNT(*)", "genre_safe": True},
    "hours": {"label": "Hours Watched", "expr": "SUM(COALESCE(duration_ms, 0)) / 3600000.0", "genre_safe": True},
    "paused_hours": {
        "label": "Hours Paused",
        "expr": "SUM(COALESCE(paused_duration_ms, 0)) / 3600000.0",
        "genre_safe": True,
    },
    "distinct_users": {"label": "Distinct Users", "expr": "COUNT(DISTINCT user)", "genre_safe": False},
    "distinct_titles": {"label": "Distinct Titles", "expr": "COUNT(DISTINCT full_title)", "genre_safe": False},
    "avg_minutes": {
        "label": "Avg Minutes per Play",
        "expr": "AVG(COALESCE(duration_ms, 0)) / 60000.0",
        "genre_safe": False,
    },
}

WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]

SPECIAL_SOURCES = {
    "bandwidth_trend": {"label": "Concurrent Streams & Bandwidth (live, last 6h)", "chart_types": ["line", "area"]},
}

CHART_TYPES = ["bar", "line", "area", "donut", "pie", "table", "number"]

# A line/area widget can optionally split into multiple lines by a second
# dimension (e.g. "hours watched per day, one line per user"). Capped so a
# high-cardinality breakdown (e.g. by title) doesn't render 200 illegible
# lines -- the top series by total value in the visible window win, same
# idea as a widget's own limit/sort but applied to which lines get drawn
# rather than which bars.
MAX_WIDGET_SERIES = 8

DEFAULT_ANALYTICS_PAGES = [
    {
        "id": "page1",
        "name": "Overview",
        "sections": [
            {
                "id": "sec1",
                "title": "Overview",
                "period": "30d",
                "widgets": [
                    {"id": "w1", "mode": "query", "dimension": "user", "measure": "hours", "chart_type": "bar", "limit": 10, "sort": "desc", "sort_by": "value", "span": 6, "title": "Top Users"},
                    {"id": "w2", "mode": "query", "dimension": "title", "measure": "hours", "chart_type": "bar", "filters": {"media_type": "movie"}, "limit": 10, "sort": "desc", "sort_by": "value", "span": 3, "title": "Most Watched Movies"},
                    {"id": "w3", "mode": "query", "dimension": "title", "measure": "hours", "chart_type": "bar", "filters": {"media_type": "episode"}, "limit": 10, "sort": "desc", "sort_by": "value", "span": 3, "title": "Most Watched TV Shows"},
                    {"id": "w4", "mode": "query", "dimension": "genre", "measure": "plays", "chart_type": "donut", "filters": {"media_type": "movie"}, "limit": 8, "sort": "desc", "sort_by": "value", "span": 2, "title": "Movie Genres"},
                    {"id": "w5", "mode": "query", "dimension": "genre", "measure": "plays", "chart_type": "donut", "filters": {"media_type": "episode"}, "limit": 8, "sort": "desc", "sort_by": "value", "span": 2, "title": "TV Genres"},
                ],
            },
            {
                "id": "sec2",
                "title": "All-Time Patterns",
                "period": "all",
                "widgets": [
                    {"id": "w6", "mode": "query", "dimension": "hour_of_day", "measure": "plays", "chart_type": "bar", "limit": 24, "sort": "asc", "sort_by": "label", "span": 6, "title": "When People Watch"},
                ],
            },
        ],
    },
]


@app.route("/api/analytics/catalog")
@requires_auth
def api_analytics_catalog():
    return jsonify(
        {
            "ok": True,
            "dimensions": {k: {"label": v["label"]} for k, v in DIMENSIONS.items()},
            "measures": {k: {"label": v["label"]} for k, v in MEASURES.items()},
            "genre_safe_measures": [k for k, v in MEASURES.items() if v["genre_safe"]],
            "time_sequence_dimensions": sorted(TIME_SEQUENCE_DIMENSIONS),
            "special_sources": SPECIAL_SOURCES,
            "chart_types": CHART_TYPES,
        }
    )


@app.route("/api/analytics/filter-options")
@requires_auth
def api_analytics_filter_options():
    """Real distinct values already present in the data, so the edit form's
    filter dropdowns only ever offer choices that could actually return
    something."""
    with models.get_conn() as conn:
        users = [r["user"] for r in conn.execute("SELECT DISTINCT user FROM watch_history_valid WHERE user IS NOT NULL ORDER BY user COLLATE NOCASE").fetchall()]
        libraries = [r["library_section"] for r in conn.execute("SELECT DISTINCT library_section FROM watch_history_valid WHERE library_section IS NOT NULL ORDER BY library_section").fetchall()]
        platforms = [r["platform"] for r in conn.execute("SELECT DISTINCT platform FROM watch_history_valid WHERE platform IS NOT NULL ORDER BY platform").fetchall()]
    return jsonify(
        {
            "ok": True,
            "users": users,
            "libraries": libraries,
            "platforms": platforms,
            "video_decisions": ["direct_play", "direct_stream", "transcode"],
            "media_types": ["movie", "episode", "track"],
        }
    )


@app.route("/api/analytics/layout", methods=["GET"])
@requires_auth
def api_analytics_layout_get():
    """Analytics content is organized into pages (independently named,
    reorderable sub-tabs); each page holds its own sections, and each
    section owns one date-range selection that applies to every widget
    inside it, overriding anything the widget itself was configured with."""
    raw = models.get_setting("analytics_layout")
    pages = None
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                pages = parsed
        except (ValueError, TypeError):
            pass

    if pages is None:
        # Pre-multi-page installs stored a flat list of sections under the
        # old settings key -- migrate that into a single "Overview" page
        # rather than losing it, and persist the migration so this only
        # ever has to run once.
        legacy_raw = models.get_setting("trends_layout")
        if legacy_raw:
            try:
                legacy_sections = json.loads(legacy_raw)
            except (ValueError, TypeError):
                legacy_sections = None
            if isinstance(legacy_sections, list):
                pages = [{"id": "page1", "name": "Overview", "sections": legacy_sections}]
                models.set_setting("analytics_layout", json.dumps(pages))

    if pages is None:
        pages = DEFAULT_ANALYTICS_PAGES

    return jsonify({"ok": True, "pages": pages})


@app.route("/api/analytics/layout", methods=["POST"])
@requires_auth
def api_analytics_layout_save():
    body = request.get_json(silent=True) or {}
    pages = body.get("pages")
    if not isinstance(pages, list):
        return jsonify({"ok": False, "error": "pages must be a list"}), 400
    models.set_setting("analytics_layout", json.dumps(pages))
    return jsonify({"ok": True})


def _build_widget_filters(filters):
    """Turns a widget's filter dict into safe WHERE fragments. filters is a
    plain dict like {"media_type": "movie", "user": "todell33"} -- every key
    is checked against a fixed allowlist of real columns before use."""
    allowed = {
        "media_type": "media_type",
        "user": "user",
        "library": "library_section",
        "platform": "platform",
        "video_decision": "video_decision",
    }
    where = []
    params = []
    for key, col in allowed.items():
        value = (filters or {}).get(key)
        if value:
            where.append(f"{col} = ?")
            params.append(value)
    return where, params


TIME_SEQUENCE_DIMENSIONS = {"day"}  # dimensions where "most recent N" is a meaningful concept


@app.route("/api/analytics/widget-data")
@requires_auth
def api_analytics_widget_data():
    """The generic query-builder endpoint every non-special widget uses:
    group by `dimension`, aggregate with `measure`, apply optional filters
    and a time range, and return one normalized {labels, values} shape
    regardless of which combination was picked."""
    mode = request.args.get("mode", "query")

    if mode == "special":
        source = request.args.get("source", "")
        if source == "bandwidth_trend":
            bw_cutoff = (datetime.utcnow() - timedelta(hours=6)).isoformat()
            with models.get_conn() as conn:
                rows = conn.execute(
                    """
                    SELECT captured_at, COUNT(DISTINCT session_key) AS streams, SUM(bandwidth_kbps) AS total_kbps
                    FROM session_snapshots WHERE captured_at >= ? GROUP BY captured_at ORDER BY captured_at ASC
                    """,
                    (bw_cutoff,),
                ).fetchall()
            return jsonify(
                {
                    "ok": True,
                    "labels": [r["captured_at"] for r in rows],
                    "streams": [r["streams"] for r in rows],
                    "bandwidth_mbps": [round((r["total_kbps"] or 0) / 1000, 2) for r in rows],
                }
            )
        return jsonify({"ok": False, "error": "unknown special source"}), 400

    dimension = request.args.get("dimension", "")
    measure = request.args.get("measure", "plays")
    period = request.args.get("period", "30d")
    limit = int(request.args.get("limit", 10))
    sort_dir = "ASC" if request.args.get("sort", "desc") == "asc" else "DESC"
    # "value" ranks by the aggregated measure (e.g. most plays first); "label"
    # orders by the dimension itself instead -- for a date/month sequence
    # that's chronological order, which a line chart needs to make sense at
    # all, and for anything else it's a straightforward alphabetical/numeric
    # sort (e.g. platforms A-Z).
    sort_by = request.args.get("sort_by", "value")
    # Only meaningful for line/area widgets -- splits the single series into
    # one line per distinct value of this second dimension. Validated below
    # once DIMENSIONS/measure/genre checks have already run.
    series_by = request.args.get("series_by", "")
    # Also only meaningful for line/area -- a second, independently-scaled
    # measure plotted as its own line (e.g. Play Count alongside Play Hours
    # on the same chart), rather than a breakdown of the same measure by
    # another dimension. Mutually exclusive with series_by -- see below.
    measure2 = request.args.get("measure2", "")
    # Only meaningful for table widgets -- one extra column per measure
    # listed here, alongside the primary measure. Comma-separated rather
    # than repeated params since a table can reasonably show several.
    extra_measures = [m.strip() for m in request.args.get("extra_measures", "").split(",") if m.strip()]
    filters = {
        "media_type": request.args.get("f_media_type", ""),
        "user": request.args.get("f_user", ""),
        "library": request.args.get("f_library", ""),
        "platform": request.args.get("f_platform", ""),
        "video_decision": request.args.get("f_video_decision", ""),
    }

    if dimension not in DIMENSIONS:
        return jsonify({"ok": False, "error": "unknown dimension"}), 400
    if measure not in MEASURES:
        return jsonify({"ok": False, "error": "unknown measure"}), 400

    cutoff = period_to_cutoff(period)
    where, params = _build_widget_filters(filters)
    if cutoff:
        where.append("viewed_at >= ?")
        params.append(cutoff)

    measure_expr = MEASURES[measure]["expr"]

    if dimension == "genre":
        if not MEASURES[measure]["genre_safe"]:
            return jsonify({"ok": False, "error": f"'{MEASURES[measure]['label']}' can't be broken down by genre"}), 400
        inner_where = ["genre_key IS NOT NULL"] + where
        order_col = "label" if sort_by == "label" else "value"
        query = f"""
            SELECT j.value AS label, SUM(t.value) AS value
            FROM (
                SELECT genre_key, {measure_expr} AS value
                FROM watch_history_valid
                WHERE {" AND ".join(inner_where)}
                GROUP BY genre_key
            ) t
            JOIN media_genre_cache c ON c.rating_key = t.genre_key
            JOIN json_each(c.genres) j
            GROUP BY j.value
            ORDER BY {order_col} {sort_dir}
            LIMIT ?
        """
        query_params = params + [limit]
        with models.get_conn() as conn:
            rows = conn.execute(query, query_params).fetchall()
        labels = [r["label"] for r in rows]
        values = [r["value"] for r in rows]
    else:
        dim_expr = DIMENSIONS[dimension]["expr"]
        dim_where = where + [f"{dim_expr} IS NOT NULL"]
        extra_select = ""
        if dimension == "title":
            # Preserve click-through to the movie/show detail page: each
            # title's rows should all share one media identity and type, so
            # MAX() here is just "pick the (consistent) value", not a real
            # aggregation choice.
            extra_select = ", MAX(genre_key) AS media_key, MAX(media_type) AS item_media_type"

        if dimension == "day":
            # A day with zero plays should show as a zero on a line/area
            # chart, not be missing from the X axis entirely -- a gap reads
            # as "no data" rather than "nothing happened that day". So this
            # builds the full calendar-day sequence in Python and zero-fills
            # it, rather than only returning days that actually had a row.
            #
            # Anchored on *local* today (matching dim_expr's 'localtime'
            # bucketing above) rather than UTC today -- using UTC here would
            # reintroduce the exact mismatch this whole change fixes, just
            # at the zero-fill boundary instead of the grouping itself.
            end_date = datetime.now().date()
            period_days = {"7d": 7, "30d": 30, "60d": 60, "90d": 90}.get(period)
            if period_days:
                start_date = end_date - timedelta(days=period_days)
            else:
                # "All time" has no fixed start -- use the earliest day this
                # specific filtered query actually has data for, so it
                # doesn't zero-fill years of nothing before someone's first
                # recorded play.
                with models.get_conn() as conn:
                    earliest_where = f"WHERE {' AND '.join(where)}" if where else ""
                    earliest = conn.execute(
                        f"SELECT MIN(date(viewed_at, 'localtime')) AS d FROM watch_history_valid {earliest_where}",
                        params,
                    ).fetchone()["d"]
                start_date = datetime.fromisoformat(earliest).date() if earliest else end_date

            all_days = []
            d = start_date
            while d <= end_date:
                all_days.append(d.isoformat())
                d += timedelta(days=1)
            # Unlike every other dimension, "Date" doesn't have a "Top
            # Count" concept in the widget modal -- the number of days
            # shown is exactly the section's own date range, in full,
            # zero-filled. No limit-based trimming here.

            query = f"""
                SELECT {dim_expr} AS label, {measure_expr} AS value{extra_select}
                FROM watch_history_valid
                WHERE {" AND ".join(dim_where)}
                GROUP BY {dim_expr}
            """
            with models.get_conn() as conn:
                day_rows = conn.execute(query, params).fetchall()
            value_by_day = {r["label"]: r["value"] for r in day_rows}

            labels = list(reversed(all_days)) if sort_dir == "DESC" else all_days
            values = [value_by_day.get(day, 0) for day in labels]
        elif sort_by == "label" and dimension in TIME_SEQUENCE_DIMENSIONS:
            # Limiting a chronological sort naively (e.g. ORDER BY date ASC
            # LIMIT 30) would return the OLDEST 30 dates in range, not the
            # most recent ones -- almost never what you want on a line
            # chart. Grab the most recent `limit` periods first, then
            # re-apply the person's chosen final display direction.
            query = f"""
                SELECT * FROM (
                    SELECT {dim_expr} AS label, {measure_expr} AS value{extra_select}
                    FROM watch_history_valid
                    WHERE {" AND ".join(dim_where)}
                    GROUP BY {dim_expr}
                    ORDER BY {dim_expr} DESC
                    LIMIT ?
                ) recent
                ORDER BY label {sort_dir}
            """
            query_params = params + [limit]
            with models.get_conn() as conn:
                rows = conn.execute(query, query_params).fetchall()
            labels = [r["label"] for r in rows]
            values = [r["value"] for r in rows]
        else:
            order_col = dim_expr if sort_by == "label" else "value"
            query = f"""
                SELECT {dim_expr} AS label, {measure_expr} AS value{extra_select}
                FROM watch_history_valid
                WHERE {" AND ".join(dim_where)}
                GROUP BY {dim_expr}
                ORDER BY {order_col} {sort_dir}
                LIMIT ?
            """
            query_params = params + [limit]
            with models.get_conn() as conn:
                rows = conn.execute(query, query_params).fetchall()
            labels = [r["label"] for r in rows]
            values = [r["value"] for r in rows]

    # A second-dimension breakdown only makes sense against the normal
    # dimension branch (genre's grouping already goes through a json_each
    # join per label, not a simple GROUP BY this can reuse), against a
    # *different* dimension than the one already on the X axis, and only
    # once there's actually an X axis to plot each line against.
    series_data = None
    series_label = None
    dual_measure = False
    if (
        dimension != "genre"
        and series_by
        and series_by in DIMENSIONS
        and series_by != "genre"
        and series_by != dimension
        and labels
    ):
        series_expr = DIMENSIONS[series_by]["expr"]
        series_where = where + [f"{dim_expr} IS NOT NULL", f"{series_expr} IS NOT NULL"]
        placeholders = ",".join("?" for _ in labels)
        series_query = f"""
            SELECT {dim_expr} AS label, {series_expr} AS series, {measure_expr} AS value
            FROM watch_history_valid
            WHERE {" AND ".join(series_where)} AND {dim_expr} IN ({placeholders})
            GROUP BY {dim_expr}, {series_expr}
        """
        with models.get_conn() as conn:
            series_rows = conn.execute(series_query, params + labels).fetchall()

        pair_values = {}
        series_totals = {}
        for r in series_rows:
            pair_values[(r["label"], r["series"])] = r["value"]
            series_totals[r["series"]] = series_totals.get(r["series"], 0) + (r["value"] or 0)

        top_series = sorted(series_totals, key=lambda s: series_totals[s], reverse=True)[:MAX_WIDGET_SERIES]
        series_data = [
            {"label": str(s), "values": [pair_values.get((l, s), 0) for l in labels]}
            for s in top_series
        ]
        series_label = DIMENSIONS[series_by]["label"]
    elif (
        dimension != "genre"
        and measure2
        and measure2 in MEASURES
        and measure2 != measure
        and labels
    ):
        # A second, independently-scaled measure as its own line (e.g. Play
        # Count alongside Play Hours) -- reuses the exact same
        # already-zero-filled/finalized `labels` set measure 1 landed on, so
        # the two lines share an X axis with no extra work here.
        measure2_expr = MEASURES[measure2]["expr"]
        dim_where2 = where + [f"{dim_expr} IS NOT NULL"]
        placeholders = ",".join("?" for _ in labels)
        measure2_query = f"""
            SELECT {dim_expr} AS label, {measure2_expr} AS value
            FROM watch_history_valid
            WHERE {" AND ".join(dim_where2)} AND {dim_expr} IN ({placeholders})
            GROUP BY {dim_expr}
        """
        with models.get_conn() as conn:
            measure2_rows = conn.execute(measure2_query, params + labels).fetchall()
        value2_by_label = {r["label"]: r["value"] for r in measure2_rows}
        series_data = [
            {"label": MEASURES[measure]["label"], "values": values},
            {"label": MEASURES[measure2]["label"], "values": [value2_by_label.get(l, 0) for l in labels]},
        ]
        dual_measure = True

    # Table-only: one extra column per measure in extra_measures, alongside
    # the primary measure column. Independent of series_by/measure2 above --
    # those only ever apply to line/area widgets, this only to table
    # widgets, so there's no real overlap between them in practice.
    extra_columns = None
    if dimension != "genre" and extra_measures and labels:
        dim_where_extra = where + [f"{dim_expr} IS NOT NULL"]
        placeholders = ",".join("?" for _ in labels)
        extra_columns = []
        for m_key in extra_measures:
            if m_key not in MEASURES or m_key == measure:
                continue
            m_expr = MEASURES[m_key]["expr"]
            extra_query = f"""
                SELECT {dim_expr} AS label, {m_expr} AS value
                FROM watch_history_valid
                WHERE {" AND ".join(dim_where_extra)} AND {dim_expr} IN ({placeholders})
                GROUP BY {dim_expr}
            """
            with models.get_conn() as conn:
                extra_rows = conn.execute(extra_query, params + labels).fetchall()
            value_by_label = {r["label"]: r["value"] for r in extra_rows}
            extra_columns.append(
                {"label": MEASURES[m_key]["label"], "values": [value_by_label.get(l, 0) for l in labels]}
            )

    if dimension == "weekday":
        labels = [WEEKDAY_NAMES[int(l)] if l is not None and 0 <= int(l) <= 6 else str(l) for l in labels]
    elif dimension == "month":
        labels = [MONTH_NAMES[int(l) - 1] if l is not None and 1 <= int(l) <= 12 else str(l) for l in labels]
    # hour_of_day is intentionally left as raw integers (0-23) here -- the
    # frontend formats these itself against the live 12h/24h Settings >
    # General preference, the same way "day" labels are formatted
    # client-side rather than baked in server-side.

    result = {
        "ok": True,
        "labels": labels,
        "dimension": dimension,
        "value_label": MEASURES[measure]["label"],
        "dimension_label": DIMENSIONS[dimension]["label"],
    }
    if series_data:
        result["series"] = series_data
        if dual_measure:
            result["dual_measure"] = True
        else:
            result["series_label"] = series_label
    else:
        result["values"] = values
    if extra_columns:
        result["extra_columns"] = extra_columns
    if dimension == "title":
        result["clickable"] = "media"
        result["media_keys"] = [r["media_key"] for r in rows]
        result["media_types"] = [r["item_media_type"] for r in rows]
    elif dimension == "user":
        result["clickable"] = "user"

    return jsonify(result)


@app.route("/api/stats/top-genres")
@requires_auth
def api_top_genres():
    period = request.args.get("period", "30d")
    limit = int(request.args.get("limit", 6))
    media_type = request.args.get("type", "movie")  # "movie" or "episode"
    cutoff = period_to_cutoff(period)
    items = models.get_top_genres(media_type, cutoff=cutoff, limit=limit)
    return jsonify({"ok": True, "items": items})


# ---------------------------------------------------------------------------
# API: aggregated stats
# ---------------------------------------------------------------------------
@app.route("/api/stats/top-media")
@requires_auth
def api_top_media():
    period = request.args.get("period", "30d")
    limit = int(request.args.get("limit", 10))
    media_type = request.args.get("type", "movie")  # "movie" or "episode"
    user = request.args.get("user")  # optional -- scopes results to one user, e.g. for the user drilldown page
    sort = request.args.get("sort", "plays")  # "plays" (Most Popular) or "hours" (Most Watched)
    cutoff = period_to_cutoff(period)

    # Movies are grouped by their own title. TV episodes are grouped by the
    # show they belong to (grandparent_title), so "Top TV Shows" ranks shows
    # rather than fragmenting plays across each individual episode.
    if media_type == "episode":
        group_expr = "COALESCE(grandparent_title, full_title)"
    else:
        group_expr = "full_title"

    sort_col = "hours" if sort == "hours" else "plays"

    query = f"""
        SELECT {group_expr} AS full_title, ? AS media_type, COUNT(*) AS plays,
               SUM(COALESCE(duration_ms, 0)) / 3600000.0 AS hours,
               MAX(thumb) AS thumb, MAX(genre_key) AS media_key
        FROM watch_history_valid
        WHERE media_type = ?
    """
    params = [media_type, media_type]
    if user:
        query += " AND user = ?"
        params.append(user)
    if cutoff:
        query += " AND viewed_at >= ?"
        params.append(cutoff)
    query += f" GROUP BY {group_expr} ORDER BY {sort_col} DESC LIMIT ?"
    params.append(limit)

    with models.get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
    return jsonify({"ok": True, "items": [dict(r) for r in rows]})


@app.route("/api/media/details")
@requires_auth
def api_media_details():
    """Full metadata for one movie or show -- cached after the first fetch,
    since a synopsis/cast/director don't change once you've watched it."""
    key = request.args.get("key", "")
    if not key:
        return jsonify({"ok": False, "error": "missing key"}), 400

    cached = models.get_cached_details(key)
    if cached:
        return jsonify({"ok": True, "details": cached})

    try:
        plex = plex_client.connect()
        details = plex_client.fetch_media_details(plex, key)
        models.save_details_cache(key, details)
        return jsonify({"ok": True, "details": details})
    except Exception as e:
        log.warning("Could not fetch media details for key %s: %s", key, e)
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/media/history")
@requires_auth
def api_media_history():
    """Who watched this specific movie/show, most recent first."""
    key = request.args.get("key", "")
    media_type = request.args.get("type", "movie")
    page = max(int(request.args.get("page", 1)), 1)
    page_size = min(int(request.args.get("page_size", 25)), 200)
    if not key:
        return jsonify({"ok": False, "error": "missing key"}), 400

    total, rows = models.get_media_watch_events(key, media_type, page=page, page_size=page_size)
    return jsonify({"ok": True, "total": total, "page": page, "page_size": page_size, "rows": rows})


@app.route("/api/poster")
@requires_auth
def api_poster():
    """Proxy poster/headshot art. Two cases: a path relative to your own Plex
    server (e.g. movie/show posters) which needs your Plex token, or a full
    external URL (actor headshots are often hosted externally, e.g. on
    TheMovieDB, by Plex's metadata agents) which doesn't. Either way the
    browser never sees your Plex token or talks to Plex/third parties directly."""
    path = request.args.get("path", "")
    if not path:
        return "", 400

    if path.startswith("http://") or path.startswith("https://"):
        parsed = urlparse(path)
        host = (parsed.hostname or "").lower()
        # Basic SSRF guard: block obviously-internal targets. This proxies
        # external image URLs that originated from Plex's own metadata, not
        # arbitrary user input, but block the easy cases anyway.
        blocked_prefixes = ("127.", "10.", "169.254.", "0.")
        blocked_exact = ("localhost",)
        if host in blocked_exact or host.startswith("192.168.") or any(host.startswith(p) for p in blocked_prefixes):
            return "", 400
        if host.startswith("172.") and host.split(".")[1].isdigit() and 16 <= int(host.split(".")[1]) <= 31:
            return "", 400
        url = path
        req_params = {}
    elif path.startswith("/") and "/library/" in path:
        url = f"{plex_client.get_server_url()}{path}"
        req_params = {"X-Plex-Token": plex_client.get_token()}
    else:
        return "", 400

    try:
        resp = requests.get(url, params=req_params, timeout=10)
        resp.raise_for_status()
        return Response(
            resp.content,
            mimetype=resp.headers.get("Content-Type", "image/jpeg"),
            headers={"Cache-Control": "public, max-age=86400"},
        )
    except Exception as e:
        log.warning("Poster fetch failed for %s: %s", path, e)
        return "", 502


@app.route("/api/libraries")
@requires_auth
def api_libraries():
    """Combines Plex's own catalog totals (how much is in each library) with
    this app's watch-history aggregates (how much of it has been streamed)."""
    catalog = models.get_library_stats()
    watch_summary = models.get_library_watch_summary()

    results = []
    for lib in catalog:
        summary = watch_summary.get(lib["name"], {})
        results.append(
            {
                "name": lib["name"],
                "type": lib["type"],
                "total_items": lib["total_items"],
                "total_seasons": lib["total_seasons"],
                "total_episodes": lib["total_episodes"],
                "last_streamed": summary.get("last_streamed"),
                "last_played_title": summary.get("last_played_title"),
                "last_played_type": summary.get("last_played_type"),
                "last_played_season": summary.get("last_played_season"),
                "last_played_episode": summary.get("last_played_episode"),
                "total_plays": summary.get("total_plays", 0),
                "total_duration_ms": summary.get("total_duration_ms", 0),
            }
        )
    return jsonify({"ok": True, "libraries": results})


@app.route("/api/libraries/sync", methods=["POST"])
@requires_auth
def api_libraries_sync():
    """Manually refresh library catalog totals from Plex right now, instead
    of waiting for the next scheduled background sync."""
    try:
        poller.sync_libraries()
        _library_genres_cache.clear()
        return jsonify({"ok": True})
    except Exception as e:
        log.error("Manual library sync failed: %s", e)
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/libraries/detail")
@requires_auth
def api_library_detail():
    """Everything the library drilldown page needs: watch-history stats
    broken into time buckets, per-user totals, recent plays, and (live from
    Plex) what's recently been added to the catalog."""
    name = request.args.get("name", "")
    if not name:
        return jsonify({"ok": False, "error": "missing name"}), 400

    catalog = models.get_library_stats()
    lib_entry = next((l for l in catalog if l["name"] == name), None)

    recently_added = []
    if lib_entry:
        try:
            plex = plex_client.connect()
            recently_added = plex_client.fetch_recently_added(plex, lib_entry["library_key"], limit=12)
        except Exception as e:
            log.warning("Could not fetch recently added for library %s: %s", name, e)

    return jsonify(
        {
            "ok": True,
            "name": name,
            "type": lib_entry["type"] if lib_entry else None,
            "period_stats": models.get_library_period_stats(name),
            "user_stats": models.get_library_user_stats(name),
            "recent_plays": models.get_library_recent_plays(name, limit=12),
            "recently_added": recently_added,
        }
    )


def _library_entry_by_name(name):
    catalog = models.get_library_stats()
    return next((l for l in catalog if l["name"] == name), None)


def _library_key_by_name(name):
    entry = _library_entry_by_name(name)
    return entry["library_key"] if entry else None


@app.route("/api/libraries/media")
@requires_auth
def api_library_media():
    """A page of the library's full catalog (the 'Media' sub-tab), live from
    Plex -- paginated rather than pulling the entire catalog at once, since
    a library can hold thousands of items. Total Plays / Last Played come
    from this app's own watch history, not Plex, since Plex's own play
    count doesn't distinguish sources the way this app's history does.

    total_pages is computed from the library's cached total item count
    (refreshed periodically by the background library sync, not fetched
    live here) divided by page_size -- getting an exact count of items
    matching the current search/genre filter would mean asking Plex to
    scan the whole library on every request, which is the same cost that
    made this page slow before. So the page-number bar is sized off the
    library's overall total rather than the filtered result count -- with
    a filter active, the last few page numbers may occasionally run past
    the actual last page of matches."""
    name = request.args.get("name", "")
    search = request.args.get("search", "").strip()
    genre = request.args.get("genre", "").strip()
    page = max(int(request.args.get("page", 1)), 1)
    page_size = int(request.args.get("page_size", 50))
    if page_size not in (25, 50, 75, 100):
        page_size = 50
    if not name:
        return jsonify({"ok": False, "error": "missing name"}), 400
    entry = _library_entry_by_name(name)
    if not entry:
        return jsonify({"ok": False, "error": "unknown library"}), 404
    library_key = entry["library_key"]
    total_items = entry["total_items"] or 0
    total_pages = max((total_items + page_size - 1) // page_size, 1)
    try:
        plex = plex_client.connect()
        items, has_next = plex_client.fetch_library_media(
            plex, library_key, search=search or None, genre=genre or None, page=page, page_size=page_size
        )
        rating_keys = [i["rating_key"] for i in items if i.get("rating_key")]
        play_stats = models.get_play_stats_for_keys(rating_keys)
        for item in items:
            stats = play_stats.get(item.get("rating_key")) or {}
            item["total_plays"] = stats.get("plays", 0)
            item["last_played"] = stats.get("last_played")
        return jsonify(
            {
                "ok": True,
                "items": items,
                "page": page,
                "page_size": page_size,
                "has_next": has_next,
                "total_pages": total_pages,
                "library_type": entry["type"],
            }
        )
    except Exception as e:
        log.warning("Could not fetch media for library %s: %s", name, e)
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/libraries/media-genres")
@requires_auth
def api_library_media_genres():
    """Every genre Plex knows about for this library, for the Media tab's
    genre filter dropdown. Computing this list is one of the more expensive
    things Plex can be asked to do on a large library (it has to scan the
    whole section's metadata to build the facet), and the genre list itself
    changes rarely -- so this is cached in memory per library rather than
    re-fetched from Plex on every single visit to the Media tab, which was
    making the tab noticeably slower to open every time."""
    name = request.args.get("name", "")
    if not name:
        return jsonify({"ok": False, "error": "missing name"}), 400
    library_key = _library_key_by_name(name)
    if not library_key:
        return jsonify({"ok": False, "error": "unknown library"}), 404

    cached = _library_genres_cache.get(library_key)
    now = time.monotonic()
    if cached and (now - cached[1]) < LIBRARY_GENRES_CACHE_TTL_SECONDS:
        return jsonify({"ok": True, "genres": cached[0]})

    try:
        plex = plex_client.connect()
        genres = plex_client.fetch_library_genres(plex, library_key)
        _library_genres_cache[library_key] = (genres, now)
        return jsonify({"ok": True, "genres": genres})
    except Exception as e:
        log.warning("Could not fetch genres for library %s: %s", name, e)
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/libraries/media/albums")
@requires_auth
def api_library_media_albums():
    """Every album for one artist -- the Media tab's expandable artist row,
    for a Music-type library (e.g. every book by an author, for an
    audiobook library set up that way)."""
    artist_key = request.args.get("artist_key", "")
    if not artist_key:
        return jsonify({"ok": False, "error": "missing artist_key"}), 400
    try:
        plex = plex_client.connect()
        albums = plex_client.fetch_artist_albums(plex, artist_key)
        return jsonify({"ok": True, "albums": albums})
    except Exception as e:
        log.warning("Could not fetch albums for artist %s: %s", artist_key, e)
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/libraries/media/tracks")
@requires_auth
def api_library_media_tracks():
    """Every track for one album -- the Media tab's expandable album row,
    nested inside an expanded artist row."""
    album_key = request.args.get("album_key", "")
    if not album_key:
        return jsonify({"ok": False, "error": "missing album_key"}), 400
    try:
        plex = plex_client.connect()
        tracks = plex_client.fetch_album_tracks(plex, album_key)
        return jsonify({"ok": True, "tracks": tracks})
    except Exception as e:
        log.warning("Could not fetch tracks for album %s: %s", album_key, e)
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/libraries/collections")
@requires_auth
def api_library_collections():
    name = request.args.get("name", "")
    if not name:
        return jsonify({"ok": False, "error": "missing name"}), 400
    library_key = _library_key_by_name(name)
    if not library_key:
        return jsonify({"ok": False, "error": "unknown library"}), 404
    try:
        plex = plex_client.connect()
        collections = plex_client.fetch_collections(plex, library_key)
        return jsonify({"ok": True, "collections": collections})
    except Exception as e:
        log.warning("Could not fetch collections for library %s: %s", name, e)
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/libraries/playlists")
@requires_auth
def api_library_playlists():
    name = request.args.get("name", "")
    if not name:
        return jsonify({"ok": False, "error": "missing name"}), 400
    library_key = _library_key_by_name(name)
    if not library_key:
        return jsonify({"ok": False, "error": "unknown library"}), 404
    try:
        plex = plex_client.connect()
        playlists = plex_client.fetch_playlists(plex, library_key)
        return jsonify({"ok": True, "playlists": playlists})
    except Exception as e:
        log.warning("Could not fetch playlists for library %s: %s", name, e)
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/users/summary")
@requires_auth
def api_users_summary():
    """One row per user with lifetime totals -- powers the Users page table.
    Includes everyone with access to the server, not just people who've
    actually watched something (see plex_client.fetch_server_users) -- those
    rows just get zeroed-out stats and a null last-viewed date."""
    query = """
        SELECT user,
               COUNT(*) AS total_plays,
               SUM(CASE WHEN media_type = 'movie' THEN 1 ELSE 0 END) AS total_movies,
               SUM(CASE WHEN media_type = 'episode' THEN 1 ELSE 0 END) AS total_episodes,
               SUM(COALESCE(duration_ms, 0)) / 3600000.0 AS total_hours,
               MAX(viewed_at) AS last_viewed_at
        FROM watch_history_valid
        GROUP BY user
        ORDER BY user COLLATE NOCASE ASC
    """
    with models.get_conn() as conn:
        rows = [dict(r) for r in conn.execute(query).fetchall()]

    now = datetime.utcnow()
    for r in rows:
        try:
            last = datetime.fromisoformat(r["last_viewed_at"])
            r["days_since_last_stream"] = (now - last).days
        except (TypeError, ValueError):
            r["days_since_last_stream"] = None

    existing_names = {r["user"] for r in rows}
    for name in models.get_cached_server_users():
        if name not in existing_names:
            rows.append(
                {
                    "user": name,
                    "total_plays": 0,
                    "total_movies": 0,
                    "total_episodes": 0,
                    "total_hours": 0,
                    "last_viewed_at": None,
                    "days_since_last_stream": None,
                }
            )
    rows.sort(key=lambda r: r["user"].lower())

    return jsonify({"ok": True, "items": rows})


@app.route("/api/users/sync", methods=["POST"])
@requires_auth
def api_users_sync():
    """Refreshes the cached list of everyone with access to the server right
    now, on demand -- mirrors /api/libraries/sync."""
    try:
        plex = plex_client.connect()
        users = plex_client.fetch_server_users(plex)
        models.save_server_users(users)
        return jsonify({"ok": True, "users": users})
    except Exception as e:
        log.warning("Could not sync Plex server users: %s", e)
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/stats/top-users")
@requires_auth
def api_top_users():
    period = request.args.get("period", "30d")
    limit = int(request.args.get("limit", 10))
    cutoff = period_to_cutoff(period)

    query = """
        SELECT user, COUNT(*) AS plays,
               SUM(COALESCE(duration_ms, 0)) / 3600000.0 AS hours
        FROM watch_history_valid
    """
    params = []
    if cutoff:
        query += " WHERE viewed_at >= ?"
        params.append(cutoff)
    query += " GROUP BY user ORDER BY hours DESC LIMIT ?"
    params.append(limit)

    with models.get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
    return jsonify({"ok": True, "items": [dict(r) for r in rows]})


@app.route("/api/stats/activity-by-hour")
@requires_auth
def api_activity_by_hour():
    period = request.args.get("period", "30d")
    cutoff = period_to_cutoff(period)

    query = "SELECT viewed_at FROM watch_history_valid"
    params = []
    if cutoff:
        query += " WHERE viewed_at >= ?"
        params.append(cutoff)

    with models.get_conn() as conn:
        rows = conn.execute(query, params).fetchall()

    buckets = [0] * 24
    for r in rows:
        try:
            # viewed_at is naive UTC -- explicitly mark it as such, then
            # convert to the server's local time before bucketing by hour,
            # the same fix applied to the Analytics "Hour of Day" dimension
            # and for the same reason (a play just after local midnight
            # would otherwise land in the wrong hour's bucket).
            dt_utc = datetime.fromisoformat(r["viewed_at"]).replace(tzinfo=timezone.utc)
            hour = dt_utc.astimezone().hour
            buckets[hour] += 1
        except Exception:
            pass
    return jsonify({"ok": True, "buckets": buckets})


# ---------------------------------------------------------------------------
# API: raw history table (paginated, searchable, filterable)
# ---------------------------------------------------------------------------
# Maps the sortable column keys the frontend sends to actual DB columns --
# kept as an explicit allowlist rather than trusting the query string
# directly, since this feeds straight into an ORDER BY clause.
HISTORY_SORT_COLUMNS = {
    "date": "viewed_at",
    "user": "user",
    "ip": "ip_address",
    "platform": "platform",
    "product": "product",
    "player": "device",
    "title": "full_title",
    "type": "media_type",
    "started": "start_time",
    "paused": "paused_duration_ms",
    "stopped": "stopped_time",
    "duration": "duration_ms",
}
# Text columns get case-insensitive sorting so lowercase names don't all end
# up sorted after every uppercase one (SQLite's default collation is
# case-sensitive ASCII order).
HISTORY_TEXT_SORT_KEYS = {"user", "ip", "platform", "product", "player", "title", "type"}


@app.route("/api/history/table")
@requires_auth
def api_history_table():
    page = max(int(request.args.get("page", 1)), 1)
    page_size = min(int(request.args.get("page_size", 25)), 200)
    search = request.args.get("search", "").strip()
    user = request.args.get("user", "").strip()
    media_type = request.args.get("type", "").strip()  # "movie" or "episode"
    video_decision = request.args.get("decision", "").strip()  # "direct_play" | "direct_stream" | "transcode"
    library = request.args.get("library", "").strip()
    sort_key = request.args.get("sort", "date")
    sort_dir = "ASC" if request.args.get("dir", "desc").lower() == "asc" else "DESC"
    sort_col = HISTORY_SORT_COLUMNS.get(sort_key, "viewed_at")
    collate = "COLLATE NOCASE " if sort_key in HISTORY_TEXT_SORT_KEYS else ""

    where = []
    params = []
    if search:
        where.append("full_title LIKE ?")
        params.append(f"%{search}%")
    if user:
        where.append("user = ?")
        params.append(user)
    if media_type:
        where.append("media_type = ?")
        params.append(media_type)
    if video_decision:
        where.append("video_decision = ?")
        params.append(video_decision)
    if library:
        where.append("library_section = ?")
        params.append(library)
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""

    with models.get_conn() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) AS c FROM watch_history_valid {where_sql}", params
        ).fetchone()["c"]
        rows = conn.execute(
            f"""
            SELECT history_key, viewed_at, user, full_title, media_type, duration_ms,
                   platform, product, device, ip_address, video_decision,
                   start_time, paused_time, stopped_time, paused_duration_ms, genre_key AS media_key
            FROM watch_history_valid
            {where_sql}
            ORDER BY {sort_col} {collate}{sort_dir}
            LIMIT ? OFFSET ?
            """,
            params + [page_size, (page - 1) * page_size],
        ).fetchall()

    return jsonify(
        {
            "ok": True,
            "total": total,
            "page": page,
            "page_size": page_size,
            "rows": [dict(r) for r in rows],
        }
    )


@app.route("/api/history/pauses")
@requires_auth
def api_history_pauses():
    """Individual pause/resume segments for one history row -- powers the
    expandable row in the History table."""
    history_key = request.args.get("key", "")
    if not history_key:
        return jsonify({"ok": False, "error": "missing key"}), 400
    segments = models.get_pause_segments(history_key)
    return jsonify({"ok": True, "segments": segments})


@app.route("/api/users")
@requires_auth
def api_users():
    with models.get_conn() as conn:
        rows = conn.execute(
            "SELECT DISTINCT user FROM watch_history_valid ORDER BY user"
        ).fetchall()
    return jsonify({"ok": True, "users": [r["user"] for r in rows]})


@app.route("/api/history/sync", methods=["POST"])
@requires_auth
def api_history_sync():
    """Manually pull the latest watch history from Plex right now, instead of
    waiting for the next scheduled background sync."""
    try:
        poller.sync_history(initial=False)
        return jsonify({"ok": True})
    except Exception as e:
        log.error("Manual history sync failed: %s", e)
        return jsonify({"ok": False, "error": str(e)})


# In-memory status for the (potentially long-running) Tautulli import, so the
# browser can poll progress instead of holding one HTTP request open for
# however long a large history import takes.
_tautulli_import_state = {"status": "idle"}  # idle | running | done | error


@app.route("/api/import/tautulli", methods=["POST"])
@requires_auth
def api_import_tautulli_start():
    if _tautulli_import_state.get("status") == "running":
        return jsonify({"ok": False, "error": "An import is already running."}), 409

    body = request.get_json(silent=True) or {}
    base_url = (body.get("base_url") or "").strip()
    api_key = (body.get("api_key") or "").strip()
    if not base_url or not api_key:
        return jsonify({"ok": False, "error": "Tautulli URL and API key are both required."}), 400

    _tautulli_import_state.clear()
    _tautulli_import_state["status"] = "running"

    def _run():
        try:
            result = tautulli_import.import_history(base_url, api_key, models)
            # Newly-imported rows won't have a library yet -- reuse the same
            # backfill already used for older locally-tracked history.
            backfilled = models.backfill_missing_library_sections()
            _tautulli_import_state["status"] = "done"
            _tautulli_import_state["result"] = {**result, "library_backfilled": backfilled}
        except Exception as e:
            log.error("Tautulli import failed: %s", e)
            _tautulli_import_state["status"] = "error"
            _tautulli_import_state["error"] = str(e)

    threading.Thread(target=_run, daemon=True).start()
    return jsonify({"ok": True, "status": "running"})


@app.route("/api/import/tautulli/status")
@requires_auth
def api_import_tautulli_status():
    return jsonify({"ok": True, **_tautulli_import_state})


@app.route("/api/history/entry/<path:history_key>", methods=["DELETE"])
@requires_auth
def api_history_delete_entry(history_key):
    """Permanently deletes one specific watch history row. Destructive and
    irreversible -- the frontend is expected to have already confirmed this
    before calling it, same as Clear Watch History below."""
    try:
        deleted = models.delete_history_entry(history_key)
        if not deleted:
            return jsonify({"ok": False, "error": "No matching history entry found."}), 404
        return jsonify({"ok": True})
    except Exception as e:
        log.error("Deleting history entry %r failed: %s", history_key, e)
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/history/clear", methods=["POST"])
@requires_auth
def api_history_clear():
    """Permanently deletes all watch history. Destructive and irreversible --
    the frontend is expected to have already confirmed this with the person
    before calling it."""
    try:
        deleted = models.clear_watch_history()
        return jsonify({"ok": True, "deleted": deleted})
    except Exception as e:
        log.error("Clearing watch history failed: %s", e)
        return jsonify({"ok": False, "error": str(e)}), 500


# Settings > Plex Media Server -- host/port/secure-connection are editable
# here now instead of only via .env (see plex_client.get_plex_server_settings
# for the precedence/migration details). Modeled on Tautulli's own "Plex
# Media Server" settings page: a host+port+secure-connection combo that
# builds the actual server URL, a live "Verify Server" check against
# whatever's currently in those fields (not necessarily saved yet), and a
# Plex.tv Authentication section that reuses this app's existing OAuth
# login flow rather than a separate token-entry field.
@app.route("/api/settings/plex-server", methods=["GET"])
@requires_auth
def api_settings_plex_server_get():
    settings = plex_client.get_plex_server_settings()
    settings["url"] = plex_client.build_plex_url(settings)
    return jsonify(
        {
            "ok": True,
            "settings": settings,
            "connected": bool(plex_client.get_token()),
            "username": models.get_setting("plex_username"),
        }
    )


def _apply_plex_server_body(body):
    """Shared between Save and Verify -- both start from the currently
    saved settings and apply whatever fields the request included, so
    either can be called with a partial body."""
    settings = plex_client.get_plex_server_settings()
    if "host" in body and str(body["host"]).strip():
        settings["host"] = str(body["host"]).strip()
    if "port" in body:
        try:
            settings["port"] = int(body["port"])
        except (TypeError, ValueError):
            pass
    if "secure" in body:
        settings["secure"] = bool(body["secure"])
    return settings


@app.route("/api/settings/plex-server", methods=["POST"])
@requires_auth
def api_settings_plex_server_save():
    body = request.get_json(silent=True) or {}
    settings = _apply_plex_server_body(body)
    models.set_setting("plex_server_settings", json.dumps(settings))
    settings["url"] = plex_client.build_plex_url(settings)
    return jsonify({"ok": True, "settings": settings})


@app.route("/api/settings/plex-server/verify", methods=["POST"])
@requires_auth
def api_settings_plex_server_verify():
    """Tests connectivity against the given host/port/secure combo without
    saving anything -- mirrors Tautulli's own "Verify Server" button,
    letting someone check a change before committing to it."""
    body = request.get_json(silent=True) or {}
    settings = _apply_plex_server_body(body)
    url = plex_client.build_plex_url(settings)

    token = plex_client.get_token()
    if not token:
        return jsonify({"ok": False, "error": "Not signed in to Plex yet -- use Plex.tv Authentication below first."})
    try:
        server = PlexServer(url, token, timeout=8)
        return jsonify({"ok": True, "server_name": server.friendlyName, "version": server.version})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


# Settings > General > Display Settings. A single JSON blob under one
# settings key (like analytics_layout) rather than three separate keys,
# since they're always read/written together. date_format/time_format are a
# fixed set of presets rather than a free-form strftime string -- every
# date/time shown anywhere in the app routes through a small set of shared
# JS formatting helpers that key off these two values, so a preset keeps
# that formatting logic simple and safe rather than needing to parse an
# arbitrary format string in dozens of places.
DEFAULT_DISPLAY_SETTINGS = {"theme": "dark", "date_format": "mdy", "time_format": "12h"}


@app.route("/api/settings/display", methods=["GET"])
@requires_auth
def api_settings_display_get():
    raw = models.get_setting("display_settings")
    settings = dict(DEFAULT_DISPLAY_SETTINGS)
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                settings.update({k: v for k, v in parsed.items() if k in settings})
        except (ValueError, TypeError):
            pass
    return jsonify({"ok": True, "settings": settings})


@app.route("/api/settings/display", methods=["POST"])
@requires_auth
def api_settings_display_save():
    body = request.get_json(silent=True) or {}
    settings = dict(DEFAULT_DISPLAY_SETTINGS)
    if body.get("theme") in ("dark", "light", "plex"):
        settings["theme"] = body["theme"]
    if body.get("date_format") in ("mdy", "dmy", "iso", "month_name"):
        settings["date_format"] = body["date_format"]
    if body.get("time_format") in ("12h", "24h"):
        settings["time_format"] = body["time_format"]
    models.set_setting("display_settings", json.dumps(settings))
    return jsonify({"ok": True, "settings": settings})


# The label this app registers itself under with launchd (see the README's
# setup instructions) -- used so Restart/Shutdown can talk to launchd
# directly rather than just killing the process and hoping for the best.
LAUNCHD_LABEL = "com.plexstats.app"
LAUNCHD_PLIST_PATH = os.path.expanduser(f"~/Library/LaunchAgents/{LAUNCHD_LABEL}.plist")


@app.route("/api/settings/launch-at-startup", methods=["GET"])
@requires_auth
def api_launch_at_startup_get():
    """Whether this app's launchd LaunchAgent is currently set to start
    automatically at login/boot (the plist's RunAtLoad key) -- only
    meaningful if it's set up as a background service per the README;
    otherwise there's no plist file to read at all."""
    if not os.path.exists(LAUNCHD_PLIST_PATH):
        return jsonify({"ok": True, "available": False, "enabled": False})
    try:
        with open(LAUNCHD_PLIST_PATH, "rb") as f:
            plist = plistlib.load(f)
        return jsonify({"ok": True, "available": True, "enabled": bool(plist.get("RunAtLoad", False))})
    except Exception as e:
        log.warning("Could not read launchd plist: %s", e)
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/settings/launch-at-startup", methods=["POST"])
@requires_auth
def api_launch_at_startup_set():
    """Flips RunAtLoad in the plist file. Deliberately doesn't force an
    immediate launchctl reload -- launchd only reads RunAtLoad at load time
    (login/boot), and the currently-running job is unaffected either way, so
    the new value simply takes effect the next time the LaunchAgent loads
    rather than needing to bounce the service right now."""
    if not os.path.exists(LAUNCHD_PLIST_PATH):
        return jsonify({"ok": False, "error": "No launchd service file found for this app."}), 400
    body = request.get_json(silent=True) or {}
    enabled = bool(body.get("enabled"))
    try:
        with open(LAUNCHD_PLIST_PATH, "rb") as f:
            plist = plistlib.load(f)
        plist["RunAtLoad"] = enabled
        with open(LAUNCHD_PLIST_PATH, "wb") as f:
            plistlib.dump(plist, f)
        return jsonify({"ok": True, "enabled": enabled})
    except Exception as e:
        log.warning("Could not update launchd plist: %s", e)
        return jsonify({"ok": False, "error": str(e)}), 500


MENUBAR_LAUNCHD_LABEL = "com.plexstats.menubar"
MENUBAR_PLIST_PATH = os.path.expanduser(f"~/Library/LaunchAgents/{MENUBAR_LAUNCHD_LABEL}.plist")
# Defaults to enabled -- once the one-time setup is done, the icon should
# just be there without anyone needing to flip a switch first. Someone who
# doesn't want it turns it off in Settings, and that choice is what
# persists from then on (see _sync_menubar_launchd_state below).
DEFAULT_MENUBAR_SETTINGS = {"enabled": True, "open_browser_on_start": False}


def _get_menubar_settings():
    raw = models.get_setting("menubar_settings")
    settings = dict(DEFAULT_MENUBAR_SETTINGS)
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                settings.update({k: v for k, v in parsed.items() if k in DEFAULT_MENUBAR_SETTINGS})
        except (ValueError, TypeError):
            pass
    return settings


def _sync_menubar_launchd_state(enabled):
    """Starts or stops the menu bar helper via launchctl to match `enabled`
    right now, AND keeps its plist's own RunAtLoad key in sync -- so the
    preference actually holds across future logins/reboots too, not just
    for the current session. Called both when the Settings toggle changes
    and once at this app's own startup (see below), so the icon comes back
    on its own the same moment the main app does, matching how it's
    supposed to default to on. Returns a warning string on failure (or if
    there's nothing to act on yet), or None on success."""
    if not os.path.exists(MENUBAR_PLIST_PATH):
        return (
            f"{MENUBAR_PLIST_PATH} doesn't exist yet -- the menu bar icon needs a one-time "
            'setup step first. See the README\'s "Menu Bar Icon" section.'
        )

    try:
        with open(MENUBAR_PLIST_PATH, "rb") as f:
            plist = plistlib.load(f)
        if plist.get("RunAtLoad") != enabled:
            plist["RunAtLoad"] = enabled
            with open(MENUBAR_PLIST_PATH, "wb") as f:
                plistlib.dump(plist, f)
    except Exception as e:
        log.warning("Could not update menu bar plist RunAtLoad: %s", e)

    try:
        if enabled:
            # bootstrap can fail with "already bootstrapped" if it's
            # already loaded -- that's fine, not a real error, so its
            # result isn't checked. But bootstrap alone only REGISTERS the
            # job; kickstart -k is what actually starts/restarts the
            # process, so that's the one whose failure actually matters.
            subprocess.run(
                ["launchctl", "bootstrap", f"gui/{os.getuid()}", MENUBAR_PLIST_PATH],
                timeout=5,
                capture_output=True,
            )
            result = subprocess.run(
                ["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{MENUBAR_LAUNCHD_LABEL}"],
                timeout=5,
                capture_output=True,
            )
        else:
            result = subprocess.run(
                ["launchctl", "bootout", f"gui/{os.getuid()}/{MENUBAR_LAUNCHD_LABEL}"],
                timeout=5,
                capture_output=True,
            )
        if result.returncode != 0:
            action = "start" if enabled else "stop"
            stderr_text = result.stderr.decode(errors="replace").strip() or "unknown launchctl error"
            log.warning("launchctl failed to %s menu bar helper: %s", action, stderr_text)
            return f"couldn't {action} it just now: {stderr_text}"
    except Exception as e:
        action = "start" if enabled else "stop"
        log.warning("Could not %s menu bar helper via launchctl: %s", action, e)
        return f"couldn't {action} it just now: {e}"
    return None


@app.route("/api/settings/menubar", methods=["GET"])
@requires_auth_or_local
def api_settings_menubar_get():
    settings = _get_menubar_settings()
    settings["plist_found"] = os.path.exists(MENUBAR_PLIST_PATH)
    return jsonify({"ok": True, "settings": settings})


@app.route("/api/settings/menubar", methods=["POST"])
@requires_auth_or_local
def api_settings_menubar_save():
    """Saves menu bar preferences. Unlike Launch at Startup above, changing
    'enabled' here also starts/stops the menu bar helper right now via
    launchctl -- someone toggling "Show Icon in Menu Bar" expects to
    actually see the icon appear or disappear, not just have a preference
    recorded for next login."""
    settings = _get_menubar_settings()
    body = request.get_json(silent=True) or {}
    prev_enabled = settings["enabled"]
    if "enabled" in body:
        settings["enabled"] = bool(body["enabled"])
    if "open_browser_on_start" in body:
        settings["open_browser_on_start"] = bool(body["open_browser_on_start"])
    models.set_setting("menubar_settings", json.dumps(settings))

    warning = None
    if "enabled" in body and settings["enabled"] != prev_enabled:
        problem = _sync_menubar_launchd_state(settings["enabled"])
        if problem:
            warning = f"Saved, but {problem}"

    settings["plist_found"] = os.path.exists(MENUBAR_PLIST_PATH)
    result = {"ok": True, "settings": settings}
    if warning:
        result["warning"] = warning
    return jsonify(result)


@app.route("/api/system/restart", methods=["POST"])
@requires_auth_or_local
def api_system_restart():
    """Exits the process; if running under launchd (the setup this app's
    README walks through, with KeepAlive enabled), it's relaunched
    automatically within a few seconds. If you're running `python3 app.py`
    directly instead, this just stops the process -- there's nothing to
    supervise a restart in that case, so it needs to be started manually
    again the same way."""

    def _restart():
        time.sleep(0.5)  # let the HTTP response actually reach the browser first
        logging.shutdown()  # os._exit() below skips normal buffer flushing otherwise
        os._exit(0)

    threading.Thread(target=_restart, daemon=True).start()
    return jsonify({"ok": True})


@app.route("/api/system/shutdown", methods=["POST"])
@requires_auth_or_local
def api_system_shutdown():
    """Stops the app and, if running under launchd, unloads it from launchd
    entirely first so it does NOT come back on its own -- that's what
    distinguishes this from Restart. Bringing it back later requires the
    same launchctl bootstrap command from the README's setup steps.

    Also stops the menu bar helper (if it's running) -- these are two
    separate processes/launchd services, so nothing else would do that
    automatically, and a menu bar icon still sitting there pointed at a
    server that's no longer running would just be confusing. This is the
    other half of the sync menubar.py's own Quit action already does in
    reverse (it stops this app, not just itself)."""

    def _shutdown():
        time.sleep(0.5)
        # Order matters here: booting out this app's OWN currently-running
        # service is very likely what was silently killing this process
        # (launchd sending SIGTERM as a direct side effect of tearing down
        # a running job) -- which would happen mid-function, before a
        # second bootout call for the menu bar ever got to run, and before
        # logging.shutdown()/os._exit() below ever executed either. Stopping
        # the menu bar FIRST means it's already handled by the time this
        # process's own service gets torn down last.
        try:
            result = subprocess.run(
                ["launchctl", "bootout", f"gui/{os.getuid()}/{MENUBAR_LAUNCHD_LABEL}"],
                timeout=5,
                capture_output=True,
            )
            if result.returncode != 0:
                log.warning(
                    "launchctl bootout for %s exited %s: %s",
                    MENUBAR_LAUNCHD_LABEL, result.returncode, result.stderr.decode(errors="replace").strip(),
                )
            else:
                log.info("launchctl bootout for %s: stopped", MENUBAR_LAUNCHD_LABEL)
        except Exception as e:
            log.warning("Could not stop menu bar helper during shutdown: %s", e)
        logging.shutdown()  # in case the next step ends this process before anything else can flush
        try:
            result = subprocess.run(
                ["launchctl", "bootout", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"],
                timeout=5,
                capture_output=True,
            )
            if result.returncode != 0:
                log.warning(
                    "launchctl bootout for %s exited %s: %s",
                    LAUNCHD_LABEL, result.returncode, result.stderr.decode(errors="replace").strip(),
                )
        except Exception as e:
            log.warning("launchctl bootout failed (may not be running under launchd): %s", e)
        # Fallback for anyone running this manually (not via launchd) --
        # bootout above won't apply to a process it never launched, so make
        # sure the process actually stops either way.
        os._exit(0)

    threading.Thread(target=_shutdown, daemon=True).start()
    return jsonify({"ok": True})


if __name__ == "__main__":
    if not plex_client.get_token():
        log.warning(
            "No Plex token yet -- visit http://%s:%s/login and sign in with Plex to connect this app.",
            config.DASHBOARD_HOST if config.DASHBOARD_HOST != "0.0.0.0" else "127.0.0.1",
            config.DASHBOARD_PORT,
        )
    poller.start_scheduler()

    # The menu bar icon defaults to enabled and is meant to come up on its
    # own alongside the main app -- not require a trip to Settings first.
    # This re-asserts that saved (or default) preference every time this
    # app starts, which is what actually makes "on by default" true rather
    # than just a value nobody ever acts on. Best-effort and non-fatal: if
    # the menu bar's one-time setup hasn't been done yet, or launchctl has
    # a bad moment, that must never take the main app down with it.
    try:
        menubar_settings = _get_menubar_settings()
        if os.path.exists(MENUBAR_PLIST_PATH):
            # In a background thread, not called directly -- these are
            # subprocess calls with their own timeouts, and they must never
            # be what delays the web server actually starting to listen
            # (the menu bar launcher itself polls for the server to come
            # up, so slowing that down could race against it).
            threading.Thread(
                target=_sync_menubar_launchd_state,
                args=(menubar_settings["enabled"],),
                daemon=True,
            ).start()
    except Exception as e:
        log.warning("Could not sync menu bar helper state at startup: %s", e)

    app.run(host=config.DASHBOARD_HOST, port=config.DASHBOARD_PORT, debug=False)

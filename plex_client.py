import logging
import json
from datetime import datetime, timedelta
from urllib.parse import urlparse

from plexapi.server import PlexServer

import models
from config import PLEX_BASE_URL, PLEX_TOKEN

log = logging.getLogger(__name__)


def get_token():
    """The token obtained by logging in through the web UI takes priority;
    a manually-set PLEX_TOKEN in .env is kept as a fallback for anyone who
    set the app up before the login flow existed, or prefers that route."""
    return models.get_setting("plex_token") or PLEX_TOKEN


# Settings > Plex Media Server. Same precedence as get_token() above: the
# server configured through that settings page takes priority, and
# PLEX_BASE_URL in .env (this app's original, pre-settings-page way of
# pointing at a server) is only ever used to seed the very first default,
# the same way the effective server URL already worked before this page
# existed -- nobody's existing setup silently changes until they actually
# touch the new page.
PLEX_SERVER_SETTINGS_KEYS = ("host", "port", "secure")


def _default_server_settings_from_env():
    parsed = urlparse(PLEX_BASE_URL)
    return {
        "host": parsed.hostname or "127.0.0.1",
        "port": parsed.port or 32400,
        "secure": parsed.scheme == "https",
    }


def get_plex_server_settings():
    settings = _default_server_settings_from_env()
    raw = models.get_setting("plex_server_settings")
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                settings.update({k: v for k, v in parsed.items() if k in PLEX_SERVER_SETTINGS_KEYS})
        except (ValueError, TypeError):
            pass
    return settings


def build_plex_url(settings):
    scheme = "https" if settings.get("secure") else "http"
    return f"{scheme}://{settings['host']}:{settings['port']}"


def get_server_url():
    """The URL built from Settings > Plex Media Server -- see connect()."""
    return build_plex_url(get_plex_server_settings())


def _plex_local_datetime_to_utc(dt):
    """plexapi converts Plex's timestamps to *naive datetimes already in the
    local system timezone* by default (not UTC), unlike literally every
    other timestamp in this app, which is naive-but-genuinely-UTC via
    datetime.utcnow(). Left alone, that mismatch causes Plex-sourced
    timestamps (viewedAt, addedAt) to come out several hours off once the
    frontend re-interprets them as UTC for display -- and, worse, throws off
    the duplicate-detection window that's supposed to merge a viewing this
    app tracked live with the same viewing showing up later in Plex's own
    history, since the two versions of "when did this happen" no longer
    agree closely enough to match.

    dt.timestamp() on a naive datetime is well-defined to interpret it using
    the local system timezone to get the correct absolute UTC instant --
    exactly undoing plexapi's conversion -- and utcfromtimestamp() converts
    that back into a naive-but-truly-UTC datetime, consistent with the rest
    of this app."""
    if dt is None:
        return None
    return datetime.utcfromtimestamp(dt.timestamp())


def connect():
    token = get_token()
    if not token:
        raise RuntimeError("Not connected to Plex yet. Log in at the app's /login page.")
    return PlexServer(get_server_url(), token)


def get_account_map(plex):
    """Map Plex accountID -> display name, used to attribute watch history."""
    mapping = {}
    try:
        for acct in plex.systemAccounts():
            name = getattr(acct, "name", None) or getattr(acct, "title", None)
            if name:
                mapping[acct.id] = name
    except Exception as e:
        log.warning("Could not fetch system accounts: %s", e)
    return mapping


def get_live_sessions(plex):
    """Return a list of plain dicts describing sessions playing right now."""
    results = []
    for s in plex.sessions():
        try:
            user = getattr(s, "_username", None)
            if not user:
                usernames = getattr(s, "usernames", None)
                user = usernames[0] if usernames else "Unknown"

            # PlexAPI exposes these as single objects (not lists) on current
            # versions: s.player, s.session, s.transcodeSession. Older/backwards
            # -compat list forms (players/sessions/transcodeSessions) are used
            # as a fallback in case a different PlexAPI version is installed.
            player = getattr(s, "player", None)
            if player is None:
                players = getattr(s, "players", None)
                player = players[0] if players else None

            transcode = getattr(s, "transcodeSession", None)
            if transcode is None:
                transcodes = getattr(s, "transcodeSessions", None)
                transcode = transcodes[0] if transcodes else None

            session_obj = getattr(s, "session", None)
            if isinstance(session_obj, list):
                session_obj = session_obj[0] if session_obj else None

            full_title = s.title
            if getattr(s, "grandparentTitle", None):
                full_title = f"{s.grandparentTitle} - {s.title}"

            duration = getattr(s, "duration", None) or 1
            offset = getattr(s, "viewOffset", 0) or 0
            progress = round((offset / duration) * 100, 1) if duration else 0.0

            bandwidth = float(getattr(session_obj, "bandwidth", 0) or 0) if session_obj else 0.0

            if s.type in ("episode", "track"):
                thumb = getattr(s, "grandparentThumb", None) or getattr(s, "thumb", None)
                genre_key = getattr(s, "grandparentRatingKey", None) or _extract_rating_key_from_path(
                    getattr(s, "grandparentKey", None)
                )
            else:
                thumb = getattr(s, "thumb", None)
                genre_key = getattr(s, "ratingKey", None)

            season_number = None
            episode_number = None
            if s.type == "episode":
                season_number = getattr(s, "parentIndex", None)
                episode_number = getattr(s, "index", None)

            results.append(
                {
                    "session_key": getattr(s, "sessionKey", None),
                    "user": user,
                    "title": s.title,
                    "full_title": full_title,
                    "grandparent_title": getattr(s, "grandparentTitle", None),
                    "media_type": s.type,
                    "player": getattr(player, "title", "Unknown") if player else "Unknown",
                    "library_section": getattr(s, "librarySectionTitle", None),
                    "player_platform": getattr(player, "platform", "Unknown") if player else "Unknown",
                    "product": getattr(player, "product", None) if player else None,
                    "state": getattr(player, "state", "unknown") if player else "unknown",
                    "is_transcode": bool(transcode),
                    "video_decision": _classify_video_decision(transcode),
                    "bandwidth_kbps": bandwidth,
                    "progress_percent": progress,
                    "ip_address": getattr(player, "address", None),
                    "location": getattr(player, "location", None),
                    "thumb": thumb,
                    "genre_key": str(genre_key) if genre_key is not None else None,
                    "season_number": int(season_number) if season_number is not None else None,
                    "episode_number": int(episode_number) if episode_number is not None else None,
                }
            )
        except Exception as e:
            log.warning("Failed to parse a live session, skipping it: %s", e)
    return results


def _classify_video_decision(transcode):
    """Plex's own three playback categories: Direct Play (no transcode
    session at all), Direct Stream (a transcode session exists, but video
    itself isn't being re-encoded -- just remuxed/copied), or a real
    Transcode (video is being re-encoded, the expensive case)."""
    if not transcode:
        return "direct_play"
    if getattr(transcode, "videoDecision", None) == "transcode":
        return "transcode"
    return "direct_stream"


def _extract_rating_key_from_path(key_path):
    """Plex API paths look like '/library/metadata/32132' -- the numeric ID
    at the end is the rating key. Used as a fallback for the few places
    (like the lightweight history endpoint) that give a *Key path but not
    the corresponding *RatingKey field directly."""
    if not key_path:
        return None
    tail = key_path.rstrip("/").split("/")[-1]
    return tail if tail.isdigit() else None


def get_history_batch(plex, account_map, size=200, mindate=None):
    """Pull watch history entries from Plex and normalize them into plain dicts."""
    items = plex.history(maxresults=size, mindate=mindate)
    rows = []
    for h in items:
        try:
            full_title = h.title
            if getattr(h, "grandparentTitle", None):
                full_title = f"{h.grandparentTitle} - {h.title}"

            viewed_at = (
                _plex_local_datetime_to_utc(h.viewedAt).isoformat()
                if getattr(h, "viewedAt", None)
                else datetime.utcnow().isoformat()
            )

            account_id = getattr(h, "accountID", None)
            user = account_map.get(account_id, f"Account {account_id}" if account_id else "Unknown")

            history_key = getattr(h, "historyKey", None) or f"{getattr(h, 'ratingKey', 'x')}-{viewed_at}-{account_id}"

            # For episodes, use the show's poster (grandparentThumb) rather
            # than the individual episode's thumbnail, so "Top TV Shows" --
            # which groups by show -- has one consistent poster per show.
            # Genre/details work the same way: episodes don't carry their own
            # genre tags, only the show does, so use the show's rating key.
            # Music tracks have the exact same three-level hierarchy (track
            # -> album -> artist, mirroring episode -> season -> show), so
            # they're grouped by artist here the same way for the same
            # reasons -- "most played" naturally means the artist/author, not
            # fragmenting plays across every individual track/chapter.
            # Plex's lightweight history response includes 'grandparentKey'
            # (a path like /library/metadata/32132) but NOT a direct
            # 'grandparentRatingKey' field, unlike the full session data --
            # so fall back to parsing the ID out of that path.
            if h.type in ("episode", "track"):
                thumb = getattr(h, "grandparentThumb", None) or getattr(h, "thumb", None)
                genre_key = getattr(h, "grandparentRatingKey", None) or _extract_rating_key_from_path(
                    getattr(h, "grandparentKey", None)
                )
            else:
                thumb = getattr(h, "thumb", None)
                genre_key = getattr(h, "ratingKey", None)

            season_number = None
            episode_number = None
            if h.type == "episode":
                season_number = getattr(h, "parentIndex", None)
                episode_number = getattr(h, "index", None)

            player_obj = getattr(h, "player", None)
            platform = getattr(player_obj, "platform", None) if player_obj else None
            product = getattr(player_obj, "product", None) if player_obj else None

            # Plex's history API only gives one timestamp per viewing (no
            # separate start/pause/stop events like this app's own live
            # session tracking can capture) -- treat viewedAt as the stop
            # time and back-derive a start-time estimate from the runtime.
            # "Paused" genuinely has no equivalent here, so it stays empty
            # for anything sourced from Plex's official history.
            duration_ms = int(getattr(h, "duration", 0) or 0)
            stopped_time = viewed_at
            start_time = None
            if duration_ms:
                try:
                    start_time = (
                        datetime.fromisoformat(viewed_at) - timedelta(milliseconds=duration_ms)
                    ).isoformat()
                except (ValueError, TypeError):
                    start_time = None

            rows.append(
                {
                    "history_key": history_key,
                    "viewed_at": viewed_at,
                    "user": user,
                    "title": h.title,
                    "full_title": full_title,
                    "media_type": h.type,
                    "grandparent_title": getattr(h, "grandparentTitle", None),
                    "account_id": str(account_id) if account_id is not None else None,
                    "device": getattr(h, "player", None) and getattr(h.player, "title", None),
                    "library_section": getattr(h, "librarySectionTitle", None),
                    "duration_ms": duration_ms,
                    "thumb": thumb,
                    "genre_key": str(genre_key) if genre_key is not None else None,
                    "season_number": int(season_number) if season_number is not None else None,
                    "episode_number": int(episode_number) if episode_number is not None else None,
                    "platform": platform,
                    "product": product,
                    "start_time": start_time,
                    "paused_time": None,
                    "stopped_time": stopped_time,
                    "ip_address": None,
                    "video_decision": None,
                    "paused_duration_ms": None,
                }
            )
        except Exception as e:
            log.warning("Failed to parse a history item, skipping it: %s", e)
    return rows


def fetch_genres_for_keys(plex, items):
    """Look up genres (and poster thumb) for a batch of items, each
    {"genre_key": ..., "title": ..., "media_type": ...}, by fetching each
    item's full metadata (history/session data alone doesn't include
    genres). Returns {genre_key: {"genres": [...], "thumb": ...,
    "resolved_key": ...}} for items that resolved successfully.

    Plex reassigns an item's ratingKey whenever it's re-matched, moved, or
    the library gets rescanned, so a key captured months ago in
    watch_history can genuinely 404 even though the title is still in the
    library. When the direct fetch fails, fall back to searching by title
    (scoped to the right libtype) -- if that finds the title under a
    *different* current key, resolved_key reflects that, and the caller is
    expected to remap watch_history rows to it (see models.remap_genre_key)
    so future syncs use the working key directly. If both the direct fetch
    and the title search fail, the key is left out of the result entirely
    so the caller can record it as a failure."""
    results = {}
    for item in items:
        key = item["genre_key"]
        title = item.get("title")
        media_type = item.get("media_type")
        resolved_key = key

        try:
            fetched = plex.fetchItem(int(key))
        except Exception as e:
            log.debug("Direct fetch failed for rating key %s (%s), trying title search for %r", key, e, title)
            fetched = None

        if fetched is None and title:
            try:
                if media_type == "episode":
                    libtype = "show"
                elif media_type == "track":
                    libtype = "artist"
                else:
                    libtype = "movie"
                matches = plex.library.search(title=title, libtype=libtype)
            except Exception as e:
                log.warning("Title-search fallback failed for %r: %s", title, e)
                matches = []
            if matches:
                fetched = matches[0]
                resolved_key = str(fetched.ratingKey)

        if fetched is None:
            log.warning("Could not fetch genres for rating key %s (%r) -- title search found no match either", key, title)
            continue

        genres = [g.tag for g in getattr(fetched, "genres", []) if getattr(g, "tag", None)]
        results[key] = {"genres": genres, "thumb": getattr(fetched, "thumb", None), "resolved_key": resolved_key}
    return results


def fetch_media_details(plex, rating_key):
    """Full metadata for one movie or show, for the movie/show detail
    drilldown page: synopsis, director, cast, release date, etc. Raises on
    failure (e.g. the item was deleted from Plex) -- the caller decides how
    to handle that, since this is fetched on-demand rather than in a batch."""
    item = plex.fetchItem(int(rating_key))

    directors = [d.tag for d in getattr(item, "directors", []) if getattr(d, "tag", None)]
    genres = [g.tag for g in getattr(item, "genres", []) if getattr(g, "tag", None)]
    actors = [
        {"name": r.tag, "role": getattr(r, "role", None), "thumb": getattr(r, "thumb", None)}
        for r in getattr(item, "roles", []) or []
        if getattr(r, "tag", None)
    ][:10]

    release_date = getattr(item, "originallyAvailableAt", None)

    return {
        "title": getattr(item, "title", None),
        "type": getattr(item, "type", None),
        "summary": getattr(item, "summary", None),
        "release_date": release_date.isoformat() if release_date else None,
        "directors": directors,
        "actors": actors,
        "genres": genres,
        "studio": getattr(item, "studio", None),
        "content_rating": getattr(item, "contentRating", None),
        "audience_rating": getattr(item, "audienceRating", None),
        "thumb": getattr(item, "thumb", None),
        "art": getattr(item, "art", None),
    }


def fetch_library_stats(plex):
    """Per-library catalog totals (how many movies/shows/artists exist) --
    straight from Plex; this is about what's IN each library, not what's
    been watched. Uses totalViewSize(), which does a lightweight count-only
    query rather than fetching every item's metadata. Includes Music
    ("artist"-type) libraries alongside Movie/TV -- e.g. an audiobook
    library set up as a Music library in Plex, with Author as artist, Book
    as album, Chapter as track."""
    from datetime import datetime as _datetime

    results = []
    for section in plex.library.sections():
        if section.type not in ("movie", "show", "artist"):
            continue
        try:
            total_items = section.totalViewSize(includeCollections=False)
            total_seasons = None
            total_episodes = None
            if section.type == "show":
                total_seasons = section.totalViewSize(libtype="season", includeCollections=False)
                total_episodes = section.totalViewSize(libtype="episode", includeCollections=False)
            results.append(
                {
                    "key": str(section.key),
                    "name": section.title,
                    "type": section.type,
                    "total_items": total_items,
                    "total_seasons": total_seasons,
                    "total_episodes": total_episodes,
                    "fetched_at": _datetime.utcnow().isoformat(),
                }
            )
        except Exception as e:
            log.warning("Could not fetch stats for library %s: %s", getattr(section, "title", "?"), e)
    return results


def fetch_recently_added(plex, library_key, limit=12):
    """Items Plex has recently added to this library -- not watch history,
    this is purely about what's new in the catalog."""
    section = plex.library.sectionByID(int(library_key))
    items = section.recentlyAdded(maxresults=limit)

    results = []
    for item in items:
        is_grouped_type = item.type in ("episode", "track")
        if is_grouped_type:
            media_key = getattr(item, "grandparentRatingKey", None)
            thumb = getattr(item, "grandparentThumb", None) or getattr(item, "thumb", None)
            title = item.grandparentTitle if getattr(item, "grandparentTitle", None) else item.title
        else:
            media_key = getattr(item, "ratingKey", None)
            thumb = getattr(item, "thumb", None)
            title = item.title

        added_at = getattr(item, "addedAt", None)
        results.append(
            {
                "title": title,
                "thumb": thumb,
                "added_at": _plex_local_datetime_to_utc(added_at).isoformat() if added_at else None,
                "year": getattr(item, "year", None),
                "media_key": str(media_key) if media_key is not None else None,
                "media_type": item.type,
            }
        )
    return results


def fetch_collections(plex, library_key, limit=100):
    """Plex collections defined in this library."""
    section = plex.library.sectionByID(int(library_key))
    results = []
    for c in section.collections()[:limit]:
        results.append(
            {
                "title": c.title,
                "thumb": getattr(c, "thumb", None),
                "child_count": getattr(c, "childCount", None),
                "rating_key": str(getattr(c, "ratingKey", "")) or None,
            }
        )
    return results


def fetch_playlists(plex, library_key, limit=100):
    """Plex playlists scoped to this library. LibrarySection.playlists()
    properly filters server-side by section and content type -- no need to
    manually cross-reference playlist items against the library ourselves."""
    section = plex.library.sectionByID(int(library_key))
    results = []
    for p in section.playlists()[:limit]:
        duration_ms = getattr(p, "duration", None)
        results.append(
            {
                "title": p.title,
                "thumb": getattr(p, "composite", None) or getattr(p, "thumb", None),
                "item_count": getattr(p, "leafCount", None),
                "duration_ms": duration_ms,
                "rating_key": str(getattr(p, "ratingKey", "")) or None,
            }
        )
    return results


def fetch_library_genres(plex, library_key):
    """Every genre value Plex knows about for this library -- populates the
    Media tab's genre filter dropdown with only choices that could actually
    return something, the same idea as the History page's own filter
    dropdowns pulling from real distinct values rather than a fixed list."""
    section = plex.library.sectionByID(int(library_key))
    choices = section.listFilterChoices("genre")
    names = sorted({(getattr(c, "title", None) or getattr(c, "tag", None)) for c in choices} - {None})
    return names


def fetch_library_media(plex, library_key, search=None, genre=None, page=1, page_size=50):
    """A page of everything in this library, for the 'Media' tab, live from
    Plex rather than a local cache -- a movie library can easily have
    thousands of items, so this avoids pulling the whole catalog at once.

    Passing container_start/container_size directly to LibrarySection.search()
    was tried first but confirmed (via server-side timing logs -- ~18s no
    matter which page was requested) to make Plex fall back to a full,
    unbounded scan of the entire library on every single call, silently
    defeating the pagination entirely. maxresults, by contrast, is a
    reliably efficient cap -- so this asks for everything up through the
    end of the requested page and slices off just that page in Python.
    That means later pages cost a bit more than earlier ones (page 5
    re-fetches pages 1-4 too), but it's still dramatically cheaper than a
    full-library fetch, and normal browsing (a handful of pages) stays
    fast. The search box and genre filter both re-query Plex directly
    (search by title, genre as a native filter kwarg) so a match can be
    found and paged through regardless of where it falls alphabetically."""
    section = plex.library.sectionByID(int(library_key))
    filter_kwargs = {"genre": genre} if genre else {}
    container_start = max(page - 1, 0) * page_size
    fetch_count = container_start + page_size + 1
    if search:
        items = section.search(title=search, maxresults=fetch_count, **filter_kwargs)
    else:
        items = section.search(sort="titleSort", maxresults=fetch_count, **filter_kwargs)

    has_next = len(items) > container_start + page_size
    items = items[container_start:container_start + page_size]

    results = []
    for item in items:
        # Watch history always stores TV plays as media_type='episode' (never
        # 'show') and music plays as 'track' (never 'artist'), so map the
        # type here to match -- otherwise clicking a show/artist from this
        # list would query for a media_type that never appears in
        # watch_history and silently show no watched-by data. plex_type
        # keeps the real Plex type around too, since media_type alone isn't
        # safe to use for a human-readable "Type" column (e.g. an artist
        # row's media_type is 'track', which would misleadingly display as
        # a track rather than an artist).
        if item.type == "show":
            media_type = "episode"
        elif item.type == "artist":
            media_type = "track"
        else:
            media_type = item.type
        added_at = getattr(item, "addedAt", None)
        results.append(
            {
                "title": item.title,
                "thumb": getattr(item, "thumb", None),
                "year": getattr(item, "year", None),
                "rating_key": str(getattr(item, "ratingKey", "")) or None,
                "media_type": media_type,
                "plex_type": item.type,
                "duration_ms": getattr(item, "duration", None),
                "content_rating": getattr(item, "contentRating", None),
                "added_at": added_at.isoformat() if added_at else None,
            }
        )
    return results, has_next


def fetch_artist_albums(plex, artist_key):
    """Every album for one artist (e.g. every book by an author, for an
    audiobook library set up as Music) -- powers the Media tab's expandable
    artist row. Total Plays/Last Played aren't available at this level: this
    app's own watch history groups plays by artist, not by individual album
    or track (the same reason "genre_key" for a track points at the artist),
    so a play can't be attributed to one specific album from history alone
    -- this is purely a browsable catalog listing."""
    artist = plex.fetchItem(int(artist_key))
    results = []
    for album in artist.albums():
        results.append(
            {
                "title": album.title,
                "rating_key": str(getattr(album, "ratingKey", "")) or None,
                "thumb": getattr(album, "thumb", None),
                "year": getattr(album, "year", None),
                "track_count": getattr(album, "leafCount", None),
            }
        )
    return results


def fetch_album_tracks(plex, album_key):
    """Every track for one album (e.g. every chapter in a book) -- powers
    the Media tab's expandable album row, nested inside an expanded artist
    row."""
    album = plex.fetchItem(int(album_key))
    results = []
    for track in album.tracks():
        results.append(
            {
                "title": track.title,
                "rating_key": str(getattr(track, "ratingKey", "")) or None,
                "duration_ms": getattr(track, "duration", None),
                "track_number": getattr(track, "trackNumber", None) or getattr(track, "index", None),
            }
        )
    return results


def fetch_server_users(plex):
    """Every user with access to this Plex server -- the owner plus
    everyone it's been shared with -- not just people who've actually
    watched something yet. Powers the Users page showing someone even
    before their first play, the same way the Libraries page shows a
    library's catalog independent of whether anything's been watched from
    it.

    Prefers each account's actual Plex.tv username over its display title,
    since that's what watch_history.user is populated from elsewhere in
    this app (via systemAccounts()) -- matching that exactly is what lets
    a user merge into one row instead of appearing twice under two
    slightly different names."""
    names = set()
    try:
        account = plex.myPlexAccount()
        owner_name = getattr(account, "username", None) or getattr(account, "title", None)
        if owner_name:
            names.add(owner_name)
        for u in account.users():
            name = getattr(u, "username", None) or getattr(u, "title", None) or getattr(u, "friendlyName", None)
            if name:
                names.add(name)
    except Exception as e:
        log.warning("Could not fetch Plex account users: %s", e)
    return sorted(names)

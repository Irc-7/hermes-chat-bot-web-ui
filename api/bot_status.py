"""Read-only cross-profile bot status aggregation (UI improvement spec Fase 2).

Powers ``GET /api/bots/status``: for every Hermes profile, report ONLY
session-store metadata (session count, last activity time, and a
time-heuristic unread estimate) so the frontend bot rail can show a
liveness badge for profiles that are not currently active.

Hard constraints (spec §5 Fase 2 + §6):
  * NEVER activates a profile and never touches the profile-switch /
    monkey-patch machinery — this module only reads files.
  * NEVER reads session message bodies. The only file parsed is the
    ``_index.json`` sidecar (metadata-only by construction). When the
    index is missing or corrupt we fall back to file *mtimes* of the
    session files; their contents are never opened.
  * Approval/clarify pending state is intentionally NOT reported for
    non-active profiles: that state is in-process state of the active
    profile only, and faking it cross-profile would be dishonest.
  * One broken profile must not break the whole response — per-profile
    failures degrade to a zeroed entry with ``error: True``.

Unread estimate heuristic (documented, deliberately simple):
  * If a marker file ``<profile>/webui/bot_last_seen.json`` exists with a
    numeric ``last_seen_at`` (epoch seconds), the estimate is the number
    of sessions whose last activity is newer than that marker.
  * Otherwise the estimate counts sessions active within the trailing
    7-day window. This is an *estimate* for a badge, not a read receipt;
    the active profile's precise unread state lives in the frontend's
    existing viewed-count machinery, not here.
"""

import json
import time
from pathlib import Path

# Trailing window for the no-marker unread heuristic (seconds).
UNREAD_FALLBACK_WINDOW_SECONDS = 7 * 24 * 3600

# Marker file (inside a profile's webui state dir) an operator/client may
# drop to make the unread estimate precise. Read-only from here.
LAST_SEEN_FILENAME = "bot_last_seen.json"


def _normalize_ts(value):
    """Normalize an epoch timestamp (seconds or milliseconds) to seconds.

    Returns None for anything that is not a positive finite number.
    """
    try:
        ts = float(value)
    except (TypeError, ValueError):
        return None
    if ts != ts or ts in (float("inf"), float("-inf")) or ts <= 0:
        return None
    # Millisecond epochs are ~1.7e12; second epochs are ~1.7e9. Anything
    # at/above 1e11 must be milliseconds (year 5138 in seconds).
    if ts >= 1e11:
        ts /= 1000.0
    return ts


def sessions_dir_for_profile(profile_path, *, is_active=False, active_sessions_dir=None):
    """Resolve the on-disk WebUI sessions dir for one profile row.

    The active profile honours the running server's configured
    ``SESSION_DIR`` (which respects ``HERMES_WEBUI_STATE_DIR``); every
    other profile uses the standard ``<HERMES_HOME>/webui/sessions``
    layout written by that profile's own WebUI state.
    """
    if is_active and active_sessions_dir is not None:
        return Path(active_sessions_dir)
    return Path(profile_path).expanduser() / "webui" / "sessions"


def read_last_seen(webui_dir):
    """Read the optional ``bot_last_seen.json`` marker next to sessions/.

    Returns a normalized epoch-seconds float, or None when the marker is
    absent, unreadable, or malformed (caller then uses the fallback
    time-window heuristic).
    """
    try:
        raw = (Path(webui_dir) / LAST_SEEN_FILENAME).read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, ValueError):
        return None
    if isinstance(data, dict):
        return _normalize_ts(data.get("last_seen_at"))
    return None


def _index_entries(sessions_dir):
    """Parse ``_index.json`` into a list of metadata dicts.

    Accepts both on-disk shapes: a mapping ``{session_id: entry}`` and a
    bare list of entries. Returns None when the index is missing or
    corrupt so the caller can fall back to mtimes.
    """
    index_path = Path(sessions_dir) / "_index.json"
    try:
        data = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if isinstance(data, dict):
        return [v for v in data.values() if isinstance(v, dict)]
    if isinstance(data, list):
        return [v for v in data if isinstance(v, dict)]
    return None


def _entry_activity(entry):
    """Best last-activity timestamp (epoch seconds) from an index entry."""
    best = None
    for key in ("last_message_at", "updated_at", "created_at"):
        ts = _normalize_ts(entry.get(key))
        if ts is not None and (best is None or ts > best):
            best = ts
    return best


def summarize_sessions_dir(sessions_dir, *, now=None, last_seen_at=None):
    """Summarize one profile's sessions dir into badge metadata.

    Returns ``{session_count, last_activity_at, unread_estimate}`` where
    ``last_activity_at`` is epoch seconds or None. Session *contents* are
    never read: index metadata first, file mtimes as fallback.
    """
    sessions_dir = Path(sessions_dir)
    now = float(now) if now is not None else time.time()
    activities = []

    entries = _index_entries(sessions_dir)
    if entries is not None:
        for entry in entries:
            activities.append(_entry_activity(entry))
    else:
        # Fallback: mtimes only. Session JSON bodies are deliberately
        # never opened — their content is not metadata.
        try:
            files = [
                p
                for p in sessions_dir.glob("*.json")
                if p.name != "_index.json" and p.is_file()
            ]
        except OSError:
            files = []
        for path in files:
            try:
                activities.append(_normalize_ts(path.stat().st_mtime))
            except OSError:
                activities.append(None)

    known = [a for a in activities if a is not None]
    last_activity_at = max(known) if known else None

    if last_seen_at is not None:
        unread_estimate = sum(1 for a in known if a > last_seen_at)
    else:
        cutoff = now - UNREAD_FALLBACK_WINDOW_SECONDS
        unread_estimate = sum(1 for a in known if a >= cutoff)

    return {
        "session_count": len(activities),
        "last_activity_at": last_activity_at,
        "unread_estimate": unread_estimate,
    }


def collect_bot_statuses(profiles, active_name, *, active_sessions_dir=None, now=None):
    """Build the ``/api/bots/status`` payload rows for all profiles.

    ``profiles`` is the row list produced by
    ``api.profiles.list_profiles_api()`` (dicts with ``name``/``path``).
    A profile whose store cannot be read degrades to a zeroed row with
    ``error: True`` instead of failing the whole response.
    """
    now = float(now) if now is not None else time.time()
    rows = []
    for profile in profiles or []:
        if not isinstance(profile, dict):
            continue
        name = profile.get("name")
        if not name:
            continue
        is_active = bool(profile.get("is_active")) or name == active_name
        row = {
            "name": name,
            "is_active": is_active,
            "session_count": 0,
            "last_activity_at": None,
            "unread_estimate": 0,
        }
        try:
            sdir = sessions_dir_for_profile(
                profile.get("path") or "",
                is_active=is_active,
                active_sessions_dir=active_sessions_dir,
            )
            last_seen = read_last_seen(sdir.parent)
            row.update(summarize_sessions_dir(sdir, now=now, last_seen_at=last_seen))
        except Exception:
            row["error"] = True
        rows.append(row)
    return rows

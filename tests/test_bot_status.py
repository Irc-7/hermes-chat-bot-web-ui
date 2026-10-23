"""Tests for api.bot_status — read-only cross-profile status aggregation.

Covers the Fase 2 contract of the bot-rail UI spec:
  * metadata ONLY (counts / timestamps) — session bodies are never read
    and never echoed into the payload;
  * profile without sessions -> zeroed summary;
  * missing/corrupt ``_index.json`` -> mtime fallback;
  * unread estimate honours the ``bot_last_seen.json`` marker when present
    and the trailing-7-day heuristic when absent;
  * one broken profile degrades instead of failing the whole payload.
"""
import json
import os
import pathlib
import sys
import time

REPO_ROOT = pathlib.Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(REPO_ROOT))

from api import bot_status  # noqa: E402

NOW = 1_760_000_000.0  # fixed "now" so heuristics are deterministic
DAY = 24 * 3600


def _write_index(sessions_dir, payload):
    sessions_dir.mkdir(parents=True, exist_ok=True)
    (sessions_dir / "_index.json").write_text(json.dumps(payload), encoding="utf-8")


def _entry(updated, **kw):
    entry = {"updated_at": updated, "message_count": 3}
    entry.update(kw)
    return entry


# ── summarize_sessions_dir ──────────────────────────────────────────────

def test_missing_dir_is_zeroed(tmp_path):
    out = bot_status.summarize_sessions_dir(tmp_path / "nope", now=NOW)
    assert out == {"session_count": 0, "last_activity_at": None, "unread_estimate": 0}


def test_empty_sessions_dir_is_zeroed(tmp_path):
    sdir = tmp_path / "sessions"
    sdir.mkdir()
    out = bot_status.summarize_sessions_dir(sdir, now=NOW)
    assert out["session_count"] == 0
    assert out["last_activity_at"] is None
    assert out["unread_estimate"] == 0


def test_index_dict_shape_counts_and_last_activity(tmp_path):
    sdir = tmp_path / "sessions"
    _write_index(sdir, {
        "s1": _entry(NOW - 2 * DAY),
        "s2": _entry(NOW - 3600, last_message_at=NOW - 1800),
        "s3": {"created_at": NOW - 30 * DAY},  # no updated_at at all
    })
    out = bot_status.summarize_sessions_dir(sdir, now=NOW)
    assert out["session_count"] == 3
    assert out["last_activity_at"] == NOW - 1800  # last_message_at wins
    # No marker -> trailing 7-day heuristic: s1 (2d) + s2 count, s3 (30d) doesn't.
    assert out["unread_estimate"] == 2


def test_index_list_shape_is_accepted(tmp_path):
    sdir = tmp_path / "sessions"
    _write_index(sdir, [_entry(NOW - 60), _entry(NOW - 120)])
    out = bot_status.summarize_sessions_dir(sdir, now=NOW)
    assert out["session_count"] == 2
    assert out["last_activity_at"] == NOW - 60


def test_unread_estimate_honours_last_seen_marker(tmp_path):
    sdir = tmp_path / "sessions"
    _write_index(sdir, {
        "old": _entry(NOW - 10 * DAY),
        "seen": _entry(NOW - 2 * DAY),
        "new": _entry(NOW - 60),
    })
    out = bot_status.summarize_sessions_dir(sdir, now=NOW, last_seen_at=NOW - DAY)
    assert out["unread_estimate"] == 1  # only "new" is after the marker


def test_read_last_seen_variants(tmp_path):
    webui = tmp_path / "webui"
    webui.mkdir()
    assert bot_status.read_last_seen(webui) is None  # absent
    (webui / "bot_last_seen.json").write_text("{not json", encoding="utf-8")
    assert bot_status.read_last_seen(webui) is None  # corrupt
    (webui / "bot_last_seen.json").write_text(
        json.dumps({"last_seen_at": NOW - 5}), encoding="utf-8"
    )
    assert bot_status.read_last_seen(webui) == NOW - 5


def test_corrupt_index_falls_back_to_mtimes_without_reading_bodies(tmp_path):
    sdir = tmp_path / "sessions"
    sdir.mkdir()
    (sdir / "_index.json").write_text("{corrupt", encoding="utf-8")
    # Session files contain message bodies; the fallback must use mtimes
    # only. If bodies were parsed this payload would raise / leak.
    body = json.dumps({"messages": [{"role": "user", "content": "SECRET-BODY"}]})
    for name, age in (("a.json", 3600), ("b.json", 10 * DAY)):
        p = sdir / name
        p.write_text(body, encoding="utf-8")
        ts = NOW - age
        os.utime(p, (ts, ts))
    out = bot_status.summarize_sessions_dir(sdir, now=NOW)
    assert out["session_count"] == 2
    assert abs(out["last_activity_at"] - (NOW - 3600)) < 2
    assert out["unread_estimate"] == 1  # only the 1-hour-old file is in-window
    assert "SECRET-BODY" not in json.dumps(out)


def test_millisecond_timestamps_are_normalized(tmp_path):
    sdir = tmp_path / "sessions"
    _write_index(sdir, {"s1": _entry((NOW - 60) * 1000)})
    out = bot_status.summarize_sessions_dir(sdir, now=NOW)
    assert abs(out["last_activity_at"] - (NOW - 60)) < 1


# ── collect_bot_statuses ────────────────────────────────────────────────

def _profile_home(base, name, entries=None):
    home = base / name
    sdir = home / "webui" / "sessions"
    if entries is not None:
        _write_index(sdir, entries)
    else:
        sdir.mkdir(parents=True, exist_ok=True)
    return home


def test_collect_two_profiles_and_active_override(tmp_path):
    home_a = _profile_home(tmp_path, "alpha", {"s1": _entry(NOW - 60)})
    home_b = _profile_home(tmp_path, "beta")  # no sessions
    active_dir = tmp_path / "elsewhere" / "sessions"
    _write_index(active_dir, {"x": _entry(NOW - 30), "y": _entry(NOW - 20)})

    rows = bot_status.collect_bot_statuses(
        [
            {"name": "alpha", "path": str(home_a), "is_active": True},
            {"name": "beta", "path": str(home_b), "is_active": False},
        ],
        "alpha",
        active_sessions_dir=active_dir,
        now=NOW,
    )
    assert [r["name"] for r in rows] == ["alpha", "beta"]
    alpha, beta = rows
    assert alpha["is_active"] is True
    assert alpha["session_count"] == 2  # from the ACTIVE override dir
    assert alpha["last_activity_at"] == NOW - 20
    assert beta["is_active"] is False
    assert beta["session_count"] == 0
    assert beta["last_activity_at"] is None


def test_collect_payload_contains_no_session_content(tmp_path):
    home = _profile_home(tmp_path, "alpha", {
        "s1": _entry(NOW - 60, title="Private Title", preview="secret text"),
    })
    rows = bot_status.collect_bot_statuses(
        [{"name": "alpha", "path": str(home), "is_active": True}],
        "alpha",
        now=NOW,
    )
    blob = json.dumps(rows)
    assert "Private Title" not in blob
    assert "secret text" not in blob
    assert set(rows[0]) <= {
        "name", "is_active", "session_count", "last_activity_at",
        "unread_estimate", "error",
    }


def test_collect_broken_profile_degrades_not_fails(tmp_path):
    good = _profile_home(tmp_path, "good", {"s1": _entry(NOW - 60)})
    rows = bot_status.collect_bot_statuses(
        [
            {"name": "broken", "path": None, "is_active": False},
            {"name": "good", "path": str(good), "is_active": False},
            {"path": "/no/name"},          # missing name -> skipped
            "not-a-dict",                  # junk row -> skipped
        ],
        "good",
        now=NOW,
    )
    names = [r["name"] for r in rows]
    assert names == ["broken", "good"]
    assert rows[0]["session_count"] == 0  # degraded, not raised
    assert rows[1]["session_count"] == 1


def test_sessions_dir_for_profile_layout(tmp_path):
    p = bot_status.sessions_dir_for_profile(tmp_path / "home")
    assert p == tmp_path / "home" / "webui" / "sessions"
    override = tmp_path / "custom"
    p2 = bot_status.sessions_dir_for_profile(
        tmp_path / "home", is_active=True, active_sessions_dir=override
    )
    assert p2 == override
    # Override must NOT apply to non-active profiles.
    p3 = bot_status.sessions_dir_for_profile(
        tmp_path / "home", is_active=False, active_sessions_dir=override
    )
    assert p3 == tmp_path / "home" / "webui" / "sessions"


def test_route_is_registered():
    src = (REPO_ROOT / "api" / "routes.py").read_text(encoding="utf-8")
    assert '"/api/bots/status"' in src


def test_now_defaults_to_wall_clock(tmp_path):
    sdir = tmp_path / "sessions"
    _write_index(sdir, {"s1": _entry(time.time() - 30)})
    out = bot_status.summarize_sessions_dir(sdir)
    assert out["unread_estimate"] == 1

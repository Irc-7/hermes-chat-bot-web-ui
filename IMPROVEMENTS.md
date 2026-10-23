# Improvements in this repository

This repository is based on [nesquena/hermes-webui](https://github.com/nesquena/hermes-webui)
(MIT), imported at upstream commit `543252f` (exp-v0.52.551). On top of that
snapshot it carries a UI improvement series designed after a teardown of
xAI/Cursor's Grok Bot desktop app: in Grok Bot the sidebar is the bot's
identity and work is triaged into three states — *needs attention*,
*working*, *unread activity*. The commits after the import bring that model
to this Web UI:

## Fase 2 — read-only bot status API (commit `5d9304f3` equivalent)

- New module `api/bot_status.py` and route `GET /api/bots/status`.
- Aggregates per-profile session-store metadata only (session count, last
  activity, a documented time-heuristic unread estimate) by reading each
  profile's on-disk session index — without activating the profile and
  without ever reading message bodies.
- Registered beside `/api/profiles` behind the same auth gate.
- Covered by `tests/test_bot_status.py` (14 tests, incl. payload content
  hygiene).

## Fase 1 — bot rail, triage, per-bot framing (commit `1096ed70` equivalent)

New additive frontend module `static/botrail.js` (no monolith refactor):

- **Two-zone rail:** a bot zone (one entry per profile from
  `GET /api/profiles`, initial avatar, a single status badge with priority
  attention > working > unread, local pins, local department groups)
  above the existing function zone.
- **Triage:** the active profile's badge and a *Needs attention* section at
  the top of the session list aggregate state the frontend already tracks
  (pending approvals/clarifications, streaming sessions, unread markers) —
  no new EventSource is opened.
- **Non-active bots** get a limited unread badge fed by
  `GET /api/bots/status`.
- **Framing:** persistent `Bot: <name> / <Panel>` breadcrumb and per-bot
  context tabs driving the existing `switchPanel()`.
- **Activity tab** in the workspace panel: live feed of tool cards,
  attention events and streaming edges for the active session.
- All new strings live in `static/i18n.js`; profile names and session
  titles render via `textContent` only — no new `innerHTML` sinks.

## Review fixes

Three `fix(review):` commits from an independent code review: full zh/cs
i18n coverage for the new `bot_*` keys, signature-based rendering for the
rail/attention/breadcrumb (no more full DOM rebuild every second), Activity
pane closing on programmatic workspace-tab switches, badge refresh right
after a successful bot switch, localised pin/unpin tooltips, and the
`bot_status` mtime fallback aligned with the session store's own
underscore-sidecar rule.

## Chat | Bot context tabs

The per-bot context tabs were simplified from five
(Chat | Sessions | Routines | Files | Bot Settings) to two —
**Chat | Bot** — mirroring Grok Bot's model: Chat is the working surface
(the session list already lives in its sidebar), and Bot is the bot's home
(the profile panel, focused on the active bot). Routines remain reachable
via the function-zone rail, Files via the workspace panel.

## Report

The full implementation report (method, self-check matrix against the
spec's acceptance criteria, review findings, and known limitations) is in
[docs/IMPLEMENTATION_REPORT.md](docs/IMPLEMENTATION_REPORT.md).

Known honest limits: cross-profile *approval* badges are intentionally not
promised (pending-approval state lives in the active profile's process);
live end-to-end verification (bot switching, approval events, working
indicator) requires a Hermes agent checkout and was **NOT RUN** in the
build environment.

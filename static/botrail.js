// ── Bot rail + sidebar triage (UI improvement spec, Fase 1) ─────────────
// Additive module: it does NOT fork the monolith's state machinery.
//   * Bot identity comes from GET /api/profiles (same payload the profile
//     panel uses); switching reuses the existing switchToProfile() flow
//     with all of its skeleton/embargo guards — never a raw POST.
//   * Triage for the ACTIVE profile is aggregated from state the frontend
//     already maintains: session rows in _allSessions carry `attention`
//     (approval/clarify), streaming, and viewed-count unread — the exact
//     predicates the sidebar rows themselves use (_sessionAttentionState,
//     _isSessionEffectivelyStreaming, _hasUnreadForSession). No new
//     EventSource is opened; a MutationObserver on #sessionList plus a
//     light 1s tick re-aggregates whenever that state changes.
//   * Non-active profiles get a LIMITED badge (unread estimate only) from
//     GET /api/bots/status (Fase 2). Approval state is process-local to
//     the active profile and is never faked cross-profile.
//   * All profile names / session titles render via textContent — no new
//     innerHTML sinks (see DEFICIENCIES S1).
(function () {
  'use strict';

  var LS_PINS = 'hermes-botrail-pins';
  var LS_GROUPS = 'hermes-botrail-groups';
  var LS_LAST = 'hermes-botrail-last-session';
  var LS_ACTIVITY_TAB = 'hermes-botrail-activity-tab';

  var _profiles = [];        // rows from /api/profiles
  var _statusByName = {};    // rows from /api/bots/status keyed by name
  var _currentPanel = 'chat';
  var _ctx = 'chat';         // chat | sessions | routines | files | settings
  var _activityLines = [];   // {ts, text}
  var _activityOpen = false;
  var _seenToolEls = (typeof WeakSet === 'function') ? new WeakSet() : null;
  var _lastAttentionKey = '';
  var _lastStreaming = false;
  var _started = false;

  function $(id) { return document.getElementById(id); }
  function _t(key, fallback) {
    try {
      if (typeof t === 'function') {
        var v = t(key);
        if (v && v !== key) return v;
      }
    } catch (_) { /* fall through */ }
    return fallback;
  }
  function _lsGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (_) { return fallback; }
  }
  function _lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode */ }
  }
  function _activeName() {
    try { return (typeof S !== 'undefined' && S && S.activeProfile) || 'default'; }
    catch (_) { return 'default'; }
  }
  function _sessions() {
    try {
      return (typeof _allSessions !== 'undefined' && Array.isArray(_allSessions)) ? _allSessions : [];
    } catch (_) { return []; }
  }
  function _initials(name) {
    var parts = String(name || '?').split(/[\s_\-]+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
  }

  // ── Triage aggregation (active profile, from existing state) ─────────
  function _activeAggregate() {
    var agg = { attention: null, working: false, unread: false };
    var rows = _sessions();
    for (var i = 0; i < rows.length; i++) {
      var s = rows[i];
      if (!agg.attention && typeof _sessionAttentionState === 'function') {
        var a = _sessionAttentionState(s);
        if (a) agg.attention = a;
      }
      if (!agg.working && typeof _isSessionEffectivelyStreaming === 'function'
          && _isSessionEffectivelyStreaming(s)) agg.working = true;
      if (!agg.unread && typeof _hasUnreadForSession === 'function'
          && _hasUnreadForSession(s)) agg.unread = true;
      if (agg.attention && agg.working && agg.unread) break;
    }
    return agg;
  }

  // Single badge, priority attention > working > unread (spec §4.1).
  function _badgeFor(name) {
    if (name === _activeName()) {
      var agg = _activeAggregate();
      if (agg.attention) return 'attention';
      if (agg.working) return 'working';
      if (agg.unread) return 'unread';
      return '';
    }
    var st = _statusByName[name];
    if (st && Number(st.unread_estimate) > 0) return 'unread';
    return '';
  }
  function _badgeTitle(kind) {
    if (kind === 'attention') return _t('bot_status_attention', 'Needs attention');
    if (kind === 'working') return _t('bot_status_working', 'Working');
    if (kind === 'unread') return _t('bot_status_unread', 'Unread activity');
    return '';
  }

  // ── Bot rail rendering ───────────────────────────────────────────────
  function _renderBotRail() {
    var zone = $('botRailZone');
    if (!zone) return;
    var pins = _lsGet(LS_PINS, []);
    var groups = _lsGet(LS_GROUPS, {});
    var active = _activeName();
    var sorted = _profiles.slice().sort(function (a, b) {
      var pa = pins.indexOf(a.name) !== -1 ? 0 : 1;
      var pb = pins.indexOf(b.name) !== -1 ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return String(a.name).localeCompare(String(b.name));
    });
    zone.textContent = '';
    var lastGroup = null;
    sorted.forEach(function (p) {
      var group = groups[p.name] || '';
      if (group !== lastGroup) {
        if (group) {
          var label = document.createElement('div');
          label.className = 'bot-rail-group-label';
          label.textContent = group;
          label.title = _t('bot_department', 'Department') + ': ' + group;
          zone.appendChild(label);
        }
        lastGroup = group;
      }
      var badge = _badgeFor(p.name);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bot-rail-btn'
        + (p.name === active ? ' active' : '')
        + (pins.indexOf(p.name) !== -1 ? ' pinned' : '');
      btn.setAttribute('aria-label', p.name);
      btn.title = p.name + (badge ? ' — ' + _badgeTitle(badge) : '');
      var initials = document.createElement('span');
      initials.textContent = _initials(p.name);
      btn.appendChild(initials);
      var dot = document.createElement('span');
      dot.className = 'bot-badge' + (badge ? ' ' + badge : '');
      btn.appendChild(dot);
      var pin = document.createElement('span');
      pin.className = 'bot-pin';
      pin.textContent = '★';
      pin.setAttribute('aria-hidden', 'true');
      btn.appendChild(pin);
      (function (name) {
        btn.addEventListener('click', function () { botRailBotClick(name); });
        btn.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          _togglePin(name);
        });
      })(p.name);
      zone.appendChild(btn);
    });
    var divider = $('botRailDivider');
    if (divider) divider.hidden = sorted.length === 0;
  }

  function _togglePin(name) {
    var pins = _lsGet(LS_PINS, []);
    var i = pins.indexOf(name);
    if (i === -1) pins.push(name); else pins.splice(i, 1);
    _lsSet(LS_PINS, pins);
    _renderBotRail();
  }

  // ── Bot click: reuse the guarded profile-switch flow ────────────────
  async function botRailBotClick(name) {
    if (name === _activeName()) {
      if (typeof switchPanel === 'function') switchPanel('chat');
      return;
    }
    if (typeof switchToProfile !== 'function') return;
    var ok = await switchToProfile(name);
    if (ok === false) { _refreshData(); return; }
    if (typeof switchPanel === 'function') switchPanel('chat');
    _botRailRefresh();
    _openLastSessionFor(name);
  }

  function _openLastSessionFor(name) {
    var last = _lsGet(LS_LAST, {})[name];
    if (!last) return;
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (_activeName() !== name || tries > 40) { clearInterval(timer); return; }
      var rows = _sessions();
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].session_id === last) {
          clearInterval(timer);
          if (typeof loadSession === 'function') loadSession(last);
          return;
        }
      }
    }, 250);
  }

  // ── Needs-attention section (top of the chat session list) ──────────
  function _renderAttentionSection() {
    var sec = $('attentionSection');
    var list = $('attentionList');
    if (!sec || !list) return;
    var rows = [];
    if (typeof _sessionAttentionState === 'function') {
      var all = _sessions();
      for (var i = 0; i < all.length; i++) {
        var a = _sessionAttentionState(all[i]);
        if (a) rows.push({ s: all[i], a: a });
      }
    }
    list.textContent = '';
    rows.forEach(function (row) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'attention-row';
      var title = document.createElement('span');
      title.className = 'attention-row-title';
      title.textContent = row.s.title || row.s.session_id || '';
      var kind = document.createElement('span');
      kind.className = 'attention-row-kind' + (row.a.kind === 'clarify' ? ' clarify' : '');
      kind.textContent = row.a.label;
      kind.title = row.a.title;
      btn.appendChild(title);
      btn.appendChild(kind);
      (function (sid) {
        btn.addEventListener('click', function () {
          if (typeof loadSession === 'function') loadSession(sid);
        });
      })(row.s.session_id);
      list.appendChild(btn);
    });
    sec.hidden = rows.length === 0;

    // Feed the activity panel + detect resolution (section empties out
    // live when an approval is answered, because the underlying session
    // rows lose their `attention` payload on the next list refresh).
    var key = rows.map(function (r) { return r.s.session_id + ':' + r.a.kind; }).join(',');
    if (key !== _lastAttentionKey) {
      if (key && rows.length) {
        _pushActivity(_t('bot_needs_attention', 'Needs attention') + ': '
          + (rows[0].s.title || rows[0].s.session_id || '') + ' (' + rows[0].a.label + ')');
      }
      _lastAttentionKey = key;
    }
  }

  // ── Framing: breadcrumb + context tabs ──────────────────────────────
  var PANEL_CTX = { tasks: 'routines', workspaces: 'files', profiles: 'settings', settings: 'settings' };
  var CTX_PANEL = { chat: 'chat', sessions: 'chat', routines: 'tasks', files: 'workspaces', settings: 'profiles' };

  function _panelLabel(panel) {
    var key = 'tab_' + panel;
    var v = _t(key, '');
    if (v) return v;
    return panel ? panel.charAt(0).toUpperCase() + panel.slice(1) : '';
  }
  function _syncFraming() {
    var bc = $('botBreadcrumb');
    if (bc) {
      var name = _activeName();
      bc.textContent = '';
      if (name) {
        bc.hidden = false;
        var prefix = document.createElement('span');
        prefix.textContent = _t('bot_breadcrumb_prefix', 'Bot') + ': ';
        var strong = document.createElement('strong');
        strong.textContent = name;
        var rest = document.createElement('span');
        rest.textContent = ' / ' + _panelLabel(_currentPanel);
        bc.appendChild(prefix);
        bc.appendChild(strong);
        bc.appendChild(rest);
      } else {
        bc.hidden = true;
      }
    }
    if (PANEL_CTX[_currentPanel]) _ctx = PANEL_CTX[_currentPanel];
    _syncContextTabs();
  }
  function _syncContextTabs() {
    var tabs = document.querySelectorAll('.bot-context-tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-botctx') === _ctx;
      tabs[i].classList.toggle('active', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }
  function botRailContext(ctx) {
    if (!CTX_PANEL[ctx]) ctx = 'chat';
    _ctx = ctx;
    if (typeof switchPanel === 'function') switchPanel(CTX_PANEL[ctx]);
    _syncContextTabs();
    if (ctx === 'sessions') {
      var inp = $('sessionSearch');
      if (inp) { try { inp.focus(); } catch (_) { /* noop */ } }
    }
  }

  function _wrapSwitchPanel() {
    if (typeof switchPanel !== 'function' || switchPanel._botRailWrapped) return;
    var orig = switchPanel;
    var wrapped = function (name, opts) {
      var r = orig.apply(this, arguments);
      _currentPanel = name || 'chat';
      _syncFraming();
      return r;
    };
    wrapped._botRailWrapped = true;
    try { window.switchPanel = wrapped; } catch (_) { /* non-configurable: framing still updates on tick */ }
  }

  // ── Activity tab in the workspace (right) panel ─────────────────────
  function _pushActivity(text) {
    if (!text) return;
    _activityLines.push({ ts: Date.now(), text: String(text).slice(0, 300) });
    if (_activityLines.length > 200) _activityLines.shift();
    if (_activityOpen) _renderActivity();
  }
  function _renderActivity() {
    var pane = $('workspaceActivity');
    if (!pane) return;
    pane.textContent = '';
    if (!_activityLines.length) {
      var empty = document.createElement('div');
      empty.className = 'activity-empty';
      empty.textContent = _t('bot_activity_empty', 'No activity yet for this session.')
        + ' ' + _t('bot_activity_live', 'Live tool and terminal activity for the active session appears here.');
      pane.appendChild(empty);
      return;
    }
    var lines = _activityLines.slice(-80);
    lines.forEach(function (line) {
      var div = document.createElement('div');
      div.className = 'activity-line';
      var time = document.createElement('span');
      time.className = 'activity-time';
      try { time.textContent = new Date(line.ts).toLocaleTimeString(); } catch (_) { time.textContent = ''; }
      div.appendChild(time);
      div.appendChild(document.createTextNode(line.text));
      pane.appendChild(div);
    });
    pane.scrollTop = pane.scrollHeight;
  }
  function _closeActivity() {
    if (!_activityOpen) return;
    _activityOpen = false;
    _lsSet(LS_ACTIVITY_TAB, false);
    var pane = $('workspaceActivity');
    if (pane) pane.hidden = true;
    var tab = $('workspaceActivityTab');
    if (tab) { tab.classList.remove('active'); tab.setAttribute('aria-selected', 'false'); }
    var ft = $('fileTree');
    if (ft && ft.style.display === 'none') ft.style.display = '';
  }
  function botRailShowActivity() {
    // Reset the built-in tabs through their own switch first so their
    // pane bookkeeping stays consistent, then take over the visuals.
    if (typeof switchWorkspacePanelTab === 'function') switchWorkspacePanelTab('files');
    _activityOpen = true;
    _lsSet(LS_ACTIVITY_TAB, true);
    ['workspaceFilesTab', 'workspaceArtifactsTab', 'workspaceTodosTab'].forEach(function (id) {
      var el = $(id);
      if (el) { el.classList.remove('active'); el.setAttribute('aria-selected', 'false'); }
    });
    var tab = $('workspaceActivityTab');
    if (tab) { tab.classList.add('active'); tab.setAttribute('aria-selected', 'true'); }
    var ft = $('fileTree');
    if (ft) ft.style.display = 'none';
    var empty = $('wsEmptyState');
    if (empty) empty.style.display = 'none';
    var pane = $('workspaceActivity');
    if (pane) { pane.hidden = false; _renderActivity(); }
  }
  function _wireActivityTabRestore() {
    ['workspaceFilesTab', 'workspaceArtifactsTab', 'workspaceTodosTab'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('click', _closeActivity);
    });
    // If other code switches the workspace tab programmatically, the
    // rightpanel dataset changes — close our pane to stay consistent.
    var panel = document.querySelector('.rightpanel');
    if (panel && typeof MutationObserver === 'function') {
      new MutationObserver(function () {
        if (_activityOpen && panel.dataset.activeTab && panel.dataset.activeTab !== 'files') _closeActivity();
      }).observe(panel, { attributes: true, attributeFilter: ['data-active-tab'] });
    }
  }

  // Tool-call cards appearing in the transcript feed the activity pane.
  function _observeTranscript() {
    var inner = $('msgInner');
    if (!inner || typeof MutationObserver !== 'function') return;
    new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        for (var i = 0; i < m.addedNodes.length; i++) {
          var node = m.addedNodes[i];
          if (!node || node.nodeType !== 1) continue;
          var cards = [];
          if (node.matches && node.matches('.tool-call, .tool-card')) cards.push(node);
          if (node.querySelectorAll) {
            var found = node.querySelectorAll('.tool-call, .tool-card');
            for (var j = 0; j < found.length; j++) cards.push(found[j]);
          }
          cards.forEach(function (card) {
            if (_seenToolEls) {
              if (_seenToolEls.has(card)) return;
              _seenToolEls.add(card);
            }
            var text = (card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140);
            if (text) _pushActivity(text);
          });
        }
      });
    }).observe(inner, { childList: true });
  }

  // ── Data refresh ────────────────────────────────────────────────────
  async function _refreshData() {
    if (typeof api === 'function') {
      try {
        var data = await api('/api/profiles');
        if (data && Array.isArray(data.profiles)) {
          _profiles = data.profiles.filter(function (p) { return p && p.visible !== false; });
        }
      } catch (_) { /* keep last known */ }
      try {
        var st = await api('/api/bots/status');
        if (st && Array.isArray(st.profiles)) {
          _statusByName = {};
          st.profiles.forEach(function (row) { if (row && row.name) _statusByName[row.name] = row; });
        }
      } catch (_) { /* endpoint absent on older backends: active-only badges */ }
    }
    _renderBotRail();
  }

  function _recordLastSession() {
    try {
      if (typeof S !== 'undefined' && S && S.session && S.session.session_id) {
        var name = _activeName();
        var map = _lsGet(LS_LAST, {});
        if (map[name] !== S.session.session_id) {
          map[name] = S.session.session_id;
          _lsSet(LS_LAST, map);
        }
      }
    } catch (_) { /* noop */ }
  }

  function _trackStreamingEdges() {
    var rows = _sessions();
    var active = null;
    try {
      var sid = (typeof S !== 'undefined' && S && S.session) ? S.session.session_id : null;
      for (var i = 0; i < rows.length; i++) if (rows[i].session_id === sid) { active = rows[i]; break; }
    } catch (_) { /* noop */ }
    var nowStreaming = !!(active && typeof _isSessionEffectivelyStreaming === 'function'
      && _isSessionEffectivelyStreaming(active));
    if (nowStreaming !== _lastStreaming) {
      _pushActivity(_t('bot_status_working', 'Working') + (nowStreaming ? '…' : ' ✓'));
      _lastStreaming = nowStreaming;
    }
  }

  function _botRailRefresh() {
    _recordLastSession();
    _renderBotRail();
    _renderAttentionSection();
    _syncFraming();
    _trackStreamingEdges();
  }

  function _start() {
    if (_started) return;
    _started = true;
    _wrapSwitchPanel();
    _wireActivityTabRestore();
    _observeTranscript();
    _refreshData();
    _botRailRefresh();
    if (_lsGet(LS_ACTIVITY_TAB, false)) botRailShowActivity();
    var list = $('sessionList');
    if (list && typeof MutationObserver === 'function') {
      new MutationObserver(function () { _botRailRefresh(); }).observe(list, { childList: true });
    }
    setInterval(_botRailRefresh, 1000);
    setInterval(_refreshData, 60000);
  }

  // Public entry points referenced by inline onclick handlers.
  window.botRailBotClick = botRailBotClick;
  window.botRailContext = botRailContext;
  window.botRailShowActivity = botRailShowActivity;
  window._botRailRefresh = _botRailRefresh;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _start);
  } else {
    _start();
  }
})();

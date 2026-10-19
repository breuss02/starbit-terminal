/* StarBit Claude webview — sessions as sockets, transcript reducer,
   gel prompt cards, composer. Plain JS, no framework, CSP-safe. */
(function () {
  const vscode = StarBit.client('claude');
  const root = document.getElementById('deck-claude');
  const Md = window.StarbitMd;
  const Stats = window.StarbitStats;
  const TermRail = window.StarbitTermRail;

  const $ = (cls) => root.querySelector('.' + cls);
  const tabsEl = $('tabs');
  const stageEl = $('stage');
  const statusText = $('statusText');
  const modeBtn = $('modeBtn');
  const modelBtn = $('modelBtn');
  const stopBtn = $('stopBtn');
  const themeBtn = $('themeBtn');
  const homeBtn = $('homeBtn');
  const composerEl = $('composer');
  const inputEl = $('composer-input');
  const sendBtn = $('sendBtn');
  const popEl = $('pop');
  const trayEl = $('tray');
  const statsRail = $('rail-stats');
  const termRailEl = $('rail-term');

  const MAX_SESSIONS = 8;
  const MAX_RESULT_CHARS = 4000;
  const MODES = [
    ['default', 'ask'],
    ['acceptEdits', 'edits'],
    ['plan', 'plan']
  ];

  let themeMode = document.body.dataset.theme === 'dark' ? 'dark' : 'light';
  let boot = { cwd: '', defaultMode: 'default', model: '', resumable: [] };

  const sessions = [];
  let seq = 0;
  let activeId = null;
  let lastWakeTab = null;
  let sidePanels = true; // starbit.claude.sidePanels
  let railed = false; // the tray has room for the terminal rail
  let wide = false; // …and for the stats rail too
  let railsBooted = false; // no rails (and no shell) until boot says whether they are wanted

  /* ------------------------------------------------------------------ */
  /* helpers                                                            */
  /* ------------------------------------------------------------------ */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function withSel(btn) {
    btn.appendChild(el('span', 'sel'));
    return btn;
  }

  function basename(p) {
    return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  }

  function relPath(p) {
    const s = String(p || '');
    if (boot.cwd && s.startsWith(boot.cwd)) {
      return s.slice(boot.cwd.length).replace(/^[\\/]/, '') || '.';
    }
    return s;
  }

  function shortModel(m) {
    const s = String(m || '');
    if (!s) return 'default';
    if (/fable/i.test(s)) return 'fable';
    if (/opus/i.test(s)) return 'opus';
    if (/sonnet/i.test(s)) return 'sonnet';
    if (/haiku/i.test(s)) return 'haiku';
    return s.replace(/^claude-/, '').slice(0, 12);
  }

  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n) + '\n… (' + (s.length - n) + ' more chars)' : s;
  }

  function firstLine(s) {
    return String(s || '').split('\n')[0];
  }

  // the CLI's local command output carries terminal bold/dim codes
  function stripAnsi(s) {
    return String(s || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  }

  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }

  // human name for a model id, preferring the CLI's own display names
  function modelLabel(s, value) {
    const v = String(value || '');
    if (!v) return 'default';
    const list = s.models || [];
    const hit =
      list.find((m) => m.value === v || m.displayName === v) ||
      // aliases ('haiku', 'opus[1m]') → the entry with the same family
      list.find((m) => m.value !== 'default' && shortModel(m.value) === shortModel(v));
    if (hit && hit.displayName) return hit.displayName;
    return v.replace(/^claude-/, '').replace(/-(\d)-(\d)/, '-$1.$2').replace(/-\d{8}$/, '');
  }

  function nearBottom(card) {
    return card.scrollHeight - card.scrollTop - card.clientHeight < 60;
  }

  function scrollDown(s, force) {
    if (force || s.pin) s.card.scrollTop = s.card.scrollHeight;
  }

  function active() {
    return sessions.find((s) => s.id === activeId);
  }

  /* ------------------------------------------------------------------ */
  /* sessions                                                           */
  /* ------------------------------------------------------------------ */

  function freeSlot() {
    for (let i = 0; i < MAX_SESSIONS; i++) {
      if (!sessions.some((s) => s.slot === i)) return i;
    }
    return -1;
  }

  function createSession(slot) {
    if (slot === undefined || sessions.some((s) => s.slot === slot)) slot = freeSlot();
    if (slot === -1) return null;

    const id = 's' + ++seq;
    const root = el('div', 'session');
    const card = el('div', 'card');
    const transcript = el('div', 'transcript');
    const empty = el('div', 'blank');
    empty.appendChild(el('span', 'star', '✦'));
    empty.appendChild(document.createTextNode('starting claude…'));
    card.appendChild(transcript);
    card.appendChild(empty);
    root.appendChild(card);
    stageEl.appendChild(root);

    const s = {
      id,
      slot,
      label: String(slot + 1),
      root,
      card,
      transcript,
      empty,
      running: false,
      alive: true,
      ready: false,
      needs: 0,
      unread: false,
      sessionId: null,
      model: boot.model,
      mode: boot.defaultMode,
      ctxPct: null,
      draft: '',
      lastSent: null,
      chips: new Map(), // tool_use_id -> chip
      asks: new Map(), // toolUseID -> card
      cur: null, // streaming state for the message in flight
      streamed: null, // last streamed assistant message, for reconcile
      commands: [],
      models: [],
      pin: true,
      resumeId: null,
      compact: null, // the compaction card in progress (or the last one)
      retry: null, // the api_retry note in progress
      lastSwitch: null, // { to, at } — dedupes the CLI's echo of our own model change
      stats: Stats.create(), // the left rail's numbers
      replaying: false // true while a resumed transcript is fed through the reducer
    };
    card.addEventListener('scroll', () => {
      s.pin = nearBottom(card);
    });
    // like a terminal, stay on the latest line when the panel is resized:
    // reflowed text changes the scroll height, so re-pin if we were pinned
    if (typeof ResizeObserver === 'function') {
      s.ro = new ResizeObserver(() => {
        if (s.pin && root.classList.contains('active')) scrollDown(s, true);
      });
      s.ro.observe(card);
    }
    sessions.push(s);

    vscode.postMessage({ type: 'create', id });
    activateSession(id);
    return s;
  }

  function closeSession(id) {
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const s = sessions[idx];
    vscode.postMessage({ type: 'kill', id });
    if (s.ro) s.ro.disconnect();
    s.root.remove();
    sessions.splice(idx, 1);
    if (sessions.length === 0) {
      createSession();
      return;
    }
    if (activeId === id) activateSession(sessions[Math.max(0, idx - 1)].id);
    renderTabs();
  }

  function activateSession(id) {
    const prev = active();
    if (prev) prev.draft = inputEl.value;
    activeId = id;
    for (const s of sessions) s.root.classList.toggle('active', s.id === id);
    const s = active();
    if (s) {
      s.unread = false;
      inputEl.value = s.draft || '';
      autosize();
      scrollDown(s, true);
    }
    renderTabs();
    updateChrome();
    renderStats();
  }

  // which star bit a session tile shows
  const STAR_TITLE = { need: 'needs you', busy: 'working', ready: 'ready', off: 'ended' };
  function starState(s) {
    if (!s.alive) return 'off';
    if (s.needs > 0) return 'need';
    if (s.running || !s.ready) return 'busy';
    return 'ready';
  }

  function renderTabs() {
    tabsEl.textContent = '';
    for (let i = 0; i < MAX_SESSIONS; i++) {
      const s = sessions.find((x) => x.slot === i);
      if (!s) {
        const socket = el('button', 'socket empty');
        socket.title = 'New Claude session';
        socket.addEventListener('click', () => createSession(i));
        tabsEl.appendChild(socket);
        continue;
      }
      const socket = el('div', 'socket filled');
      const btn = el('button', 'tab' + (s.id === activeId ? ' active' : ''));
      if (s.id === activeId && activeId !== lastWakeTab) btn.classList.add('wake');
      const state = starState(s);
      btn.title = 'Session ' + s.label + ' · ' + STAR_TITLE[state] + (s.sessionId ? ' · ' + s.sessionId.slice(0, 8) : '');
      // the tile's face is a status star bit, not a number: green at rest,
      // spinning gold while claude works, pulsing red when it needs you
      const star = el('span', 'tab-star ' + state, '✦');
      star.setAttribute('aria-label', STAR_TITLE[state]);
      btn.appendChild(star);
      if (s.unread) btn.appendChild(el('span', 'tab-badge unread', '•'));
      btn.appendChild(el('span', 'sel'));
      const x = el('span', 'tab-x', '×');
      x.title = 'Close session';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSession(s.id);
      });
      btn.appendChild(x);
      btn.addEventListener('click', () => activateSession(s.id));
      socket.appendChild(btn);
      tabsEl.appendChild(socket);
    }
    lastWakeTab = activeId;
  }

  function updateChrome() {
    const s = active();
    if (!s) return;
    const parts = [shortModel(s.model), basename(boot.cwd)];
    if (s.ctxPct !== null) parts.push(s.ctxPct + '%');
    statusText.textContent = s.ready ? parts.join(' · ') : '';
    statusText.classList.toggle('running', s.running);
    statusText.classList.toggle('ctx-warn', s.ctxPct !== null && s.ctxPct >= 70 && s.ctxPct < 90);
    statusText.classList.toggle('ctx-hot', s.ctxPct !== null && s.ctxPct >= 90);

    // a mode with no key of its own (bypassPermissions, …) shows as itself, never as "ask"
    const mode = MODES.find((m) => m[0] === s.mode) || [s.mode, s.mode];
    modeBtn.textContent = mode[1];
    modeBtn.dataset.mode = mode[0];
    modelBtn.textContent = shortModel(s.model);
    stopBtn.disabled = !s.running;
    homeBtn.disabled = s.transcript.childElementCount === 0;

    const blocked = s.needs > 0 || !s.alive;
    composerEl.classList.toggle('blocked', blocked);
    inputEl.disabled = !s.alive;
    inputEl.placeholder = !s.alive
      ? 'session ended — open a new socket'
      : s.needs > 0
        ? 'answer claude above to continue'
        : s.running
          ? 'queue another message…'
          : 'ask claude…';
    sendBtn.disabled = blocked;
  }

  /* ------------------------------------------------------------------ */
  /* transcript blocks                                                  */
  /* ------------------------------------------------------------------ */

  function addBlock(s, node) {
    s.pin = nearBottom(s.card) || s.transcript.childElementCount === 0;
    s.transcript.appendChild(node);
    scrollDown(s);
    return node;
  }

  /* notes: a small pill on a dashed rule — 'rule' (neutral event),
     'warn' (amber), 'err' (red, wraps), 'mono' (raw block output) */
  const NOTE_ICON = { rule: '✦', warn: '!', err: '✕' };

  function noteNode(text, cls) {
    cls = cls || '';
    if (cls === 'mono') return el('div', 'note mono', text);
    const n = el('div', 'note ' + cls);
    const pill = el('span', 'note-pill');
    const icon = NOTE_ICON[cls];
    if (icon) pill.appendChild(el('span', 'note-ico', icon));
    pill.appendChild(el('span', 'note-text', text));
    n.appendChild(pill);
    return n;
  }

  function addNote(s, text, cls) {
    return addBlock(s, noteNode(text, cls));
  }

  /* ---- events: compaction card + model switch graphic ---- */

  function compactCard(s) {
    if (s.compact && !s.compact.done) return s.compact;
    const card = el('div', 'event compact busy');
    const head = el('div', 'event-head');
    head.appendChild(el('span', 'event-ico', '✦'));
    const text = el('span', 'event-text', 'compacting context…');
    head.appendChild(text);
    const meta = el('span', 'event-meta', '');
    head.appendChild(meta);
    const arrow = el('span', 'chip-arrow', '▶');
    arrow.hidden = true;
    head.appendChild(arrow);
    const body = el('div', 'event-body');
    body.hidden = true;
    card.appendChild(head);
    card.appendChild(body);
    head.addEventListener('click', () => {
      if (body.hidden) return;
      card.classList.toggle('open');
    });
    const c = { el: card, head, text, meta, arrow, body, done: false, summary: false };
    s.compact = c;
    addBlock(s, card);
    return c;
  }

  function compactDone(s, meta) {
    const c = compactCard(s);
    c.done = true;
    c.el.classList.remove('busy');
    c.el.classList.add('done');
    c.text.textContent = 'compacted';
    if (meta && meta.pre_tokens) {
      c.meta.textContent = fmtTokens(meta.pre_tokens) + (meta.post_tokens ? ' → ' + fmtTokens(meta.post_tokens) : '') + ' tokens';
    }
    scrollDown(s);
  }

  function compactSummary(s, text) {
    // the long "This session is being continued…" message: tuck it inside
    // the compaction card behind a disclosure instead of a chat bubble
    const c = s.compact && !s.compact.summary ? s.compact : compactCard(s);
    if (!c.done) compactDone(s, null);
    c.summary = true;
    c.body.textContent = '';
    c.body.appendChild(el('div', 'label', 'summary'));
    const md = el('div', 'md');
    md.appendChild(Md.render(text));
    c.body.appendChild(md);
    c.body.hidden = false;
    c.arrow.hidden = false;
    c.el.classList.add('has-summary');
  }

  function compactFailed(s, err) {
    const c = compactCard(s);
    c.done = true;
    c.el.classList.remove('busy');
    c.el.classList.add('failed');
    c.text.textContent = 'compaction failed' + (err ? ' — ' + err : '');
  }

  function modelSwitch(s, from, to, caption) {
    const card = el('div', 'event model');
    const swap = el('div', 'model-swap');
    const a = el('span', 'model-tile from', modelLabel(s, from));
    a.appendChild(el('span', 'sel'));
    swap.appendChild(a);
    const arrow = el('span', 'model-arrow');
    for (let i = 0; i < 3; i++) arrow.appendChild(el('i', '', '✦'));
    swap.appendChild(arrow);
    const b = el('span', 'model-tile to', modelLabel(s, to));
    b.appendChild(el('span', 'sel'));
    swap.appendChild(b);
    card.appendChild(swap);
    card.appendChild(el('div', 'event-cap', caption || 'model switched'));
    s.lastSwitch = { to: shortModel(to), at: Date.now() };
    addBlock(s, card);
    scrollDown(s);
    return card;
  }

  /* the CLI's own output for slash commands (`/model`, `/compact`, …) */
  function localOutput(s, raw) {
    const text = stripAnsi(raw).trim();
    if (!text) return;
    let m;
    if ((m = text.match(/^Set model to\s+`?(.+?)`?(?:\s+and saved.*)?$/))) {
      // "haiku (claude-haiku-4-5-20251001)" → keep the id when the CLI gives one
      const idm = m[1].match(/\((claude-[^)]*)\)\s*$/);
      const name = idm ? idm[1] : m[1].replace(/\s*\((?:default)\)\s*$/, '').trim();
      const recent = s.lastSwitch && Date.now() - s.lastSwitch.at < 8000 && s.lastSwitch.to === shortModel(name);
      if (!recent) modelSwitch(s, s.model, name);
      s.model = name;
      updateChrome();
      return;
    }
    if (/^Kept model as/.test(text)) return;
    if (/^Compacted\b/.test(text)) {
      if (!s.compact || !s.compact.done) compactDone(s, null);
      return;
    }
    if (/^Conversation compacted/i.test(text)) return;
    addBlock(s, noteNode(text, 'mono'));
  }

  // "<command-name>/model</command-name> … <command-args>opus</command-args>"
  const CMD_RE = /^\s*<command-name>([^<]*)<\/command-name>(?:[\s\S]*?<command-args>([\s\S]*?)<\/command-args>)?/;
  const STDOUT_RE = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/;
  const STDERR_RE = /^\s*<local-command-stderr>([\s\S]*?)<\/local-command-stderr>\s*$/;

  function addYou(s, text) {
    return addBlock(s, el('div', 'msg you', text));
  }

  function newClaudeMsg(s) {
    return addBlock(s, el('div', 'msg claude'));
  }

  function renderMd(block) {
    if (block.timer) {
      clearTimeout(block.timer);
      block.timer = null;
    }
    block.el.textContent = '';
    block.el.appendChild(Md.render(block.raw));
  }

  function scheduleRender(s, block) {
    if (block.timer) return;
    block.timer = setTimeout(() => {
      block.timer = null;
      renderMd(block);
      scrollDown(s);
    }, 60);
  }

  /* ---- tool chips ---- */

  const PATH_KEYS = ['file_path', 'path', 'notebook_path'];

  function summarize(name, input) {
    input = input || {};
    const p = PATH_KEYS.map((k) => input[k]).find(Boolean);
    switch (name) {
      case 'Bash':
        return firstLine(input.command || input.description || '');
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookEdit':
        return relPath(p || '');
      case 'Grep':
      case 'Glob':
        return (input.pattern || '') + (p ? '  in ' + relPath(p) : '');
      case 'WebFetch':
      case 'WebSearch':
        return input.url || input.query || '';
      case 'Agent':
      case 'Task':
        return input.description || firstLine(input.prompt || '');
      case 'TodoWrite':
        return (input.todos || []).length + ' items';
      case 'Skill':
        return input.skill || input.name || '';
      case 'AskUserQuestion':
        return firstLine((input.questions || [{}])[0].question || '');
      default: {
        const first = Object.values(input).find((v) => typeof v === 'string');
        return first ? firstLine(first) : '';
      }
    }
  }

  function partialSummary(name, buf) {
    // pull the primary argument out of half-streamed JSON
    const keys =
      name === 'Bash' ? ['command'] : name === 'Grep' || name === 'Glob' ? ['pattern'] : PATH_KEYS.concat(['url', 'query', 'description']);
    for (const k of keys) {
      const m = buf.match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)'));
      if (m) {
        try {
          return firstLine(JSON.parse('"' + m[1] + '"'));
        } catch {
          return firstLine(m[1]);
        }
      }
    }
    return '';
  }

  function makeChip(s, toolUseId, name, sub) {
    const chip = el('div', 'chip' + (sub ? ' sub' : ''));
    const head = el('div', 'chip-head');
    head.appendChild(el('span', 'chip-arrow', '▶'));
    head.appendChild(el('span', 'chip-tool', name));
    const sum = el('span', 'chip-sum');
    sum.appendChild(el('bdi', '', ''));
    head.appendChild(sum);
    const meta = el('span', 'chip-meta', '');
    head.appendChild(meta);
    head.appendChild(el('span', 'chip-state wait', '●'));
    const body = el('div', 'chip-body');
    chip.appendChild(head);
    chip.appendChild(body);
    head.addEventListener('click', () => chip.classList.toggle('open'));

    const c = { el: chip, name, sum: sum.firstChild, meta, state: head.lastChild, body, input: null, done: false, resultEl: null };
    s.chips.set(toolUseId, c);
    addBlock(s, chip);
    return c;
  }

  function chipPartial(c, buf) {
    if (c.input) return;
    const t = partialSummary(c.name, buf);
    if (t) c.sum.textContent = t;
  }

  function diffNode(oldStr, newStr) {
    const d = el('div', 'diff');
    for (const line of String(oldStr || '').split('\n')) d.appendChild(el('span', 'del', line));
    for (const line of String(newStr || '').split('\n')) d.appendChild(el('span', 'add', line));
    return d;
  }

  function pathNode(p) {
    const n = el('span', 'chip-path', relPath(p));
    n.title = 'Open ' + p;
    n.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'openFile', path: p });
    });
    return n;
  }

  function chipInput(c, input) {
    c.input = input || {};
    const text = summarize(c.name, c.input);
    c.sum.textContent = text;
    const body = c.body;
    body.textContent = '';
    const p = PATH_KEYS.map((k) => c.input[k]).find(Boolean);

    if (c.name === 'Edit') {
      const add = String(c.input.new_string || '').split('\n').length;
      const del = String(c.input.old_string || '').split('\n').length;
      c.meta.textContent = '+' + add + ' −' + del;
      c.meta.className = 'chip-meta add';
      if (p) body.appendChild(pathNode(p));
      body.appendChild(el('div', 'label', 'change'));
      body.appendChild(diffNode(c.input.old_string, c.input.new_string));
    } else if (c.name === 'MultiEdit') {
      const edits = c.input.edits || [];
      c.meta.textContent = edits.length + ' edits';
      if (p) body.appendChild(pathNode(p));
      edits.forEach((e, i) => {
        body.appendChild(el('div', 'label', 'edit ' + (i + 1)));
        body.appendChild(diffNode(e.old_string, e.new_string));
      });
    } else if (c.name === 'Write') {
      const content = String(c.input.content || '');
      c.meta.textContent = content.split('\n').length + ' lines';
      if (p) body.appendChild(pathNode(p));
      body.appendChild(el('div', 'label', 'content'));
      body.appendChild(el('div', 'text', truncate(content, MAX_RESULT_CHARS)));
    } else if (c.name === 'Bash') {
      body.appendChild(el('div', 'label', 'command'));
      body.appendChild(el('div', 'text', c.input.command || ''));
      if (c.input.description) body.appendChild(el('div', 'label', c.input.description));
    } else if (c.name === 'TodoWrite') {
      body.appendChild(el('div', 'label', 'todos'));
      const ul = el('ul');
      for (const t of c.input.todos || []) {
        const mark = t.status === 'completed' ? '✓ ' : t.status === 'in_progress' ? '▶ ' : '○ ';
        ul.appendChild(el('li', '', mark + (t.content || t.activeForm || '')));
      }
      body.appendChild(ul);
    } else {
      body.appendChild(el('div', 'label', 'input'));
      if (p) body.appendChild(pathNode(p));
      body.appendChild(el('div', 'text', truncate(JSON.stringify(c.input, null, 2), MAX_RESULT_CHARS)));
    }
    if (c.resultEl) body.appendChild(c.resultEl);
  }

  function chipResult(s, block) {
    let c = s.chips.get(block.tool_use_id);
    if (!c) c = makeChip(s, block.tool_use_id, 'tool');
    if (!c.input) chipInput(c, {});
    let text = '';
    if (typeof block.content === 'string') text = block.content;
    else if (Array.isArray(block.content)) {
      text = block.content.map((b) => (b.type === 'text' ? b.text : '[' + b.type + ']')).join('\n');
    }
    c.done = true;
    c.state.className = 'chip-state ' + (block.is_error ? 'err' : 'ok');
    c.state.textContent = block.is_error ? '✗' : '✓';
    const holder = el('div');
    holder.appendChild(el('div', 'label', block.is_error ? 'error' : 'result'));
    holder.appendChild(el('div', 'text' + (block.is_error ? ' err' : ''), truncate(text, MAX_RESULT_CHARS) || '(empty)'));
    c.resultEl = holder;
    c.body.appendChild(holder);
  }

  /* ------------------------------------------------------------------ */
  /* SDK message reducer                                                */
  /* ------------------------------------------------------------------ */

  function handleSdk(s, msg) {
    const changed = Stats.onSdk(s.stats, msg, s.replaying || msg.isReplay);
    if (changed) statsChanged(s, changed);
    switch (msg.type) {
      case 'system':
        onSystem(s, msg);
        break;
      case 'stream_event':
        if (!msg.parent_tool_use_id) onStream(s, msg.event);
        break;
      case 'assistant':
        onAssistant(s, msg);
        break;
      case 'user':
        onUser(s, msg);
        break;
      case 'result':
        onResult(s, msg);
        break;
      case 'tool_progress': {
        const c = s.chips.get(msg.tool_use_id);
        if (c && !c.done) c.meta.textContent = Math.round(msg.elapsed_time_seconds) + 's';
        break;
      }
      default:
        break;
    }
  }

  function markReady(s) {
    if (s.ready) return;
    s.ready = true;
    renderHome(s);
    renderTabs();
    updateChrome();
    if (s.id === activeId) inputEl.focus();
  }

  function ago(ts) {
    const d = Math.max(0, Date.now() - (ts || 0));
    const m = Math.round(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    const days = Math.round(h / 24);
    return days === 1 ? 'yesterday' : days + 'd ago';
  }

  // star bit colours (Galaxy): gold, green, blue, pink, purple, white
  const STARBITS = ['#f5c84c', '#3ec98f', '#2f9df4', '#f0647f', '#a86ce8', '#e3ebf5'];

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }

  // the same ✦ sparkle used by empty sockets and the loading state, tinted
  function starBit(color) {
    const n = el('span', 'app-ico', '✦');
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    n.style.color = color;
    n.style.textShadow = '0 0 9px rgba(' + r + ',' + g + ',' + b + ',0.55)';
    return n;
  }

  /* 3DS HOME menu: a row of app tiles (new chat + recent chats), the
     bracket cursor on the current one, and a speech bubble naming it */
  function renderHome(s) {
    const home = s.empty;
    home.textContent = '';
    home.className = 'blank home';

    const bubble = el('div', 'home-bubble');
    const bubbleText = el('span', 'home-bubble-text');
    bubble.appendChild(bubbleText);
    home.appendChild(bubble);

    const recent = (boot.resumable || []).filter((r) => r.id !== s.sessionId).slice(0, 6);
    const items = [{ kind: 'new', title: 'New chat in ' + basename(boot.cwd), cap: 'new' }].concat(
      recent.map((r) => ({ kind: 'chat', title: r.title || 'untitled chat', cap: ago(r.at), id: r.id }))
    );

    const row = el('div', 'home-row');
    const tiles = [];
    const setCur = (i) => {
      tiles.forEach((t, j) => t.classList.toggle('cur', j === i));
      bubbleText.textContent = items[i].title;
    };
    items.forEach((it, i) => {
      const wrap = el('div', 'app-wrap');
      const t = withSel(el('button', 'app ' + it.kind));
      t.title = it.title;
      if (it.kind === 'new') {
        t.appendChild(starBit(STARBITS[0]));
        t.appendChild(el('span', 'app-plus', '+'));
      } else {
        // each chat keeps its own colour (hash of the session id), never gold
        t.appendChild(starBit(STARBITS[1 + (hashStr(it.id) % (STARBITS.length - 1))]));
      }
      t.addEventListener('mouseenter', () => setCur(i));
      t.addEventListener('focus', () => setCur(i));
      t.addEventListener('click', () => {
        if (it.kind === 'new') inputEl.focus();
        else resetSession(s, it.id);
      });
      t.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          tiles[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length].focus();
        }
      });
      wrap.appendChild(t);
      wrap.appendChild(el('span', 'app-cap', it.cap));
      row.appendChild(wrap);
      tiles.push(t);
    });
    home.appendChild(row);
    setCur(items.length > 1 ? 1 : 0);
    home.appendChild(
      el('div', 'home-hint', items.length > 1 ? 'pick a recent chat, or just start typing' : 'no recent chats yet — just start typing')
    );
  }

  function onSystem(s, msg) {
    switch (msg.subtype) {
      case 'init':
        // arrives at the start of every turn (not at spawn) — treat it as a
        // metadata refresh; readiness normally comes from 'sessionInfo', this
        // is the fallback when the process could not answer initInfo
        s.model = msg.model || s.model;
        s.mode = msg.permissionMode || s.mode;
        if (!s.sessionId) {
          s.sessionId = msg.session_id;
          if (!s.commands.length) {
            s.commands = (msg.slash_commands || []).map((n) => ({ name: n, description: '', argumentHint: '' }));
          }
          markReady(s);
          renderTabs();
        }
        updateChrome();
        break;
      case 'status':
        // 'requesting' fires on every API call; only compaction is worth a card
        if (msg.status === 'compacting') compactCard(s);
        if (msg.compact_result === 'failed') compactFailed(s, msg.compact_error);
        if (msg.permissionMode) {
          s.mode = msg.permissionMode;
          updateChrome();
        }
        break;
      case 'compact_boundary':
        compactDone(s, msg.compact_metadata);
        break;
      case 'local_command_output':
        localOutput(s, msg.content || '');
        break;
      case 'api_retry': {
        const text = 'retrying' + (msg.max_retries ? ' (' + msg.attempt + '/' + msg.max_retries + ')' : '') + '…';
        if (s.retry && s.retry.isConnected) s.retry.querySelector('.note-text').textContent = text;
        else s.retry = addNote(s, text, 'warn');
        break;
      }
      case 'model_refusal_fallback':
        if (msg.scope !== 'local') {
          modelSwitch(s, msg.original_model, msg.fallback_model, 'fell back after a refusal');
          s.model = msg.fallback_model;
          updateChrome();
        }
        break;
      case 'informational':
        if (msg.level === 'warning' || msg.level === 'suggestion') addNote(s, stripAnsi(msg.content || ''), 'warn');
        break;
      case 'permission_denied': {
        const c = s.chips.get(msg.tool_use_id);
        if (c) {
          c.done = true;
          c.state.className = 'chip-state deny';
          c.state.textContent = '⊘';
        }
        addNote(s, 'denied ' + msg.tool_name + (msg.message ? ' — ' + msg.message : ''), 'warn');
        break;
      }
      default:
        break;
    }
  }

  function ensureMsg(s) {
    if (!s.cur) s.cur = { msgEl: null, blocks: {} };
    if (!s.cur.msgEl) s.cur.msgEl = newClaudeMsg(s);
    return s.cur.msgEl;
  }

  function onStream(s, ev) {
    if (!ev) return;
    switch (ev.type) {
      case 'message_start':
        s.cur = { msgEl: null, blocks: {} };
        s.streamed = s.cur;
        break;
      case 'content_block_start': {
        if (!s.cur) s.cur = s.streamed = { msgEl: null, blocks: {} };
        const cb = ev.content_block || {};
        if (cb.type === 'text') {
          const md = el('div', 'md');
          ensureMsg(s).appendChild(md);
          s.cur.blocks[ev.index] = { kind: 'text', el: md, raw: cb.text || '', timer: null };
        } else if (cb.type === 'tool_use') {
          const chip = makeChip(s, cb.id, cb.name);
          s.cur.blocks[ev.index] = { kind: 'tool', chip, buf: '' };
        } else if (cb.type === 'thinking') {
          const t = el('div', 'thinking', 'thinking…');
          ensureMsg(s).appendChild(t);
          s.cur.blocks[ev.index] = { kind: 'think', el: t, raw: '' };
        }
        break;
      }
      case 'content_block_delta': {
        const b = s.cur && s.cur.blocks[ev.index];
        if (!b) break;
        const d = ev.delta || {};
        if (d.type === 'text_delta' && b.kind === 'text') {
          b.raw += d.text;
          scheduleRender(s, b);
        } else if (d.type === 'input_json_delta' && b.kind === 'tool') {
          b.buf += d.partial_json;
          chipPartial(b.chip, b.buf);
        } else if (d.type === 'thinking_delta' && b.kind === 'think') {
          b.raw += d.thinking;
          if (b.raw.trim()) b.el.textContent = b.raw;
        }
        break;
      }
      case 'content_block_stop': {
        const b = s.cur && s.cur.blocks[ev.index];
        if (!b) break;
        if (b.kind === 'text') renderMd(b);
        if (b.kind === 'tool') {
          try {
            chipInput(b.chip, JSON.parse(b.buf || '{}'));
          } catch {
            /* final input arrives with the assistant message */
          }
        }
        if (b.kind === 'think' && !b.raw.trim()) b.el.remove();
        scrollDown(s);
        break;
      }
      case 'message_stop':
        s.cur = null;
        break;
      default:
        break;
    }
  }

  function onAssistant(s, msg) {
    const content = (msg.message && msg.message.content) || [];
    if (msg.parent_tool_use_id) {
      for (const b of content) {
        if (b.type === 'tool_use' && !s.chips.has(b.id)) chipInput(makeChip(s, b.id, b.name, true), b.input);
      }
      return;
    }
    if (msg.error) addNote(s, errorLabel(msg.error), 'err');

    const streamed = s.streamed;
    s.streamed = null;
    s.cur = null;
    if (streamed) {
      // reconcile: final tool inputs + final text
      const textBlocks = Object.values(streamed.blocks).filter((b) => b.kind === 'text');
      let ti = 0;
      for (const b of content) {
        if (b.type === 'tool_use') {
          const c = s.chips.get(b.id);
          if (c) chipInput(c, b.input);
          else chipInput(makeChip(s, b.id, b.name), b.input);
        } else if (b.type === 'text') {
          const tb = textBlocks[ti++];
          if (tb && tb.raw !== b.text) {
            tb.raw = b.text;
            renderMd(tb);
          }
        }
      }
      return;
    }
    // no streaming happened (resume replay, or partial messages off)
    let msgEl = null;
    for (const b of content) {
      if (b.type === 'text' && b.text.trim()) {
        if (!msgEl) msgEl = newClaudeMsg(s);
        const md = el('div', 'md');
        md.appendChild(Md.render(b.text));
        msgEl.appendChild(md);
      } else if (b.type === 'tool_use') {
        chipInput(s.chips.get(b.id) || makeChip(s, b.id, b.name), b.input);
      }
    }
    scrollDown(s);
  }

  function onUser(s, msg) {
    const content = msg.message && msg.message.content;
    if (typeof content === 'string') {
      userText(s, content, msg);
      return;
    }
    if (!Array.isArray(content)) return;
    const texts = [];
    for (const b of content) {
      if (b.type === 'tool_result') chipResult(s, b);
      else if (b.type === 'text') texts.push(b.text);
    }
    if (texts.length) userText(s, texts.join('\n'), msg);
  }

  function userText(s, text, msg) {
    if (msg.isSynthetic) return;
    if (!msg.isReplay && s.lastSent !== null && text === s.lastSent) {
      s.lastSent = null; // our own echo
      return;
    }
    if (/^\[Request interrupted/.test(text)) {
      addNote(s, 'interrupted', 'warn');
      return;
    }
    // the CLI's bookkeeping for slash commands: the "<command-name>" echo
    // (we already showed what was typed), its stdout, and the compaction
    // summary it injects — none of these are chat bubbles
    if (msg.isCompactSummary || /^This session is being continued from a previous conversation/.test(text)) {
      compactSummary(s, text);
      return;
    }
    let m;
    if ((m = text.match(CMD_RE))) {
      if (m[1].trim() === '/clear') {
        clearTranscript(s);
        Stats.reset(s.stats);
        statsChanged(s, 'full');
      }
      return;
    }
    if ((m = text.match(STDOUT_RE))) {
      localOutput(s, m[1]);
      return;
    }
    if ((m = text.match(STDERR_RE))) {
      addNote(s, stripAnsi(m[1]).trim(), 'err');
      return;
    }
    if (/^\s*<system-reminder>/.test(text)) return;
    addYou(s, text);
  }

  const RESULT_LABEL = {
    error_during_execution: 'something went wrong while running',
    error_max_turns: 'stopped — max turns reached',
    error_max_budget_usd: 'stopped — budget reached',
    error_max_structured_output_retries: 'stopped — could not produce structured output'
  };

  function errorLabel(code) {
    const c = String(code || 'error');
    return RESULT_LABEL[c] || c.replace(/^error_/, '').replace(/_/g, ' ');
  }

  function onResult(s, msg) {
    s.running = false;
    s.cur = null;
    s.streamed = null;
    for (const c of s.chips.values()) {
      if (!c.done) {
        c.done = true;
        c.state.className = 'chip-state';
        c.state.textContent = '·';
      }
    }
    const secs = (msg.duration_ms / 1000).toFixed(1) + 's';
    if (s.retry) {
      if (s.retry.isConnected) s.retry.remove();
      s.retry = null;
    }
    if (msg.is_error || msg.subtype !== 'success') {
      let detail = (msg.errors || []).map(stripAnsi).join('; ');
      // a "success" that is_error carries the API's error text in `result`
      if (!detail && msg.subtype === 'success' && typeof msg.result === 'string') detail = stripAnsi(msg.result);
      const head = msg.subtype === 'success' ? 'error' : errorLabel(msg.subtype);
      addNote(s, head + (detail ? ' — ' + detail : ''), 'err');
    }
    addBlock(s, el('div', 'foot', secs)); // costs deliberately not shown
    if (s.id !== activeId) s.unread = true;
    renderTabs();
    updateChrome();
  }

  /* ------------------------------------------------------------------ */
  /* gel prompt cards                                                   */
  /* ------------------------------------------------------------------ */

  function gel(label, cls) {
    const b = el('button', 'key gel' + (cls ? ' ' + cls : ''), label);
    return withSel(b);
  }

  function focusables(card) {
    return Array.from(card.querySelectorAll('button:not(:disabled), [tabindex], input')).filter(
      (n) => n.offsetParent !== null && !n.hidden
    );
  }

  function cardKeys(card, onEscape) {
    card.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      const list = focusables(card);
      const i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        (list[(i + 1) % list.length] || list[0]).focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        (list[(i - 1 + list.length) % list.length] || list[0]).focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onEscape();
      }
    });
  }

  function finishAsk(s, ask, card, result, label, ok) {
    if (card.classList.contains('done')) return;
    vscode.postMessage({ type: 'answer', id: s.id, toolUseID: ask.toolUseID, result });
    card.classList.add('done');
    card.classList.remove('denying');
    card.appendChild(el('div', 'ask-done ' + (ok ? 'ok' : 'no'), (ok ? '✓ ' : '✗ ') + label));
    s.asks.delete(ask.toolUseID);
    s.needs = Math.max(0, s.needs - 1);
    renderTabs();
    updateChrome();
    if (s.needs === 0 && s.id === activeId) inputEl.focus();
  }

  function onAsk(ask) {
    const s = sessions.find((x) => x.id === ask.id);
    if (!s) return;
    const card = el('div', 'ask fresh');
    card.dataset.tuid = ask.toolUseID;
    if (ask.tool === 'AskUserQuestion') buildQuestion(s, ask, card);
    else if (ask.tool === 'ExitPlanMode') buildPlan(s, ask, card);
    else buildPermission(s, ask, card);
    s.asks.set(ask.toolUseID, card);
    s.needs++;
    addBlock(s, card);
    scrollDown(s, true);
    renderTabs();
    updateChrome();
    if (s.id === activeId) {
      const first = card.querySelector('.gel.mint, .tile, .gel');
      if (first) first.focus();
    }
  }

  function onAskCancelled(id, toolUseID) {
    const s = sessions.find((x) => x.id === id);
    const card = s && s.asks.get(toolUseID);
    if (!card) return;
    card.classList.add('done');
    card.appendChild(el('div', 'ask-done', '— cancelled'));
    s.asks.delete(toolUseID);
    s.needs = Math.max(0, s.needs - 1);
    renderTabs();
    updateChrome();
  }

  // the process is gone: nothing is listening to its open prompt cards any more
  function cancelAsks(s) {
    for (const t of Array.from(s.asks.keys())) onAskCancelled(s.id, t);
  }

  function askHeader(card, ask, titleText) {
    const title = el('div', 'ask-title');
    title.appendChild(document.createTextNode(titleText));
    title.appendChild(el('span', 'tool-tag', ask.displayName || ask.tool));
    card.appendChild(title);
    if (ask.description) card.appendChild(el('div', 'ask-desc', ask.description));
  }

  function buildPermission(s, ask, card) {
    const input = ask.input || {};
    const p = PATH_KEYS.map((k) => input[k]).find(Boolean);
    askHeader(card, ask, ask.title || 'Claude wants to use ' + (ask.displayName || ask.tool));

    if (ask.tool === 'Bash') {
      card.appendChild(el('div', 'well', input.command || ''));
    } else if (ask.tool === 'Edit') {
      if (p) card.appendChild(el('div', 'ask-desc', relPath(p)));
      card.appendChild(diffNode(input.old_string, input.new_string));
    } else if (ask.tool === 'MultiEdit') {
      if (p) card.appendChild(el('div', 'ask-desc', relPath(p)));
      for (const e of input.edits || []) card.appendChild(diffNode(e.old_string, e.new_string));
    } else if (ask.tool === 'Write') {
      if (p) card.appendChild(el('div', 'ask-desc', relPath(p)));
      card.appendChild(el('div', 'well', truncate(input.content || '', 2400)));
    } else if (Object.keys(input).length) {
      card.appendChild(el('div', 'well', truncate(JSON.stringify(input, null, 2), 2400)));
    }
    if (ask.decisionReason) card.appendChild(el('div', 'ask-why', ask.decisionReason));

    const keys = el('div', 'ask-keys');
    const allow = gel('allow', 'mint');
    allow.addEventListener('click', () => finishAsk(s, ask, card, { behavior: 'allow' }, 'allowed', true));
    keys.appendChild(allow);

    if (ask.suggestions && ask.suggestions.length) {
      const forSession = gel('allow for session');
      forSession.addEventListener('click', () =>
        finishAsk(
          s,
          ask,
          card,
          { behavior: 'allow', updatedPermissions: ask.suggestions.map((u) => ({ ...u, destination: 'session' })) },
          'allowed for this session',
          true
        )
      );
      keys.appendChild(forSession);
      const always = gel('always allow');
      always.title = 'Saves a permission rule to this project';
      always.addEventListener('click', () =>
        finishAsk(s, ask, card, { behavior: 'allow', updatedPermissions: ask.suggestions }, 'always allowed', true)
      );
      keys.appendChild(always);
    }

    keys.appendChild(el('span', 'spacer'));
    const deny = gel('deny', 'red');
    deny.addEventListener('click', () => {
      card.classList.add('denying');
      reason.focus();
    });
    keys.appendChild(deny);
    card.appendChild(keys);

    const denyRow = el('div', 'ask-deny');
    const reason = el('input');
    reason.placeholder = 'tell claude why (optional)';
    denyRow.appendChild(reason);
    const denyGo = gel('deny', 'red');
    const denyStop = gel('deny & stop', 'red');
    const back = gel('back');
    const doDeny = (interrupt) =>
      finishAsk(
        s,
        ask,
        card,
        { behavior: 'deny', message: reason.value.trim() || 'The user declined this action.', interrupt },
        interrupt ? 'denied, turn stopped' : 'denied',
        false
      );
    denyGo.addEventListener('click', () => doDeny(false));
    denyStop.addEventListener('click', () => doDeny(true));
    back.addEventListener('click', () => {
      card.classList.remove('denying');
      allow.focus();
    });
    reason.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doDeny(false);
      }
    });
    denyRow.appendChild(denyGo);
    denyRow.appendChild(denyStop);
    denyRow.appendChild(back);
    card.appendChild(denyRow);

    cardKeys(card, () => {
      if (card.classList.contains('denying')) doDeny(false);
      else {
        card.classList.add('denying');
        reason.focus();
      }
    });
  }

  function buildQuestion(s, ask, card) {
    // one question at a time, centered — a selection dialogue, not a form
    const questions = (ask.input && ask.input.questions) || [];
    const n = questions.length;
    const picks = questions.map(() => new Map()); // label -> value
    const otherText = questions.map(() => '');
    let qi = 0;

    card.classList.add('dialog');
    const title = el('div', 'ask-title', n > 1 ? 'Claude has a few questions' : 'Claude has a question');
    card.appendChild(title);

    const dots = el('div', 'dots');
    card.appendChild(dots);

    const stage = el('div', 'qs');
    card.appendChild(stage);

    const nav = el('div', 'ask-keys q-nav');
    const back = gel('← back');
    const next = gel('next →', 'mint');
    const skip = gel('skip', 'red');
    nav.appendChild(back);
    nav.appendChild(next);
    nav.appendChild(skip);
    card.appendChild(nav);

    const answered = (i) => picks[i].size > 0;
    const last = () => qi === n - 1;

    function submit() {
      const answers = {};
      questions.forEach((q, i) => {
        const vals = Array.from(picks[i].values());
        answers[q.question] = q.multiSelect ? vals : vals[0];
      });
      finishAsk(
        s,
        ask,
        card,
        { behavior: 'allow', updatedInput: { questions, answers } },
        Object.values(answers)
          .map((v) => (Array.isArray(v) ? v.join(', ') : v))
          .join(' · '),
        true
      );
      dots.remove();
    }

    function refreshNav() {
      back.hidden = qi === 0;
      next.textContent = '';
      next.appendChild(document.createTextNode(last() ? 'answer' : 'next →'));
      next.appendChild(el('span', 'sel'));
      next.disabled = !answered(qi);
      dots.textContent = '';
      if (n > 1) {
        questions.forEach((_, i) => {
          dots.appendChild(el('span', 'dot' + (i === qi ? ' cur' : answered(i) ? ' done' : ''), ''));
        });
        dots.appendChild(el('span', 'dot-label', qi + 1 + ' of ' + n));
      }
    }

    function advance() {
      if (!answered(qi)) return;
      if (last()) submit();
      else showQ(qi + 1);
    }

    function showQ(i) {
      qi = i;
      const q = questions[qi];
      const m = picks[qi];
      stage.textContent = '';
      const box = el('div', 'q');
      if (q.header) box.appendChild(el('div', 'q-head', q.header));
      box.appendChild(el('div', 'q-text', q.question || ''));
      if (q.multiSelect) box.appendChild(el('div', 'q-hint', 'pick any that apply'));
      const tiles = el('div', 'tiles');
      const tileEls = [];
      const paint = () => {
        for (const t of tileEls) t.el.classList.toggle('on', m.has(t.label));
        refreshNav();
      };

      for (const opt of q.options || []) {
        const t = withSel(el('button', 'key tile'));
        t.appendChild(el('span', 't-label', opt.label));
        if (opt.description) t.appendChild(el('span', 't-desc', opt.description));
        if (opt.preview) t.appendChild(el('div', 't-preview', String(opt.preview).slice(0, 1200)));
        t.addEventListener('click', () => {
          if (q.multiSelect) {
            if (m.has(opt.label)) m.delete(opt.label);
            else m.set(opt.label, opt.label);
            paint();
          } else {
            m.clear();
            m.set(opt.label, opt.label);
            paint();
            // a beat so the tile lights up before the dialogue moves on
            setTimeout(advance, 160);
          }
        });
        tiles.appendChild(t);
        tileEls.push({ el: t, label: opt.label });
      }

      // "other…": a div, not a button — an <input> inside a <button> is not
      // reliably editable in Chromium
      const other = withSel(el('div', 'key tile other'));
      other.tabIndex = 0;
      other.setAttribute('role', 'button');
      other.appendChild(el('span', 't-label', 'other…'));
      const otherIn = el('input');
      otherIn.placeholder = 'type your answer';
      otherIn.hidden = !otherText[qi];
      otherIn.value = otherText[qi];
      other.appendChild(otherIn);
      const reveal = () => {
        otherIn.hidden = false;
        otherIn.focus();
      };
      other.addEventListener('click', (e) => {
        if (e.target !== otherIn) reveal();
      });
      other.addEventListener('keydown', (e) => {
        if (e.target === other && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          reveal();
        }
      });
      otherIn.addEventListener('input', () => {
        otherText[qi] = otherIn.value.trim();
        if (!q.multiSelect) m.clear();
        m.delete('__other');
        if (otherText[qi]) m.set('__other', otherText[qi]);
        paint();
      });
      otherIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          advance();
        }
      });
      tileEls.push({ el: other, label: '__other' });
      tiles.appendChild(other);

      box.appendChild(tiles);
      stage.appendChild(box);
      paint();
      const first = tileEls.find((t) => t.el.classList.contains('on')) || tileEls[0];
      if (first && s.id === activeId) first.el.focus();
      scrollDown(s, true);
    }

    back.addEventListener('click', () => {
      if (qi > 0) showQ(qi - 1);
    });
    next.addEventListener('click', advance);
    skip.addEventListener('click', () =>
      finishAsk(s, ask, card, { behavior: 'deny', message: 'The user skipped the question. Use your best judgment.' }, 'skipped', false)
    );

    cardKeys(card, () => skip.click());
    showQ(0);
  }

  function buildPlan(s, ask, card) {
    askHeader(card, ask, 'Plan ready');
    card.appendChild(el('div', 'ask-desc', 'Review the plan above, then choose how to continue.'));
    const keys = el('div', 'ask-keys');

    const approveAll = gel('approve & build', 'mint');
    approveAll.title = 'Approve and auto-accept file edits';
    approveAll.addEventListener('click', () => {
      finishAsk(s, ask, card, { behavior: 'allow' }, 'approved · edits auto-accepted', true);
      setMode(s, 'acceptEdits');
    });
    keys.appendChild(approveAll);

    const approveAsk = gel('approve, ask before edits');
    approveAsk.addEventListener('click', () => {
      finishAsk(s, ask, card, { behavior: 'allow' }, 'approved', true);
      setMode(s, 'default');
    });
    keys.appendChild(approveAsk);

    keys.appendChild(el('span', 'spacer'));
    const keep = gel('keep planning', 'red');
    keep.addEventListener('click', () =>
      finishAsk(
        s,
        ask,
        card,
        { behavior: 'deny', message: 'The user wants to keep planning. Ask what they would like changed.' },
        'kept planning',
        false
      )
    );
    keys.appendChild(keep);
    card.appendChild(keys);
    cardKeys(card, () => keep.click());
  }

  /* ------------------------------------------------------------------ */
  /* composer                                                           */
  /* ------------------------------------------------------------------ */

  // The browser sizes the box itself where `field-sizing: content` exists
  // (Chromium 123+, i.e. every VS Code this extension supports). The JS
  // measurement is only a fallback — and it must never run while the deck
  // is hidden: scrollHeight is 0 there, which used to pin the box to 0px so
  // the placeholder peeked out of a slit until the next keystroke.
  const nativeSizing =
    typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');
  function autosize() {
    if (!inputEl.value) inputEl.scrollTop = 0;
    if (nativeSizing) return;
    if (!inputEl.offsetParent) return;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(150, inputEl.scrollHeight) + 'px';
  }

  function send() {
    const s = active();
    if (!s || !s.alive || s.needs > 0) return;
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    s.draft = '';
    autosize();
    hidePop();

    const modelCmd = text.match(/^\/model(?:\s+(\S+))?\s*$/);
    if (modelCmd) {
      // bare /model opens the picker (the CLI's own menu is a TUI)
      if (modelCmd[1]) setModel(s, modelCmd[1]);
      else setTimeout(modelPop, 0); // after this Enter finishes bubbling, or it would pick an item at once
      return;
    }
    if (/^\/clear\s*$/.test(text)) {
      clearTranscript(s);
      Stats.reset(s.stats);
    }
    addYou(s, text);
    s.lastSent = text;
    s.running = true;
    Stats.begin(s.stats);
    statsChanged(s, 'full');
    vscode.postMessage({ type: 'send', id: s.id, text });
    scrollDown(s, true);
    renderTabs();
    updateChrome();
  }

  function setMode(s, mode) {
    s.mode = mode;
    vscode.postMessage({ type: 'setMode', id: s.id, mode });
    updateChrome();
  }

  function setModel(s, model) {
    const from = s.model;
    if (from === model) return;
    s.model = model;
    vscode.postMessage({ type: 'setModel', id: s.id, model });
    modelSwitch(s, from, model);
    updateChrome();
  }

  /* ---- popover (slash commands / models) ---- */

  let pop = null; // { items:[{name,desc,apply}], cur }

  function showPop(items, anchorInput, title, cur) {
    if (!items.length) return hidePop();
    pop = { items, cur: cur || 0, anchorInput, title };
    popEl.classList.toggle('center', !anchorInput);
    renderPop();
  }

  function renderPop() {
    popEl.textContent = '';
    if (!pop) return;
    if (pop.title) popEl.appendChild(el('div', 'pop-title', pop.title));
    pop.items.slice(0, 40).forEach((it, i) => {
      const b = el('button', 'key pop-item' + (i === pop.cur ? ' cur' : '') + (it.now ? ' now' : ''));
      b.appendChild(el('span', 'name', it.name));
      if (it.desc) b.appendChild(el('span', 'desc', it.desc));
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        it.apply();
        hidePop();
      });
      popEl.appendChild(b);
    });
    popEl.hidden = false;
    const cur = popEl.querySelectorAll('.pop-item')[pop.cur]; // not children[]: the model picker has a title row
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function hidePop() {
    pop = null;
    popEl.hidden = true;
    popEl.textContent = '';
  }

  function slashPop() {
    const s = active();
    const v = inputEl.value;
    const m = v.match(/^\/([\w:-]*)$/);
    if (!s || !m) return hidePop();
    const prefix = m[1].toLowerCase();
    const items = s.commands
      .filter((c) => c.name.toLowerCase().startsWith(prefix))
      .slice(0, 40)
      .map((c) => ({
        name: '/' + c.name,
        desc: c.description + (c.argumentHint ? (c.description ? '  ' : '') + c.argumentHint : ''),
        hint: c.argumentHint,
        apply: () => {
          inputEl.value = '/' + c.name + ' ';
          autosize();
          inputEl.focus();
        }
      }));
    showPop(items, true);
  }

  function modelPop() {
    const s = active();
    if (!s) return;
    if (pop && !pop.anchorInput) return hidePop();
    const current = shortModel(s.model);
    const items = (s.models.length ? s.models : [{ value: 'opus', displayName: 'opus', description: '' }]).map((m) => ({
      name: m.displayName || m.value,
      desc: m.description,
      now: shortModel(m.value) === current || shortModel(m.displayName) === current,
      apply: () => setModel(s, m.value)
    }));
    const curIdx = Math.max(0, items.findIndex((it) => it.now));
    showPop(items, false, 'model', curIdx);
  }

  inputEl.addEventListener('input', () => {
    autosize();
    slashPop();
  });
  inputEl.addEventListener('keydown', (e) => {
    if (pop && pop.anchorInput) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        pop.cur = (pop.cur + (e.key === 'ArrowDown' ? 1 : pop.items.length - 1)) % pop.items.length;
        renderPop();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        pop.items[pop.cur].apply();
        hidePop();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const it = pop.items[pop.cur];
        const typed = inputEl.value.trim();
        it.apply();
        hidePop();
        // Enter runs the command when it is already fully typed or takes no
        // arguments; otherwise it just completes and waits for the args.
        if (typed.toLowerCase() === it.name.toLowerCase() || !it.hint) send();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hidePop();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener('blur', () => {
    if (pop && pop.anchorInput) setTimeout(hidePop, 120);
  });
  sendBtn.addEventListener('click', send);

  /* ---- drag & drop / paste of files into the composer ---- */

  function insertAtCursor(text) {
    const a = inputEl.selectionStart || 0;
    const b = inputEl.selectionEnd || 0;
    const v = inputEl.value;
    const pad = a > 0 && !/\s$/.test(v.slice(0, a)) ? ' ' : '';
    inputEl.value = v.slice(0, a) + pad + text + ' ' + v.slice(b);
    const pos = a + pad.length + text.length + 1;
    inputEl.setSelectionRange(pos, pos);
    autosize();
    inputEl.focus();
    const s = active();
    if (s) s.draft = inputEl.value;
  }

  function quoteIfNeeded(p) {
    return /\s/.test(p) ? '"' + p.replace(/"/g, '\\"') + '"' : p;
  }

  function takeDrop(dt) {
    const s = active();
    if (!dt || !s) return;
    const uriList = dt.getData('text/uri-list') || '';
    const paths = uriList
      .split(/\r?\n/)
      .filter((u) => u && !u.startsWith('#') && u.startsWith('file:'))
      .map(StarBit.fileUriPath)
      .filter(Boolean);
    if (paths.length) return insertAtCursor(paths.map(quoteIfNeeded).join(' '));
    const files = Array.from(dt.files || []);
    if (files.length) {
      for (const f of files) {
        const reader = new FileReader();
        reader.onload = () => {
          const b64 = String(reader.result).split(',')[1] || '';
          vscode.postMessage({ type: 'dropFile', id: s.id, name: f.name || 'pasted.png', data: b64 });
        };
        reader.readAsDataURL(f);
      }
      return;
    }
    const text = dt.getData('text/plain');
    if (text) insertAtCursor(text);
  }

  for (const zone of [composerEl, stageEl]) {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      composerEl.classList.add('dropping');
    });
    zone.addEventListener('dragleave', () => composerEl.classList.remove('dropping'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      composerEl.classList.remove('dropping');
      takeDrop(e.dataTransfer);
    });
  }
  inputEl.addEventListener('paste', (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (!files.length) return;
    e.preventDefault();
    takeDrop(e.clipboardData);
  });

  /* ------------------------------------------------------------------ */
  /* toolbar                                                            */
  /* ------------------------------------------------------------------ */

  modeBtn.addEventListener('click', () => {
    const s = active();
    if (!s) return;
    const i = MODES.findIndex((m) => m[0] === s.mode);
    setMode(s, MODES[(i + 1) % MODES.length][0]);
  });

  modelBtn.addEventListener('click', modelPop);

  homeBtn.addEventListener('click', () => {
    const s = active();
    if (s) goHome(s);
  });

  stopBtn.addEventListener('click', () => {
    const s = active();
    if (!s) return;
    vscode.postMessage({ type: 'interrupt', id: s.id });
  });

  function applyTheme(mode) {
    if (mode !== 'dark' && mode !== 'light') return;
    themeMode = mode;
    document.body.dataset.theme = mode;
    termRail.setTheme(mode);
  }
  themeBtn.addEventListener('click', () => {
    applyTheme(themeMode === 'dark' ? 'light' : 'dark');
    vscode.postMessage({ type: 'setTheme', theme: themeMode });
  });

  document.addEventListener('mousedown', (e) => {
    if (pop && !popEl.contains(e.target) && e.target !== modelBtn) hidePop();
  });

  // keyboard for the centered (non-composer) popover
  document.addEventListener('keydown', (e) => {
    if (!pop || pop.anchorInput) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      pop.cur = (pop.cur + (e.key === 'ArrowDown' ? 1 : pop.items.length - 1)) % pop.items.length;
      renderPop();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pop.items[pop.cur].apply();
      hidePop();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hidePop();
    }
  });

  // Empty the transcript (and forget what pointed into it).
  function clearTranscript(s) {
    s.transcript.textContent = '';
    s.chips.clear();
    s.compact = null;
    s.retry = null;
  }

  // End this socket's process and start a fresh one in its place — either
  // resuming an old chat (resumeId) or going back to the HOME screen.
  function resetSession(s, resumeId) {
    vscode.postMessage({ type: 'kill', id: s.id });
    clearTranscript(s);
    s.asks.clear();
    s.needs = 0;
    s.running = false;
    s.cur = null;
    s.streamed = null;
    s.unread = false;
    s.ctxPct = null;
    s.lastSent = null;
    s.sessionId = null;
    s.lastSwitch = null;
    // the fresh process starts on the configured model and mode
    s.model = boot.model;
    s.mode = boot.defaultMode;
    s.resumeId = resumeId || null;
    s.alive = true;
    s.ready = false;
    Stats.reset(s.stats, true); // a fresh process starts its own running totals
    statsChanged(s, 'full');
    s.empty.className = 'blank';
    s.empty.textContent = '';
    s.empty.appendChild(el('span', 'star', '✦'));
    s.empty.appendChild(document.createTextNode(resumeId ? 'resuming session…' : 'starting claude…'));
    vscode.postMessage({ type: 'create', id: s.id, resume: resumeId || undefined });
    renderTabs();
    updateChrome();
  }

  function goHome(s) {
    if (s.transcript.childElementCount === 0) return; // already home
    resetSession(s, null);
  }

  /* ------------------------------------------------------------------ */
  /* side rails: session stats (left) + a terminal (right)              */
  /* ------------------------------------------------------------------ */

  // The terminal rail comes in as soon as there is room for it beside a
  // readable transcript; the stats rail joins it only when the panel is
  // really wide (maximized). Both sit outside the transcript's scroller,
  // so they stay put while the transcript streams or is scrolled.
  const CHAT_MIN = 480; // narrowest transcript column the rails leave
  const TERM_MIN = 340; // narrowest terminal rail (~40 columns)
  const TERM_MAX = 960;
  const TERM_SHARE = 0.4; // default terminal width, as a share of the tray
  const WIDE_MIN = 1180; // tray content width that also brings in the stats rail
  const RAIL_MIN = 190;
  const RAIL_MAX = 290;
  const READING = 760; // transcript width the stats rail leaves before it grows
  const GAP = 10; // grid column gap

  const STRIP = 34; // a collapsed rail: a slim strip at the tray's edge

  // Each rail can be collapsed on its own (saved in globalState): the key at
  // its top-right folds it into a strip; clicking the strip unfolds it. The
  // terminal's width is dragged at its left edge (double-click resets it).
  const collapsed = { stats: false, term: false };
  let termWant = 0; // the width the user dragged the terminal to (0 = TERM_SHARE)
  let railPx = RAIL_MIN;
  let termPx = TERM_MIN;

  const CHEVRON = {
    left: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    right: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  // a rail = collapse key + scrolling body + the strip shown when collapsed
  function railChrome(aside, key, label, edge) {
    const toggle = el('button', 'key rail-toggle');
    toggle.innerHTML = CHEVRON[edge];
    toggle.title = 'Hide ' + label;
    toggle.setAttribute('aria-label', 'Hide ' + label);
    const body = el('div', 'rail-body');
    const strip = el('button', 'rail-strip');
    strip.title = 'Show ' + label;
    strip.setAttribute('aria-label', 'Show ' + label);
    const chev = el('span', 'rail-strip-chev');
    chev.innerHTML = CHEVRON[edge === 'left' ? 'right' : 'left'];
    strip.appendChild(chev);
    strip.appendChild(el('span', 'rail-strip-label', label));
    aside.appendChild(toggle);
    aside.appendChild(body);
    aside.appendChild(strip);
    toggle.addEventListener('click', () => setCollapsed(key, true));
    strip.addEventListener('click', () => setCollapsed(key, false));
    return { aside, toggle, body, strip };
  }

  const statsParts = railChrome(statsRail, 'stats', 'session stats', 'left');
  const termParts = railChrome(termRailEl, 'term', 'terminal', 'right');
  const statsBody = statsParts.body;

  const termRail = TermRail.mount(termParts.body, {
    theme: themeMode,
    onFocus: (on) => termRailEl.classList.toggle('focused', on)
  });

  function statsShown() {
    return wide && StarBit.deck === 'claude' && !document.hidden;
  }

  function saveRails() {
    vscode.postMessage({ type: 'rails', stats: collapsed.stats, term: collapsed.term, termPx: termWant });
  }

  function applyRails() {
    statsRail.classList.toggle('collapsed', collapsed.stats);
    termRailEl.classList.toggle('collapsed', collapsed.term);
    trayEl.style.setProperty('--rail-l', (collapsed.stats ? STRIP : railPx) + 'px');
    trayEl.style.setProperty('--rail-r', (collapsed.term ? STRIP : termPx) + 'px');
    termRail.setVisible(railed && !collapsed.term && StarBit.deck === 'claude');
  }

  function setCollapsed(key, on) {
    if (collapsed[key] === on) return;
    collapsed[key] = on;
    layoutRails(); // the other rail may now fit (or no longer fit)
    if (key === 'stats' && !on) renderStats();
    saveRails();
    // keep keyboard focus on the control that undoes this (an unfolded terminal takes it itself)
    if (key === 'term' && !on) return termRail.focus();
    const parts = key === 'stats' ? statsParts : termParts;
    (on ? parts.strip : parts.toggle).focus({ preventScroll: true });
  }

  function layoutRails() {
    const w = trayEl.clientWidth - 20; // minus the tray padding
    const nextRailed = railsBooted && sidePanels && w >= CHAT_MIN + GAP + TERM_MIN;
    let nextWide = false;
    if (nextRailed) {
      termPx = Math.round(Math.max(TERM_MIN, Math.min(TERM_MAX, w - CHAT_MIN - GAP, termWant || w * TERM_SHARE)));
      const termCol = collapsed.term ? STRIP : termPx;
      const left = w - termCol - CHAT_MIN - 2 * GAP; // what the stats rail could have
      nextWide = w >= WIDE_MIN && left >= (collapsed.stats ? STRIP : RAIL_MIN);
      if (nextWide) railPx = Math.round(Math.max(RAIL_MIN, Math.min(RAIL_MAX, left, w - termCol - 2 * GAP - READING)));
    }
    if (nextRailed !== railed) {
      railed = nextRailed;
      trayEl.classList.toggle('railed', railed);
      termRailEl.hidden = !railed;
    }
    if (nextWide !== wide) {
      wide = nextWide;
      trayEl.classList.toggle('wide', wide);
      statsRail.hidden = !wide;
      if (wide) renderStats();
    }
    applyRails();
  }

  if (typeof ResizeObserver === 'function') new ResizeObserver(layoutRails).observe(trayEl);

  // drag the terminal's left edge to resize it; double-click for the default width
  const grip = el('div', 'rail-grip');
  grip.title = 'Drag to resize · double-click to reset';
  termRailEl.appendChild(grip);
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    trayEl.classList.add('resizing');
    const right = trayEl.getBoundingClientRect().right - (parseFloat(getComputedStyle(trayEl).paddingRight) || 0);
    let moved = false;
    const move = (ev) => {
      moved = true;
      termWant = Math.round(right - ev.clientX);
      layoutRails();
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      trayEl.classList.remove('resizing');
      if (!moved) return; // a plain click keeps the default width
      termWant = termPx; // keep what it settled at, not where the pointer overshot
      saveRails();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', () => {
    termWant = 0;
    layoutRails();
    saveRails();
  });

  function renderStats() {
    if (!wide || collapsed.stats) return;
    const s = active();
    if (!s) return;
    Stats.render(statsBody, s.stats, {
      title: 'socket ' + s.label,
      resumed: !!s.resumeId,
      modelName: (id) => modelLabel(s, id)
    });
  }

  let statsFrame = 0;
  function statsChanged(s, kind) {
    if (!wide || collapsed.stats || s.id !== activeId) return;
    if (kind === 'live') {
      Stats.tick(statsBody, s.stats);
      return;
    }
    // coalesce bursts (a tool-heavy assistant message, result + context)
    if (statsFrame) return;
    statsFrame = requestAnimationFrame(() => {
      statsFrame = 0;
      renderStats();
    });
  }

  // the "working 14s" line counts up while a turn runs
  setInterval(() => {
    const s = active();
    if (s && s.stats.live && statsShown() && !collapsed.stats) Stats.tick(statsBody, s.stats);
  }, 1000);

  /* ------------------------------------------------------------------ */
  /* messages from the extension                                        */
  /* ------------------------------------------------------------------ */

  StarBit.on('claude', (msg) => {
    const s = msg.id ? sessions.find((x) => x.id === msg.id) : undefined;

    switch (msg.type) {
      case 'boot':
        boot = msg;
        applyTheme(msg.theme);
        sidePanels = msg.sidePanels !== false;
        if (msg.rails) {
          collapsed.stats = msg.rails.stats === true;
          collapsed.term = msg.rails.term === true;
          termWant = Number(msg.rails.termPx) > 0 ? Math.round(msg.rails.termPx) : 0;
        }
        railsBooted = true;
        layoutRails();
        if (sessions.length === 0) createSession();
        break;
      case 'sdk':
        if (s) handleSdk(s, msg.msg);
        break;
      case 'sessionInfo':
        if (s) {
          s.commands = msg.commands && msg.commands.length ? msg.commands : s.commands;
          s.models = msg.models && msg.models.length ? msg.models : s.models;
          if (msg.mode) s.mode = msg.mode;
          markReady(s);
        }
        break;
      case 'ask':
        onAsk(msg.ask);
        break;
      case 'askCancelled':
        onAskCancelled(msg.id, msg.toolUseID);
        break;
      case 'history':
        if (s) {
          const items = msg.items || [];
          s.replaying = true;
          try {
            for (const item of items) handleSdk(s, item);
          } finally {
            s.replaying = false;
          }
          if (items.length) {
            const turns = items.filter(
              (it) =>
                it.type === 'user' &&
                typeof it.message.content === 'string' &&
                !it.isCompactSummary &&
                !/^This session is being continued from a previous conversation/.test(it.message.content)
            ).length;
            addNote(s, 'resumed' + (turns ? ' · ' + turns + (turns === 1 ? ' turn' : ' turns') : ''), 'rule');
          }
          scrollDown(s, true);
          renderTabs();
          updateChrome();
        }
        break;
      case 'dropped':
        if (s && s.id === activeId) insertAtCursor(quoteIfNeeded(msg.path));
        else if (s) s.draft = (s.draft ? s.draft + ' ' : '') + quoteIfNeeded(msg.path) + ' ';
        break;
      case 'resumable':
        boot.resumable = msg.items || [];
        for (const x of sessions) {
          if (x.ready && x.transcript.childElementCount === 0) renderHome(x);
        }
        break;
      case 'context':
        if (s) {
          s.ctxPct = msg.pct;
          Stats.onContext(s.stats, msg.pct, msg.total, msg.max);
          statsChanged(s, 'full');
          updateChrome();
        }
        break;
      case 'sessionError':
        if (s) addNote(s, msg.message, 'err');
        break;
      case 'spawnError':
        if (s) {
          s.alive = false;
          s.running = false;
          cancelAsks(s);
          addBlock(s, el('div', 'note mono err', msg.message));
          renderTabs();
          updateChrome();
        }
        break;
      case 'sessionEnded':
        if (s && s.alive) {
          s.alive = false;
          s.running = false;
          cancelAsks(s);
          addNote(s, '— session ended —', 'rule');
          renderTabs();
          updateChrome();
        }
        break;
      case 'stderr':
        console.log('[claude stderr]', msg.data);
        break;
      case 'setTheme':
        applyTheme(msg.theme);
        break;
      case 'sidePanels':
        sidePanels = msg.on !== false;
        layoutRails();
        break;
      case 'newSession':
        createSession();
        break;
      case 'stopSession': {
        const a = active();
        if (a) vscode.postMessage({ type: 'interrupt', id: a.id });
        break;
      }
      default:
        break;
    }
  });

  /* ------------------------------------------------------------------ */
  /* boot                                                               */
  /* ------------------------------------------------------------------ */

  window.addEventListener('starbit:deck', (e) => {
    layoutRails();
    if (e.detail !== 'claude') return;
    // first real layout since the deck was hidden: size the box, keep the bottom
    autosize();
    const s = active();
    if (s) scrollDown(s);
    inputEl.focus();
  });

  vscode.postMessage({ type: 'ready' });
})();

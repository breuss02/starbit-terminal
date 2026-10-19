/* StarBit Claude — the session-stats rail (left side, wide panels only).

   The numbers come from the SDK's `result.modelUsage`, which is a running
   total for the whole query() (main loop, subagents, compaction) that the
   CLI resets on /clear and a resume starts afresh. We keep our own tally of
   the per-turn deltas so a CLI reset never makes the counter go backwards.
   Everything else (tools, live turn) is counted from the message stream.

   window.StarbitStats = { create, reset, begin, onSdk, onContext, render, tick } */
(function () {
  const KINDS = [
    // order = stacking order = categorical slot order (validated palette)
    { key: 'cr', label: 'cache read', slot: 1 },
    { key: 'cw', label: 'cache write', slot: 2 },
    { key: 'in', label: 'input', slot: 3 },
    { key: 'out', label: 'output', slot: 4 }
  ];
  const MAX_TURNS = 200;
  const TOP_TOOLS = 5;

  function zero() {
    return { cr: 0, cw: 0, in: 0, out: 0, total: 0 };
  }

  function create() {
    return {
      acc: zero(), // our tally since this socket started (or /clear)
      models: {}, // model id -> tally
      prev: zero(), // last cumulative totals the CLI reported
      prevModels: {},
      turns: [], // { t: tally, ms, calls, err } — the last MAX_TURNS only
      turnNo: 0, // turns counted, including any that fell off `turns`
      tools: {}, // tool name -> count
      toolIds: new Set(),
      toolCount: 0,
      calls: 0,
      ms: 0,
      ctx: null, // { pct, total, max }
      live: null // { start, out, cur, calls, tools } while a turn runs
    };
  }

  /** /clear or a new chat in the socket: forget the tally but keep the CLI
      baseline, so a result that still carries the old totals adds nothing. */
  function reset(st, hard) {
    const keep = hard ? { prev: zero(), prevModels: {} } : { prev: st.prev, prevModels: st.prevModels };
    Object.assign(st, create(), keep);
  }

  function begin(st) {
    st.live = { start: Date.now(), out: 0, cur: 0, calls: 0, tools: 0 };
  }

  function tallyOf(u) {
    const t = {
      cr: Number(u.cacheReadInputTokens) || 0,
      cw: Number(u.cacheCreationInputTokens) || 0,
      in: Number(u.inputTokens) || 0,
      out: Number(u.outputTokens) || 0,
      total: 0
    };
    t.total = t.cr + t.cw + t.in + t.out;
    return t;
  }

  function add(a, b) {
    a.cr += b.cr;
    a.cw += b.cw;
    a.in += b.in;
    a.out += b.out;
    a.total += b.total;
  }

  function minus(a, b) {
    const d = zero();
    for (const k of ['cr', 'cw', 'in', 'out']) d[k] = Math.max(0, a[k] - b[k]);
    d.total = d.cr + d.cw + d.in + d.out;
    return d;
  }

  function onResult(st, msg) {
    const mu = msg.modelUsage && typeof msg.modelUsage === 'object' ? msg.modelUsage : {};
    const cum = zero();
    const cumModels = {};
    for (const id of Object.keys(mu)) {
      const t = tallyOf(mu[id] || {});
      cumModels[id] = t;
      add(cum, t);
    }
    // crash / startup-error results carry zeroed usage: nothing to learn
    if (cum.total === 0) {
      st.live = null;
      return;
    }
    const wasReset = cum.total < st.prev.total;
    const delta = zero();
    for (const id of Object.keys(cumModels)) {
      const before = wasReset ? zero() : st.prevModels[id] || zero();
      const d = minus(cumModels[id], before);
      if (!st.models[id]) st.models[id] = zero();
      add(st.models[id], d);
      add(delta, d);
    }
    st.prev = cum;
    st.prevModels = cumModels;
    st.live = null;
    if (delta.total === 0) return; // a local command that made no model call
    add(st.acc, delta);
    st.calls += Number(msg.num_turns) || 0;
    st.ms += Number(msg.duration_ms) || 0;
    st.turnNo++;
    st.turns.push({ t: delta, ms: Number(msg.duration_ms) || 0, calls: Number(msg.num_turns) || 0, err: !!msg.is_error });
    if (st.turns.length > MAX_TURNS) st.turns.shift();
  }

  /** Feed one SDK message. Returns 'full' when the rail should re-render,
      'live' when only the live row changed, or '' for nothing. */
  function onSdk(st, msg, replay) {
    if (!msg || replay) return '';
    if (msg.type === 'result') {
      onResult(st, msg);
      return 'full';
    }
    if (msg.type === 'assistant') {
      const content = (msg.message && msg.message.content) || [];
      let changed = false;
      for (const b of content) {
        if (b && b.type === 'tool_use' && b.id && !st.toolIds.has(b.id)) {
          st.toolIds.add(b.id);
          st.tools[b.name] = (st.tools[b.name] || 0) + 1;
          st.toolCount++;
          if (st.live) st.live.tools++;
          changed = true;
        }
      }
      return changed ? 'full' : '';
    }
    if (msg.type === 'stream_event' && !msg.parent_tool_use_id && st.live) {
      const ev = msg.event || {};
      if (ev.type === 'message_start') {
        st.live.out += st.live.cur;
        st.live.cur = 0;
        st.live.calls++;
        return 'live';
      }
      if (ev.type === 'message_delta' && ev.usage && typeof ev.usage.output_tokens === 'number') {
        st.live.cur = ev.usage.output_tokens;
        return 'live';
      }
    }
    return '';
  }

  function onContext(st, pct, total, max) {
    st.ctx = { pct: Number(pct) || 0, total: Number(total) || 0, max: Number(max) || 0 };
  }

  /* ---- formatting ---------------------------------------------------- */

  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'k';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }

  function fmtFull(n) {
    return Math.round(Number(n) || 0).toLocaleString('en-US');
  }

  function pct(part, whole) {
    if (!whole) return '0%';
    const p = (part / whole) * 100;
    if (p > 0 && p < 1) return '<1%';
    return Math.round(p) + '%';
  }

  function dur(ms) {
    const s = Math.round((Number(ms) || 0) / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
    return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }

  /* ---- rendering ----------------------------------------------------- */

  const SVG = 'http://www.w3.org/2000/svg';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function svg(tag, attrs) {
    const n = document.createElementNS(SVG, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function section(title, extra) {
    const sec = el('section', 'st-sec');
    const h = el('h4', 'st-h', title);
    if (extra) h.appendChild(el('span', 'st-h-aside', extra));
    sec.appendChild(h);
    return sec;
  }

  // a column: square at the baseline, 4px rounded data end
  function colPath(x, y, w, h) {
    const r = Math.min(4, w / 2, h);
    return (
      'M' + x + ',' + (y + h) +
      'V' + (y + r) +
      'Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
      'H' + (x + w - r) +
      'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) +
      'V' + (y + h) + 'Z'
    );
  }

  function liveText(st) {
    const L = st.live;
    if (!L) return '';
    const parts = ['working ' + dur(Date.now() - L.start)];
    const out = L.out + L.cur;
    if (out) parts.push(fmt(out) + ' out');
    if (L.tools) parts.push(L.tools + (L.tools === 1 ? ' tool' : ' tools'));
    return parts.join(' · ');
  }

  /** Update only the live row (called on a 1s tick and on stream deltas). */
  function tick(host, st) {
    const row = host.querySelector('.st-live');
    if (!row) return;
    const text = liveText(st);
    row.hidden = !text;
    const t = row.querySelector('.st-live-text');
    if (t && t.textContent !== text) t.textContent = text;
  }

  function heroSection(st, meta) {
    const sec = el('section', 'st-hero');
    sec.appendChild(el('div', 'st-hero-val', fmt(st.acc.total)));
    sec.appendChild(el('div', 'st-hero-cap', meta.resumed ? 'tokens since resume' : 'tokens this session'));
    const live = el('div', 'st-live');
    live.appendChild(el('span', 'st-live-dot'));
    live.appendChild(el('span', 'st-live-text', ''));
    sec.appendChild(live);
    return sec;
  }

  function breakdownSection(st) {
    const sec = section('breakdown');
    const total = st.acc.total;
    const bar = el('div', 'st-stack');
    bar.setAttribute('role', 'img');
    bar.setAttribute(
      'aria-label',
      'Token breakdown: ' + KINDS.map((k) => k.label + ' ' + fmtFull(st.acc[k.key])).join(', ')
    );
    if (!total) bar.classList.add('empty');
    for (const k of KINDS) {
      const v = st.acc[k.key];
      if (!total || !v) continue;
      const seg = el('span', 'st-seg s' + k.slot);
      // a floor keeps a sliver visible; the legend carries the true share
      seg.style.flexGrow = String(Math.max(v / total, 0.012));
      seg.title = k.label + ' · ' + fmtFull(v) + ' · ' + pct(v, total);
      bar.appendChild(seg);
    }
    sec.appendChild(bar);

    // the legend doubles as the table view: every value is written out
    const legend = el('ul', 'st-legend');
    for (const k of KINDS) {
      const li = el('li');
      li.appendChild(el('span', 'st-sw s' + k.slot));
      li.appendChild(el('span', 'st-lg-name', k.label));
      const val = el('span', 'st-lg-val', fmt(st.acc[k.key]));
      val.title = fmtFull(st.acc[k.key]) + ' tokens';
      li.appendChild(val);
      li.appendChild(el('span', 'st-lg-pct', pct(st.acc[k.key], total)));
      legend.appendChild(li);
    }
    sec.appendChild(legend);
    return sec;
  }

  function contextSection(st) {
    const c = st.ctx;
    const sec = section('context', c ? c.pct + '%' : '—');
    const meter = el('div', 'st-meter');
    const fill = el('span', 'st-meter-fill');
    const p = c ? Math.max(0, Math.min(100, c.pct)) : 0;
    fill.style.width = p + '%';
    const level = !c ? 'none' : p >= 90 ? 'hot' : p >= 70 ? 'warn' : 'ok';
    meter.dataset.level = level;
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    meter.setAttribute('aria-valuenow', String(p));
    meter.setAttribute('aria-label', 'Context window used');
    meter.appendChild(fill);
    sec.appendChild(meter);
    sec.appendChild(
      el(
        'div',
        'st-cap',
        c
          ? fmt(c.total) + ' of ' + fmt(c.max) + (level === 'hot' ? ' · compact soon' : level === 'warn' ? ' · filling up' : '')
          : 'fills in after the first turn'
      )
    );
    return sec;
  }

  function turnsSection(st, host) {
    const sec = section('tokens per turn');
    const turns = st.turns;
    if (!turns.length) {
      sec.appendChild(el('div', 'st-cap', 'one column per turn, newest on the right'));
      return sec;
    }
    const width = Math.max(120, (host.clientWidth || 220) - 28);
    const PLOT = 64;
    const TOP = 12; // room for the max label
    const AXIS = 14;
    const pitchMin = 7;
    const shown = turns.slice(-Math.max(4, Math.floor(width / pitchMin)));
    const first = st.turnNo - shown.length; // turn number before shown[0]
    const max = Math.max(...shown.map((t) => t.t.total), 1);
    const pitch = width / shown.length;
    const barW = Math.max(3, Math.min(24, pitch - 2)); // 2px surface gap between neighbours

    const wrap = el('div', 'st-cols');
    const chart = svg('svg', {
      width: String(width),
      height: String(TOP + PLOT + AXIS),
      viewBox: '0 0 ' + width + ' ' + (TOP + PLOT + AXIS),
      role: 'group',
      'aria-label': 'Tokens per turn, last ' + shown.length + ' turns, peak ' + fmtFull(max)
    });
    // peak gridline + label, then the baseline
    chart.appendChild(svg('line', { class: 'st-grid', x1: '0', x2: String(width), y1: String(TOP + 0.5), y2: String(TOP + 0.5) }));
    const peak = svg('text', { class: 'st-axis', x: '0', y: String(TOP - 3) });
    peak.textContent = fmt(max);
    chart.appendChild(peak);
    chart.appendChild(
      svg('line', { class: 'st-base', x1: '0', x2: String(width), y1: String(TOP + PLOT + 0.5), y2: String(TOP + PLOT + 0.5) })
    );

    const tip = el('div', 'st-tip');
    tip.hidden = true;

    shown.forEach((t, i) => {
      const h = Math.max(2, Math.round((t.t.total / max) * PLOT));
      const x = Math.round(i * pitch + (pitch - barW) / 2);
      const y = TOP + PLOT - h;
      const n = first + i + 1;
      const last = i === shown.length - 1;
      const g = svg('g', { class: 'st-col' + (last ? ' last' : '') + (t.err ? ' err' : ''), tabindex: '0' });
      g.setAttribute(
        'aria-label',
        'Turn ' + n + ': ' + fmtFull(t.t.total) + ' tokens, ' + fmtFull(t.t.out) + ' output, ' + dur(t.ms)
      );
      // hit target spans the whole slot and plot height
      g.appendChild(svg('rect', { class: 'st-hit', x: String(i * pitch), y: String(TOP), width: String(pitch), height: String(PLOT) }));
      g.appendChild(svg('path', { class: 'st-bar', d: colPath(x, y, barW, h) }));
      const show = () => {
        tip.textContent = '';
        tip.appendChild(el('b', '', 'turn ' + n));
        tip.appendChild(el('span', '', fmt(t.t.total) + ' tokens'));
        tip.appendChild(
          el('span', 'st-tip-sub', fmt(t.t.out) + ' out · ' + t.calls + (t.calls === 1 ? ' call' : ' calls') + ' · ' + dur(t.ms) + (t.err ? ' · error' : ''))
        );
        tip.hidden = false;
        const cx = x + barW / 2;
        const tw = tip.offsetWidth || 120;
        tip.style.left = Math.max(0, Math.min(width - tw, cx - tw / 2)) + 'px';
        tip.style.top = Math.max(0, y - (tip.offsetHeight || 44) - 6) + 'px';
      };
      const hide = () => {
        tip.hidden = true;
      };
      g.addEventListener('mouseenter', show);
      g.addEventListener('focus', show);
      g.addEventListener('mouseleave', hide);
      g.addEventListener('blur', hide);
      chart.appendChild(g);
    });
    // x-axis: first and last turn numbers
    const a0 = svg('text', { class: 'st-axis', x: '0', y: String(TOP + PLOT + AXIS - 2) });
    a0.textContent = 'turn ' + (first + 1);
    chart.appendChild(a0);
    if (shown.length > 1) {
      const a1 = svg('text', { class: 'st-axis end', x: String(width), y: String(TOP + PLOT + AXIS - 2) });
      a1.textContent = String(st.turnNo);
      chart.appendChild(a1);
    }
    wrap.appendChild(chart);
    wrap.appendChild(tip);
    sec.appendChild(wrap);
    return sec;
  }

  function tilesSection(st) {
    const sec = el('section', 'st-tiles');
    const tiles = [
      ['turns', String(st.turnNo)],
      ['api calls', String(st.calls)],
      ['tool uses', String(st.toolCount)],
      ['working', dur(st.ms)]
    ];
    for (const [label, value] of tiles) {
      const t = el('div', 'st-tile');
      t.appendChild(el('div', 'st-tile-val', value));
      t.appendChild(el('div', 'st-tile-label', label));
      sec.appendChild(t);
    }
    return sec;
  }

  function toolsSection(st) {
    const names = Object.keys(st.tools).sort((a, b) => st.tools[b] - st.tools[a] || a.localeCompare(b));
    const sec = section('tools', names.length ? String(st.toolCount) : '');
    if (!names.length) {
      sec.appendChild(el('div', 'st-cap', 'no tool calls yet'));
      return sec;
    }
    const rows = names.slice(0, TOP_TOOLS).map((n) => [n, st.tools[n]]);
    const rest = names.slice(TOP_TOOLS).reduce((sum, n) => sum + st.tools[n], 0);
    if (rest) rows.push(['other', rest]);
    const max = Math.max(...rows.map((r) => r[1]));
    const list = el('ul', 'st-bars');
    for (const [name, count] of rows) {
      const li = el('li');
      const nm = el('span', 'st-bar-name', name.replace(/^mcp__/, ''));
      nm.title = name;
      li.appendChild(nm);
      const track = el('span', 'st-bar-track');
      const fill = el('span', 'st-bar-fill');
      fill.style.width = Math.max(4, (count / max) * 100) + '%';
      track.appendChild(fill);
      li.appendChild(track);
      li.appendChild(el('span', 'st-bar-val', String(count)));
      list.appendChild(li);
    }
    sec.appendChild(list);
    return sec;
  }

  function modelsSection(st, meta) {
    const ids = Object.keys(st.models).filter((id) => st.models[id].total > 0);
    if (ids.length < 2) return null;
    ids.sort((a, b) => st.models[b].total - st.models[a].total);
    const sec = section('models');
    const list = el('ul', 'st-legend st-models');
    for (const id of ids) {
      const li = el('li');
      const nm = el('span', 'st-lg-name', meta.modelName ? meta.modelName(id) : id);
      nm.title = id;
      li.appendChild(nm);
      li.appendChild(el('span', 'st-lg-val', fmt(st.models[id].total)));
      li.appendChild(el('span', 'st-lg-pct', pct(st.models[id].total, st.acc.total)));
      list.appendChild(li);
    }
    sec.appendChild(list);
    return sec;
  }

  /** Rebuild the rail for one session's stats. meta: { title, resumed, modelName(id) } */
  function render(host, st, meta) {
    meta = meta || {};
    const body = el('div', 'st-body');
    const head = el('header', 'rail-head');
    head.appendChild(el('span', 'rail-star', '✦'));
    head.appendChild(el('span', 'rail-title', 'session stats'));
    if (meta.title) head.appendChild(el('span', 'rail-sub', meta.title));
    body.appendChild(head);
    body.appendChild(heroSection(st, meta));
    body.appendChild(breakdownSection(st));
    body.appendChild(contextSection(st));
    body.appendChild(tilesSection(st));
    body.appendChild(turnsSection(st, host));
    body.appendChild(toolsSection(st));
    const models = modelsSection(st, meta);
    if (models) body.appendChild(models);

    const keep = host.scrollTop;
    host.textContent = '';
    host.appendChild(body);
    host.scrollTop = keep;
    tick(host, st);
  }

  window.StarbitStats = { create, reset, begin, onSdk, onContext, render, tick };
})();

/* StarBitTerminal webview frontend — tabs, splits, cozy console energy */
(function () {
  const vscode = StarBit.client('term');
  const root = document.getElementById('deck-term');
  const $q = (cls) => root.querySelector('.' + cls);

  const tabsEl = $q('tabs');
  const trayEl = $q('tray');
  const statusText = $q('statusText');
  const splitBtn = $q('splitBtn');

  const fontFamily = document.body.dataset.fontFamily || 'monospace';
  const fontSize = parseFloat(document.body.dataset.fontSize || '13.5');

  const MAX_PANES_PER_TAB = 3;
  const MAX_TABS = 8;

  // Basic White — warm slate on cream pane cards.
  const themeLight = {
    background: 'rgba(0,0,0,0)',
    foreground: '#3d434c',
    cursor: '#f7941d',
    cursorAccent: '#fbfaf7',
    selectionBackground: 'rgba(62, 201, 143, 0.28)',
    black: '#454b54',
    red: '#c8524a',
    green: '#3d9257',
    yellow: '#a8821c',
    blue: '#2f7fc2',
    magenta: '#965bb0',
    cyan: '#1f8f9e',
    white: '#9aa2ab',
    brightBlack: '#6a727c',
    brightRed: '#dd6055',
    brightGreen: '#47a865',
    brightYellow: '#bd9526',
    brightBlue: '#3e93d9',
    brightMagenta: '#a86cc4',
    brightCyan: '#2aa7b6',
    brightWhite: '#4a515a'
  };

  // Basic Black — soft light text on charcoal cards, Switch-cyan selection.
  const themeDark = {
    background: 'rgba(0,0,0,0)',
    foreground: '#dde1e6',
    cursor: '#f7a41d',
    cursorAccent: '#2b2d31',
    selectionBackground: 'rgba(0, 195, 227, 0.30)',
    black: '#4b5058',
    red: '#e0655c',
    green: '#56c07a',
    yellow: '#d3ab3a',
    blue: '#58a6e8',
    magenta: '#b58ad6',
    cyan: '#4cc3d4',
    white: '#c9ced5',
    brightBlack: '#7d848d',
    brightRed: '#ec7a70',
    brightGreen: '#6bd18c',
    brightYellow: '#e3bd50',
    brightBlue: '#74b8f0',
    brightMagenta: '#c69ce2',
    brightCyan: '#63d2e2',
    brightWhite: '#f2f4f7'
  };

  const xtermThemeFor = (mode) => (mode === 'dark' ? themeDark : themeLight);
  let themeMode = document.body.dataset.theme === 'dark' ? 'dark' : 'light';

  /* ------------------------------------------------------------------ */
  /* state                                                              */
  /* ------------------------------------------------------------------ */

  let tabCounter = 0;
  let paneCounter = 0;
  const tabs = []; // { id, label, viewEl, panes: [pane] }
  const panesById = new Map(); // paneId -> pane
  let activeTabId = null;
  let focusedPaneId = null;
  let lastWakeTab = null;
  const pendingRuns = new Map(); // paneId -> () => void, run once its shell is up
  const BIT_MIME = 'application/x-starbit-bit'; // a command bit being dragged onto a pane

  /* ------------------------------------------------------------------ */
  /* links + drops                                                      */
  /* ------------------------------------------------------------------ */

  // path-ish tokens: optional ~ ./ ../ or /, dirs, a file with an extension,
  // optional :line(:col). Absolute directories count too.
  const PATH_RE =
    /(?:^|[\s"'`(\[<])((?:~|\.{1,2})?\/?(?:[\w@.+-]+\/)*[\w@.+-]+\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+(?::\d+)?)?|\/(?:[\w@.+-]+\/)+[\w@.+-]*)(?=$|[\s"'`)\]>:,;])/g;

  // cwd(): the pane's folder, so a relative path opens from where it was printed
  function pathLinkProvider(term, cwd) {
    return {
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y - 1);
        if (!line) return callback(undefined);
        const text = line.translateToString(true);
        const links = [];
        PATH_RE.lastIndex = 0;
        let m;
        while ((m = PATH_RE.exec(text))) {
          const start = m.index + m[0].indexOf(m[1]);
          const path = m[1];
          if (path.length < 3) continue;
          links.push({
            range: { start: { x: start + 1, y }, end: { x: start + path.length, y } },
            text: path,
            activate: () => vscode.postMessage({ type: 'openFile', path, cwd: cwd() || undefined })
          });
        }
        callback(links.length ? links : undefined);
      }
    };
  }

  function shellQuote(p) {
    return /^[\w@%+=:,./~-]+$/.test(p) ? p : "'" + p.replace(/'/g, "'\\''") + "'";
  }

  // OSC 7 payload (file://host/path) → path
  function oscCwd(data) {
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(String(data || ''));
    if (!m) return '';
    let dir = m[1];
    try {
      dir = decodeURIComponent(dir);
    } catch {
      /* keep raw */
    }
    if (/^\/[A-Za-z]:/.test(dir)) dir = dir.slice(1); // file:///C:/x on Windows
    return dir;
  }

  // "zsh · /path" on the plate (for the focused pane)
  function setInfo(pane) {
    pane.info = pane.shell + ' \u00b7 ' + pane.cwd;
    if (pane.id === focusedPaneId) statusText.textContent = pane.info;
  }

  // Shared drop logic: Explorer/editor drags carry file: URIs; OS drags
  // carry File objects (no path in a webview), which we upload to the
  // extension so it can save them and hand back a real path.
  function handleDrop(dt, on) {
    if (!dt) return;
    const uriList = dt.getData('text/uri-list') || '';
    const paths = uriList
      .split(/\r?\n/)
      .filter((u) => u && !u.startsWith('#') && u.startsWith('file:'))
      .map(StarBit.fileUriPath)
      .filter(Boolean);
    if (paths.length) return on.paths(paths);
    const files = Array.from(dt.files || []);
    if (files.length) {
      for (const f of files) {
        const reader = new FileReader();
        reader.onload = () => {
          const b64 = String(reader.result).split(',')[1] || '';
          on.file(f.name, b64);
        };
        reader.readAsDataURL(f);
      }
      return;
    }
    const text = dt.getData('text/plain');
    if (text) on.paths([text]);
  }

  /* ------------------------------------------------------------------ */
  /* panes                                                              */
  /* ------------------------------------------------------------------ */

  function createPane(tab) {
    const id = 'p' + ++paneCounter;

    const paneEl = document.createElement('div');
    paneEl.className = 'pane';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pane-close';
    closeBtn.title = 'Close this terminal';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closePane(id);
    });

    const host = document.createElement('div');
    host.className = 'term-host';

    paneEl.appendChild(host);
    paneEl.appendChild(closeBtn);
    tab.viewEl.appendChild(paneEl);

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily,
      fontSize,
      lineHeight: 1.25,
      letterSpacing: 0.2,
      scrollback: 8000,
      theme: xtermThemeFor(themeMode)
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    // window.open is blocked inside a webview — route URLs through VS Code
    term.loadAddon(
      new WebLinksAddon.WebLinksAddon((event, uri) => {
        vscode.postMessage({ type: 'openExternal', url: uri });
      })
    );
    // file paths (src/x.ts:12, /abs/path, ~/x, ./y) become clickable too
    term.registerLinkProvider(pathLinkProvider(term, () => pane.cwd));
    term.open(host);
    fit.fit();

    const pane = { id, tab, paneEl, term, fit, ro: null, alive: false, ended: false, info: '', shell: '', cwd: '' };
    panesById.set(id, pane);
    tab.panes.push(pane);

    term.onData((data) => vscode.postMessage({ type: 'data', id, data }));
    // shells that announce their directory (OSC 7, e.g. fish or a precmd hook)
    // keep the path plate live as the user cds around
    if (term.parser && typeof term.parser.registerOscHandler === 'function') {
      term.parser.registerOscHandler(7, (data) => {
        const dir = oscCwd(data);
        if (dir) {
          pane.cwd = dir;
          setInfo(pane);
        }
        return true;
      });
    }

    let resizeTimer;
    pane.ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!paneEl.isConnected || paneEl.offsetWidth === 0) return;
        fit.fit();
        vscode.postMessage({ type: 'resize', id, cols: term.cols, rows: term.rows });
      }, 60);
    });
    pane.ro.observe(host);

    paneEl.addEventListener('mousedown', () => setFocus(id));
    term.textarea?.addEventListener('focus', () => setFocus(id, false));

    // drag & drop: files from the OS or the Explorer land as paths in the shell
    paneEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      paneEl.classList.add('dropping');
    });
    paneEl.addEventListener('dragleave', () => paneEl.classList.remove('dropping'));
    paneEl.addEventListener('drop', (e) => {
      e.preventDefault();
      paneEl.classList.remove('dropping');
      setFocus(id);
      // a command bit dragged in from the bar runs in this pane
      const bitCommand = e.dataTransfer && e.dataTransfer.getData(BIT_MIME);
      if (bitCommand) return runIn(id, bitCommand);
      handleDrop(e.dataTransfer, {
        paths: (paths) => vscode.postMessage({ type: 'data', id, data: paths.map(shellQuote).join(' ') + ' ' }),
        file: (name, data) => vscode.postMessage({ type: 'dropFile', id, name, data })
      });
    });

    vscode.postMessage({ type: 'create', id, cols: term.cols, rows: term.rows });
    return pane;
  }

  // kill the shell and tear the pane down (its tab's bookkeeping is the caller's)
  function disposePane(p) {
    vscode.postMessage({ type: 'kill', id: p.id });
    if (p.ro) p.ro.disconnect();
    p.term.dispose();
    p.paneEl.remove();
    panesById.delete(p.id);
    pendingRuns.delete(p.id);
  }

  function closePane(id) {
    const pane = panesById.get(id);
    if (!pane) return;
    disposePane(pane);

    const tab = pane.tab;
    tab.panes = tab.panes.filter((p) => p.id !== id);

    if (tab.panes.length === 0) {
      closeTab(tab.id, /*panesAlreadyClosed*/ true);
    } else {
      refit(tab);
      setFocus(tab.panes[tab.panes.length - 1].id);
      // the pane count badge and the split key's enabled state live in the
      // tab strip — without this, splitting to 3 and closing one left the
      // split key stuck disabled
      renderTabs();
    }
  }

  function setFocus(id, takeDomFocus = true) {
    if (!panesById.has(id)) return;
    focusedPaneId = id;
    for (const p of panesById.values()) {
      p.paneEl.classList.toggle('focused', p.id === id);
    }
    const pane = panesById.get(id);
    if (takeDomFocus) pane.term.focus();
    statusText.textContent = pane.info;
  }

  function refit(tab) {
    requestAnimationFrame(() => {
      for (const p of tab.panes) {
        if (p.paneEl.offsetWidth === 0) continue;
        p.fit.fit();
        vscode.postMessage({ type: 'resize', id: p.id, cols: p.term.cols, rows: p.term.rows });
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* tabs                                                               */
  /* ------------------------------------------------------------------ */

  function freeSlot() {
    for (let s = 0; s < MAX_TABS; s++) {
      if (!tabs.some((t) => t.slot === s)) return s;
    }
    return -1;
  }

  function createTab(slot) {
    if (slot === undefined || tabs.some((t) => t.slot === slot)) {
      slot = freeSlot();
    }
    if (slot === -1) return null; // all 8 sockets occupied

    const id = 't' + ++tabCounter;
    const viewEl = document.createElement('div');
    viewEl.className = 'tabview';
    trayEl.appendChild(viewEl);

    const tab = { id, slot, label: String(slot + 1), viewEl, panes: [] };
    tabs.push(tab);

    createPane(tab);
    activateTab(id); // focuses the pane and renders the strip (with the wake pulse)
    return tab;
  }

  function closeTab(id, panesAlreadyClosed = false) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const tab = tabs[idx];

    if (!panesAlreadyClosed) {
      for (const p of [...tab.panes]) disposePane(p);
    }
    tab.viewEl.remove();
    tabs.splice(idx, 1);

    if (tabs.length === 0) {
      createTab(); // never leave the tray empty
      return;
    }
    if (activeTabId === id) activateTab(tabs[Math.max(0, idx - 1)].id);
    else renderTabs();
  }

  function activateTab(id) {
    activeTabId = id;
    for (const t of tabs) {
      t.viewEl.classList.toggle('active', t.id === id);
    }
    const tab = tabs.find((t) => t.id === id);
    if (tab) {
      refit(tab);
      const pane = tab.panes[tab.panes.length - 1];
      if (pane) setFocus(pane.id);
    }
    renderTabs();
  }

  function renderTabs() {
    tabsEl.textContent = '';
    for (let s = 0; s < MAX_TABS; s++) {
      const tab = tabs.find((t) => t.slot === s);

      if (!tab) {
        const socket = document.createElement('button');
        socket.className = 'socket empty';
        socket.title = 'New terminal';
        socket.addEventListener('click', () => createTab(s));
        tabsEl.appendChild(socket);
        continue;
      }

      const socket = document.createElement('div');
      socket.className = 'socket filled';

      const btn = document.createElement('button');
      const isActive = tab.id === activeTabId;
      btn.className = 'tab' + (isActive ? ' active' : '');
      if (isActive && activeTabId !== lastWakeTab) {
        btn.classList.add('wake'); // pulse only on genuine switches
      }
      btn.title = 'Terminal ' + tab.label;

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = tab.label;
      btn.appendChild(label);

      if (tab.panes.length > 1) {
        const badge = document.createElement('span');
        badge.className = 'tab-badge';
        badge.textContent = tab.panes.length;
        btn.appendChild(badge);
      }

      const sel = document.createElement('span');
      sel.className = 'sel';
      btn.appendChild(sel);

      const x = document.createElement('span');
      x.className = 'tab-x';
      x.textContent = '\u00d7';
      x.title = 'Close';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });
      btn.appendChild(x);

      btn.addEventListener('click', () => activateTab(tab.id));
      socket.appendChild(btn);
      tabsEl.appendChild(socket);
    }
    const active = tabs.find((t) => t.id === activeTabId);
    splitBtn.disabled = !!active && active.panes.length >= MAX_PANES_PER_TAB;
    lastWakeTab = activeTabId;
  }

  /* ------------------------------------------------------------------ */
  /* toolbar                                                            */
  /* ------------------------------------------------------------------ */

  splitBtn.addEventListener('click', () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || tab.panes.length >= MAX_PANES_PER_TAB) return;
    const pane = createPane(tab);
    refit(tab);
    setFocus(pane.id);
    renderTabs();
  });

  $q('restartBtn').addEventListener('click', restartFocused);

  function applyTheme(mode) {
    if (mode !== 'dark' && mode !== 'light') return;
    themeMode = mode;
    document.body.dataset.theme = themeMode;
    const xtheme = xtermThemeFor(themeMode);
    for (const p of panesById.values()) {
      p.term.options.theme = xtheme;
    }
  }

  $q('themeBtn').addEventListener('click', () => {
    applyTheme(themeMode === 'dark' ? 'light' : 'dark');
    vscode.postMessage({ type: 'setTheme', theme: themeMode });
  });

  function restartPane(pane) {
    vscode.postMessage({
      type: 'restart',
      id: pane.id,
      cols: pane.term.cols,
      rows: pane.term.rows
    });
    pane.term.focus();
  }

  function restartFocused() {
    const pane = panesById.get(focusedPaneId);
    if (pane) restartPane(pane);
  }

  /* ------------------------------------------------------------------ */
  /* command bits — a little dock of coloured ✦ keys after the sockets. */
  /* Each one types a saved command into the focused terminal; drag one */
  /* onto a pane to run it there instead. Saved in starbit.commandBits. */
  /* ------------------------------------------------------------------ */

  const MAX_BITS = 6;
  const BIT_COLORS = ['gold', 'mint', 'blue', 'orange', 'red', 'purple', 'cyan', 'pink'];
  const bitsEl = $q('bits');
  const editorEl = $q('bit-editor');
  const editorTitle = $q('bit-editor-title');
  const labelIn = $q('bit-label');
  const commandIn = $q('bit-command');
  const colorsEl = $q('bit-colors');
  const saveBtn = $q('bit-save');
  const removeBtn = $q('bit-remove');
  const cancelBtn = $q('bit-cancel');

  let bits = []; // [{ label, command, color }]
  let editing = null; // index being edited, -1 for a new bit, null when closed
  let chosenColor = 'gold';

  function bitColor(c) {
    return BIT_COLORS.includes(c) ? c : 'gold';
  }

  function renderBits() {
    bitsEl.textContent = '';
    bits.forEach((bit, i) => {
      const socket = document.createElement('div');
      socket.className = 'socket bit-socket';

      const btn = document.createElement('button');
      btn.className = 'key bit';
      btn.dataset.color = bitColor(bit.color);
      btn.title = (bit.label || bit.command) + ' · click to run, right-click to edit';
      btn.setAttribute('aria-label', 'Run ' + (bit.label || bit.command));
      btn.draggable = true;

      const star = document.createElement('span');
      star.className = 'bit-star';
      star.textContent = '✦';
      btn.appendChild(star);

      const edit = document.createElement('span');
      edit.className = 'bit-edit';
      edit.textContent = '⋯';
      edit.title = 'Edit';
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditor(i, socket);
      });
      btn.appendChild(edit);

      btn.addEventListener('click', () => runBit(bit, btn));
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openEditor(i, socket);
      });
      btn.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(BIT_MIME, bit.command);
        e.dataTransfer.setData('text/plain', bit.command);
        e.dataTransfer.effectAllowed = 'copy';
      });

      socket.appendChild(btn);
      bitsEl.appendChild(socket);
    });

    if (bits.length < MAX_BITS) {
      const add = document.createElement('button');
      add.className = 'socket empty bit-add';
      add.title = 'New command bit';
      add.addEventListener('click', () => openEditor(-1, add));
      bitsEl.appendChild(add);
    }
  }

  // type the command into a pane's shell (and put the cursor there)
  function runIn(id, command) {
    const pane = panesById.get(id);
    if (!pane) return;
    setFocus(id);
    vscode.postMessage({ type: 'data', id, data: command + '\r' });
  }

  function runBit(bit, btn) {
    if (btn) {
      btn.classList.remove('fired');
      void btn.offsetWidth; // restart the pop animation on rapid clicks
      btn.classList.add('fired');
    }
    let pane = panesById.get(focusedPaneId);
    if (!pane) {
      const tab = tabs.find((t) => t.id === activeTabId) || createTab();
      pane = tab && tab.panes[tab.panes.length - 1];
      if (!pane) return;
    }
    if (pane.ended) {
      // the shell has gone: bring it back and run once it is up
      pendingRuns.set(pane.id, () => runIn(pane.id, bit.command));
      restartPane(pane);
      return;
    }
    if (!pane.alive) {
      pendingRuns.set(pane.id, () => runIn(pane.id, bit.command)); // still booting
      return;
    }
    runIn(pane.id, bit.command);
  }

  function pickColor(c) {
    chosenColor = bitColor(c);
    for (const sw of colorsEl.children) {
      const on = sw.dataset.color === chosenColor;
      sw.classList.toggle('on', on);
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  for (const c of BIT_COLORS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'bit-swatch';
    sw.dataset.color = c;
    sw.title = c;
    sw.setAttribute('role', 'radio');
    sw.textContent = '✦';
    const sel = document.createElement('span');
    sel.className = 'sel';
    sw.appendChild(sel);
    sw.addEventListener('click', () => pickColor(c));
    colorsEl.appendChild(sw);
  }

  function openEditor(index, anchor) {
    editing = index;
    const bit = index >= 0 ? bits[index] : { label: '', command: '', color: BIT_COLORS[bits.length % BIT_COLORS.length] };
    labelIn.value = bit.label || '';
    commandIn.value = bit.command || '';
    commandIn.classList.remove('miss');
    pickColor(bit.color);
    removeBtn.hidden = index < 0;
    editorTitle.textContent = index < 0 ? 'new command bit' : 'edit command bit';

    // sit just under the socket that opened it, kept inside the deck
    const deckBox = root.getBoundingClientRect();
    const barBox = $q('bar').getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    editorEl.hidden = false;
    const width = editorEl.offsetWidth || 300;
    editorEl.style.top = Math.round(barBox.bottom - deckBox.top + 4) + 'px';
    editorEl.style.left = Math.round(Math.max(8, Math.min(a.left - deckBox.left, deckBox.width - width - 8))) + 'px';
    commandIn.focus();
  }

  function closeEditor() {
    editorEl.hidden = true;
    editing = null;
    const pane = panesById.get(focusedPaneId);
    if (pane) pane.term.focus();
  }

  function commitBits() {
    renderBits();
    vscode.postMessage({ type: 'setBits', bits });
  }

  function saveEditor() {
    if (editing === null) return;
    const command = commandIn.value.trim();
    if (!command) {
      commandIn.classList.add('miss');
      commandIn.focus();
      return;
    }
    const bit = { label: labelIn.value.trim(), command, color: chosenColor };
    if (editing >= 0 && editing < bits.length) bits[editing] = bit;
    else if (bits.length < MAX_BITS) bits.push(bit);
    commitBits();
    closeEditor();
  }

  function removeBit() {
    if (editing !== null && editing >= 0) bits.splice(editing, 1);
    commitBits();
    closeEditor();
  }

  saveBtn.addEventListener('click', saveEditor);
  removeBtn.addEventListener('click', removeBit);
  cancelBtn.addEventListener('click', closeEditor);
  commandIn.addEventListener('input', () => commandIn.classList.remove('miss'));
  editorEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeEditor();
    } else if (e.key === 'Enter' && (e.target === labelIn || e.target === commandIn)) {
      e.preventDefault();
      saveEditor();
    }
  });
  // click anywhere else and the card folds away
  document.addEventListener('mousedown', (e) => {
    if (editorEl.hidden || editorEl.contains(e.target) || bitsEl.contains(e.target)) return;
    closeEditor();
  });

  renderBits();

  /* ------------------------------------------------------------------ */
  /* path plate: click the "zsh · /path" plate to type a new directory  */
  /* ------------------------------------------------------------------ */

  const cwdInput = $q('cwdInput');
  let cwdEditing = null; // pane id whose directory is being edited, null when closed

  function openCwd() {
    const pane = panesById.get(focusedPaneId);
    if (!pane || !pane.shell) return;
    cwdEditing = pane.id;
    cwdInput.value = pane.cwd || '';
    cwdInput.classList.remove('miss', 'busy');
    statusText.hidden = true;
    cwdInput.hidden = false;
    cwdInput.focus();
    cwdInput.select();
  }

  function closeCwd(refocus) {
    if (cwdEditing === null) return;
    cwdEditing = null;
    cwdInput.hidden = true;
    cwdInput.classList.remove('miss', 'busy');
    statusText.hidden = false;
    if (refocus) {
      const pane = panesById.get(focusedPaneId);
      if (pane) pane.term.focus();
    }
  }

  function submitCwd() {
    const pane = panesById.get(cwdEditing);
    const target = cwdInput.value.trim();
    if (!pane || !target || target === pane.cwd) return closeCwd(true);
    if (!pane.alive) {
      // shell gone or still booting: cd once it is up (a dead one is restarted)
      // (queued as the same checked `cd` message, resolved against the folder shown now)
      const from = pane.cwd;
      pendingRuns.set(pane.id, () => vscode.postMessage({ type: 'cd', id: pane.id, path: target, from }));
      if (pane.ended) restartPane(pane);
      return closeCwd(true);
    }
    // the extension checks the folder exists before typing `cd`; answers cwd / cwdError
    cwdInput.classList.remove('miss');
    cwdInput.classList.add('busy');
    vscode.postMessage({ type: 'cd', id: pane.id, path: target, from: pane.cwd });
  }

  statusText.addEventListener('click', openCwd);
  statusText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openCwd();
    }
  });
  cwdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCwd();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCwd(true);
    }
  });
  cwdInput.addEventListener('input', () => cwdInput.classList.remove('miss'));
  cwdInput.addEventListener('blur', () => {
    // clicking away cancels; while the extension is checking, keep it open
    if (!cwdInput.classList.contains('busy')) closeCwd(false);
  });

  /* ------------------------------------------------------------------ */
  /* messages from the extension                                        */
  /* ------------------------------------------------------------------ */

  StarBit.on('term', (msg) => {
    const pane = msg.id ? panesById.get(msg.id) : undefined;

    switch (msg.type) {
      case 'output':
        pane?.term.write(msg.data);
        break;
      case 'started':
        if (pane) {
          pane.alive = true;
          pane.ended = false;
          pane.shell = msg.shell.split(/[\\/]/).pop();
          pane.cwd = msg.cwd;
          setInfo(pane);
          const queued = pendingRuns.get(pane.id);
          if (queued) {
            pendingRuns.delete(pane.id);
            // give the shell a beat to print its prompt, like autoCommand does
            setTimeout(queued, 400);
          }
        }
        break;
      case 'exited':
        if (pane) {
          pane.alive = false;
          pane.ended = true;
          pane.info = 'session ended (' + msg.code + ')';
          pane.term.write('\r\n\x1b[38;2;106;114;124m\u2014 session ended \u2014 press \u21bb or close this pane\x1b[0m\r\n');
          if (pane.id === focusedPaneId) statusText.textContent = pane.info;
        }
        break;
      case 'clear':
        pane?.term.reset();
        break;
      case 'spawnError':
        if (pane) pane.ended = true; // dead, not booting: a bit or cd will try a restart
        pane?.term.write('\r\n\x1b[38;2;200;82;74m' + msg.message.replace(/\n/g, '\r\n') + '\x1b[0m\r\n');
        break;
      case 'restartFocused':
        restartFocused();
        break;
      case 'setTheme':
        // pushed by the extension when starbit.theme changes anywhere
        // (the Claude view's sun/moon key, or settings)
        applyTheme(msg.theme);
        break;
      case 'bits':
        // on boot and whenever starbit.commandBits changes (our own saves echo back too)
        bits = Array.isArray(msg.bits) ? msg.bits.slice(0, MAX_BITS) : [];
        renderBits();
        break;
      case 'cwd':
        // the extension typed `cd` for us and confirms the resolved folder
        if (pane) {
          pane.cwd = msg.cwd;
          setInfo(pane);
          if (cwdEditing === pane.id) closeCwd(true);
        }
        break;
      case 'cwdError':
        // not a folder: keep the input open, outlined red, ready to fix
        if (pane && cwdEditing === pane.id) {
          cwdInput.classList.remove('busy');
          cwdInput.classList.add('miss');
          cwdInput.focus();
          cwdInput.select();
        }
        break;
    }
  });

  /* ------------------------------------------------------------------ */
  /* boot                                                               */
  /* ------------------------------------------------------------------ */

  // the Claude deck's terminal rail builds its xterm from the same parts
  window.StarBitXterm = {
    fontFamily,
    fontSize,
    themeFor: xtermThemeFor,
    linkProvider: pathLinkProvider,
    oscCwd,
    shellQuote,
    handleDrop
  };

  // refit + refocus when this deck comes to the front
  window.addEventListener('starbit:deck', (e) => {
    if (e.detail !== 'term') {
      // fold the bit editor quietly (closeEditor would focus a hidden terminal)
      editorEl.hidden = true;
      editing = null;
      return;
    }
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab) refit(tab);
    const pane = panesById.get(focusedPaneId);
    if (pane) pane.term.focus();
  });

  vscode.postMessage({ type: 'ready' });
  createTab();
})();

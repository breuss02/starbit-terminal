/* The Claude deck's terminal rail: one real shell beside the transcript,
   started in the workspace folder — the folder Claude works in. It speaks
   the terminal deck's protocol (`via: 'term'`, its own pane id), so the
   extension's pty broker serves it like any other pane, and it borrows
   the terminal deck's xterm theme, link provider and drop handling
   (window.StarBitXterm, set up by media/main.js).
   The shell starts the first time the rail is really on screen, and keeps
   running while the rail is folded, the panel narrows or the other deck
   is in front. */
(function () {
  const ID = 'rail'; // the terminal deck's own panes are p1, p2, …

  const RESTART_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.7-3.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M13.4 1.6v3.2h-3.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function basename(p) {
    const parts = String(p || '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(p || '');
  }

  /**
   * mount(parent, { theme, onFocus(bool) }) → { setVisible, focus, setTheme }
   * `parent` is the rail's body; the rail's fold key sits over its top-right.
   */
  function mount(parent, opts) {
    const X = window.StarBitXterm;
    const vscode = StarBit.client('term');
    let themeMode = opts.theme === 'dark' ? 'dark' : 'light';

    const head = el('div', 'rail-head');
    head.appendChild(el('span', 'rail-star tr-prompt', '>_'));
    head.appendChild(el('span', 'rail-title', 'terminal'));
    const sub = el('span', 'rail-sub tr-where', '');
    head.appendChild(sub);
    const restartBtn = el('button', 'key tr-restart');
    restartBtn.innerHTML = RESTART_SVG;
    restartBtn.title = 'Restart this shell';
    restartBtn.setAttribute('aria-label', 'Restart this shell');
    head.appendChild(restartBtn);

    const box = el('div', 'tr-box');
    const host = el('div', 'term-host');
    box.appendChild(host);
    parent.appendChild(head);
    parent.appendChild(box);

    let term = null;
    let fit = null;
    let shell = '';
    let cwd = '';
    let visible = false;

    function setWhere(text, title) {
      sub.textContent = text;
      sub.title = title || text;
    }

    function refit() {
      if (!term || !visible || box.offsetWidth === 0) return;
      fit.fit();
      vscode.postMessage({ type: 'resize', id: ID, cols: term.cols, rows: term.rows });
    }

    function spawn() {
      term = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        cursorStyle: 'bar',
        fontFamily: X.fontFamily,
        fontSize: X.fontSize,
        lineHeight: 1.25,
        letterSpacing: 0.2,
        scrollback: 8000,
        theme: X.themeFor(themeMode)
      });
      fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      // window.open is blocked inside a webview — route URLs through VS Code
      term.loadAddon(
        new WebLinksAddon.WebLinksAddon((event, uri) => vscode.postMessage({ type: 'openExternal', url: uri }))
      );
      term.registerLinkProvider(X.linkProvider(term, () => cwd));
      term.open(host);
      fit.fit();

      term.onData((data) => vscode.postMessage({ type: 'data', id: ID, data }));
      // shells that announce their directory (OSC 7) keep the folder label live
      if (term.parser && typeof term.parser.registerOscHandler === 'function') {
        term.parser.registerOscHandler(7, (data) => {
          const dir = X.oscCwd(data);
          if (dir) {
            cwd = dir;
            setWhere(shell + ' · ' + basename(cwd), cwd);
          }
          return true;
        });
      }
      if (term.textarea) {
        term.textarea.addEventListener('focus', () => opts.onFocus && opts.onFocus(true));
        term.textarea.addEventListener('blur', () => opts.onFocus && opts.onFocus(false));
      }

      let resizeTimer;
      new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(refit, 60);
      }).observe(host);

      // files from the OS or the Explorer land as paths in the shell
      box.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        box.classList.add('dropping');
      });
      box.addEventListener('dragleave', () => box.classList.remove('dropping'));
      box.addEventListener('drop', (e) => {
        e.preventDefault();
        box.classList.remove('dropping');
        term.focus();
        X.handleDrop(e.dataTransfer, {
          paths: (paths) => vscode.postMessage({ type: 'data', id: ID, data: paths.map(X.shellQuote).join(' ') + ' ' }),
          file: (name, data) => vscode.postMessage({ type: 'dropFile', id: ID, name, data })
        });
      });

      setWhere('starting…');
      // plain: no starbit.autoCommand here (it is usually `claude`, and this is the Claude deck)
      vscode.postMessage({ type: 'create', id: ID, cols: term.cols, rows: term.rows, plain: true });
    }

    function restart() {
      if (!term) return spawn();
      setWhere('restarting…');
      vscode.postMessage({ type: 'restart', id: ID, cols: term.cols, rows: term.rows, plain: true });
      term.focus();
    }
    restartBtn.addEventListener('click', restart);

    StarBit.on('term', (msg) => {
      if (msg.id !== ID || !term) return;
      switch (msg.type) {
        case 'output':
          term.write(msg.data);
          break;
        case 'started':
          shell = String(msg.shell || '').split(/[\\/]/).pop();
          cwd = msg.cwd;
          setWhere(shell + ' · ' + basename(cwd), cwd);
          break;
        case 'exited':
          setWhere('ended (' + msg.code + ')');
          term.write('\r\n\x1b[38;2;106;114;124m— session ended — press ↻ to start a new shell\x1b[0m\r\n');
          break;
        case 'clear':
          term.reset();
          break;
        case 'spawnError':
          setWhere('no shell');
          term.write('\r\n\x1b[38;2;200;82;74m' + String(msg.message).replace(/\n/g, '\r\n') + '\x1b[0m\r\n');
          break;
      }
    });

    return {
      /** The rail is (or is no longer) on screen: start the shell the first time, refit after. */
      setVisible(on) {
        visible = !!on;
        if (!visible) return;
        if (!term) spawn();
        else requestAnimationFrame(refit);
      },
      focus() {
        if (term) term.focus();
      },
      setTheme(mode) {
        if (mode !== 'dark' && mode !== 'light') return;
        themeMode = mode;
        if (term) term.options.theme = X.themeFor(mode);
      }
    };
  }

  window.StarbitTermRail = { mount };
})();

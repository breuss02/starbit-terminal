/* Tiny markdown → DOM renderer for the Claude transcript.
   Builds nodes directly (never innerHTML) so it is CSP-safe and cannot
   inject markup. Covers what Claude actually emits: paragraphs, headings,
   fenced code, inline code, bold/italic/strike, links, lists (nested),
   blockquotes, tables, horizontal rules. */
(function () {
  const el = (tag, cls) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  };

  const INLINE = new RegExp(
    [
      '(`+)([\\s\\S]*?[^`])\\1(?!`)', // 1,2 code
      '\\*\\*((?:[^*\\n]|\\*(?!\\*))+?)\\*\\*', // 3 bold (may contain single * for italics)
      '__((?:[^_\\n]|_(?!_))+?)__', // 4 bold
      '\\*([^*\\n]+?)\\*', // 5 italic
      '(?<![\\w])_([^_\\n]+?)_(?![\\w])', // 6 italic
      '~~([^~\\n]+?)~~', // 7 strike
      '\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)', // 8,9 link
      '(https?:\\/\\/[^\\s<>()]+[^\\s<>().,;:!?\'"])', // 10 autolink
      '\\n' // hard break
    ].join('|'),
    'g'
  );

  function safeHref(href) {
    // web links only: a webview cannot open file:// links, and vscode:// would
    // let model output (steerable by any file Claude reads) trigger URI handlers
    return /^https?:\/\//i.test(href) ? href : null;
  }

  function inline(parent, text) {
    // a fresh regex per call: inline() recurses for bold/italic/links, and a
    // shared global regex would have its lastIndex reset by the inner call,
    // restarting the outer loop forever
    const re = new RegExp(INLINE.source, 'g');
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index === re.lastIndex) re.lastIndex++; // never stall on an empty match
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      last = m.index + m[0].length;
      if (m[2] !== undefined) {
        const c = el('code');
        c.textContent = m[2].replace(/^ (.*) $/, '$1');
        parent.appendChild(c);
      } else if (m[3] !== undefined || m[4] !== undefined) {
        const b = el('strong');
        inline(b, m[3] !== undefined ? m[3] : m[4]);
        parent.appendChild(b);
      } else if (m[5] !== undefined || m[6] !== undefined) {
        const i = el('em');
        inline(i, m[5] !== undefined ? m[5] : m[6]);
        parent.appendChild(i);
      } else if (m[7] !== undefined) {
        const s = el('del');
        inline(s, m[7]);
        parent.appendChild(s);
      } else if (m[8] !== undefined) {
        const href = safeHref(m[9]);
        const a = el(href ? 'a' : 'span');
        if (href) {
          a.href = href;
          a.title = href;
        }
        inline(a, m[8]);
        parent.appendChild(a);
      } else if (m[10] !== undefined) {
        const a = el('a');
        a.href = m[10];
        a.textContent = m[10];
        parent.appendChild(a);
      } else {
        parent.appendChild(el('br'));
      }
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  const RE_FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)/;
  const RE_HEAD = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/; // a closing run of #s needs a space: `## Using C#` keeps its #
  const RE_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const RE_QUOTE = /^\s*>/;
  const RE_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function isBlockStart(line) {
    return (
      RE_FENCE.test(line) ||
      RE_HEAD.test(line) ||
      RE_HR.test(line) ||
      RE_QUOTE.test(line) ||
      RE_LIST.test(line) ||
      /^\s*\|/.test(line)
    );
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  }

  function parseList(lines, i) {
    // collect list lines + indented continuation lines
    const items = []; // { indent, ordered, start, text }
    while (i < lines.length) {
      const line = lines[i];
      const m = line.match(RE_LIST);
      if (m) {
        items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] });
        i++;
      } else if (items.length && /^\s+\S/.test(line) && !RE_FENCE.test(line)) {
        items[items.length - 1].text += '\n' + line.trim();
        i++;
      } else {
        break;
      }
    }
    // build nested lists from indent levels
    // ordered lists keep their first number: `2. b` after a blank line or a code block is still item 2
    const listFor = (it) => {
      const list = el(it.ordered ? 'ol' : 'ul');
      if (it.ordered && it.start > 1) list.start = it.start;
      return list;
    };
    const root = listFor(items[0]);
    const stack = [{ indent: items[0].indent, list: root, li: null }];
    for (const it of items) {
      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) stack.pop();
      let top = stack[stack.length - 1];
      if (it.indent > top.indent && top.li) {
        const sub = listFor(it);
        top.li.appendChild(sub);
        top = { indent: it.indent, list: sub, li: null };
        stack.push(top);
      }
      const li = el('li');
      inline(li, it.text);
      top.list.appendChild(li);
      top.li = li;
    }
    return { node: root, next: i };
  }

  function render(src) {
    const frag = document.createDocumentFragment();
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;

      if (/^\s*$/.test(line)) {
        i++;
        continue;
      }

      if ((m = line.match(RE_FENCE))) {
        const fence = m[1];
        const lang = m[2];
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
        i++;
        const pre = el('pre');
        const code = el('code');
        if (lang) code.dataset.lang = lang;
        code.textContent = buf.join('\n');
        pre.appendChild(code);
        frag.appendChild(pre);
        continue;
      }

      if ((m = line.match(RE_HEAD))) {
        // demote one level so headings stay small inside the card
        const h = el('h' + Math.min(4, m[1].length + 1));
        inline(h, m[2]);
        frag.appendChild(h);
        i++;
        continue;
      }

      if (RE_HR.test(line)) {
        frag.appendChild(el('hr'));
        i++;
        continue;
      }

      if (RE_QUOTE.test(line)) {
        const buf = [];
        while (i < lines.length && RE_QUOTE.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        const bq = el('blockquote');
        bq.appendChild(render(buf.join('\n')));
        frag.appendChild(bq);
        continue;
      }

      if (/^\s*\|/.test(line) && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
        const table = el('table');
        const thead = el('thead');
        const tr = el('tr');
        for (const c of splitRow(line)) {
          const th = el('th');
          inline(th, c);
          tr.appendChild(th);
        }
        thead.appendChild(tr);
        table.appendChild(thead);
        const tbody = el('tbody');
        i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          const r = el('tr');
          for (const c of splitRow(lines[i])) {
            const td = el('td');
            inline(td, c);
            r.appendChild(td);
          }
          tbody.appendChild(r);
          i++;
        }
        table.appendChild(tbody);
        frag.appendChild(table);
        continue;
      }

      if (RE_LIST.test(line)) {
        const r = parseList(lines, i);
        frag.appendChild(r.node);
        i = r.next;
        continue;
      }

      const buf = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) buf.push(lines[i++]);
      const p = el('p');
      inline(p, buf.join('\n'));
      frag.appendChild(p);
    }
    return frag;
  }

  window.StarbitMd = { render };
})();

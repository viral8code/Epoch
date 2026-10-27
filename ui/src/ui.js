// DOM helpers and the shared overlays: menus, dialogs, quick pick, notifications.
// Text from files, the compiler or the user is always inserted as text, never as HTML.

const overlay = () => document.getElementById('overlay-root');

/** el('div.a.b', {attrs, on: {click}}, children...) */
export function el(spec, props = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    } else if (key === 'text') {
      node.textContent = value;
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key in node && typeof value !== 'string') {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function svgIcon(path, size = 22) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of [].concat(path)) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

export function basename(path) {
  return path.split(/[\\/]/).pop();
}

export function dirname(path) {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join(path.includes('\\') ? '\\' : '/');
}

export function joinPath(dir, name) {
  const sep = dir.includes('\\') || !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/** Path comparison key: separators unified, case folded on Windows. */
export function pathKey(path) {
  const unified = path.replace(/\//g, '\\');
  return /^[a-zA-Z]:\\/.test(unified) || unified.startsWith('\\\\') ? unified.toLowerCase() : path;
}

export function relativePath(root, path) {
  if (!root) return path;
  const r = pathKey(root);
  const p = pathKey(path);
  if (p === r) return '';
  if (p.startsWith(r + '\\') || p.startsWith(r + '/')) return path.slice(root.length + 1);
  return path;
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

// Context and drop-down menus ---------------------------------------------------------------

let openMenu = null;

export function closeMenu() {
  if (openMenu) {
    openMenu.close();
    openMenu = null;
  }
}

/**
 * items: [{label, key, action, disabled, checked} | '-']
 * at: {x, y}
 */
export function showMenu(items, at, onClose) {
  closeMenu();
  const menu = el('div.menu', { role: 'menu' });
  const entries = [];
  for (const item of items) {
    if (item === '-') {
      menu.append(el('div.menu-sep'));
      continue;
    }
    const row = el(
      'div.menu-item' + (item.disabled ? '.disabled' : ''),
      { role: 'menuitem' },
      item.checked ? el('span.check', { text: '✓' }) : null,
      el('span.text', { text: item.label }),
      item.key ? el('span.key', { text: item.key }) : null,
    );
    row.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      closeMenu();
      item.action?.();
    });
    row.addEventListener('mouseenter', () => focus(entries.indexOf(row)));
    menu.append(row);
    if (!item.disabled) entries.push(row);
    row._item = item;
  }
  overlay().append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(at.x, innerWidth - rect.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(at.y, innerHeight - rect.height - 4)) + 'px';
  let index = -1;
  const focus = (i) => {
    entries.forEach((e) => e.classList.remove('focus'));
    index = i;
    entries[i]?.classList.add('focus');
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { closeMenu(); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { focus((index + 1) % entries.length); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { focus((index - 1 + entries.length) % entries.length); e.preventDefault(); }
    else if (e.key === 'Enter' && entries[index]) {
      const item = entries[index]._item;
      closeMenu();
      item.action?.();
      e.preventDefault();
    } else return;
    e.stopPropagation();
  };
  const onDown = (e) => {
    if (!menu.contains(e.target)) closeMenu();
  };
  setTimeout(() => {
    window.addEventListener('mousedown', onDown, true);
  });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', closeMenu);
  openMenu = {
    close() {
      menu.remove();
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', closeMenu);
      onClose?.();
    },
  };
}

// Dialogs ----------------------------------------------------------------------------------

function modal(build) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const backdrop = el('div.backdrop');
    const frame = el('div.dialog', { role: 'dialog', 'aria-modal': 'true' });
    const dialog = el('div.dlg-body');
    frame.append(el('div.dlg-title', { text: 'Epoch' }), dialog);
    backdrop.append(frame);
    const done = (value) => {
      backdrop.remove();
      window.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        done(undefined);
      }
    };
    window.addEventListener('keydown', onKey, true);
    build(dialog, done);
    overlay().append(backdrop);
    (dialog.querySelector('input') ?? dialog.querySelector('.btn.primary'))?.focus();
  });
}

/** Asks a question; resolves to the chosen button's `value`, or undefined when dismissed. */
export function ask(title, message, buttons) {
  return modal((dialog, done) => {
    dialog.append(el('h2', { text: title }));
    if (message) dialog.append(el('p', { text: message }));
    const row = el('div.actions');
    for (const b of buttons) {
      row.append(
        el('button.btn' + (b.primary ? '.primary' : ''), { text: b.label, on: { click: () => done(b.value) } }),
      );
    }
    dialog.append(row);
  });
}

export const confirm = (title, message, okLabel = 'OK') =>
  ask(title, message, [
    { label: 'キャンセル', value: false },
    { label: okLabel, value: true, primary: true },
  ]).then((v) => v === true);

/** Asks for a line of text. `validate` returns an error message or ''. */
export function prompt(title, { value = '', placeholder = '', validate, select } = {}) {
  return modal((dialog, done) => {
    dialog.append(el('h2', { text: title }));
    const input = el('input', { value, placeholder, spellcheck: false });
    const error = el('div.error');
    const submit = () => {
      const message = validate?.(input.value) ?? '';
      if (message) {
        error.textContent = message;
        return;
      }
      done(input.value);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    input.addEventListener('input', () => { error.textContent = validate?.(input.value) ?? ''; });
    dialog.append(
      input,
      error,
      el('div.actions',
        {},
        el('button.btn', { text: 'キャンセル', on: { click: () => done(undefined) } }),
        el('button.btn.primary', { text: 'OK', on: { click: submit } }),
      ),
    );
    setTimeout(() => {
      input.focus();
      if (select) input.setSelectionRange(...select);
      else input.select();
    });
  });
}

// Quick pick -------------------------------------------------------------------------------

/** Fuzzy subsequence match; returns {score, ranges} or null. */
export function fuzzy(query, text) {
  if (!query) return { score: 0, ranges: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) {
    const atWord = direct === 0 || /[\\/._\-\s]/.test(t[direct - 1]);
    return { score: 1000 - direct - t.length / 100 + (atWord ? 200 : 0), ranges: [[direct, direct + q.length]] };
  }
  let ti = 0;
  let score = 0;
  let last = -2;
  const ranges = [];
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    if (found === last + 1 && ranges.length) ranges[ranges.length - 1][1] = found + 1;
    else ranges.push([found, found + 1]);
    score += found === last + 1 ? 5 : /[\\/._\-\s]/.test(t[found - 1] ?? '/') ? 3 : 1;
    last = found;
    ti = found + 1;
  }
  return { score: score - t.length / 100, ranges };
}

function highlighted(text, ranges) {
  const span = el('span.label');
  let at = 0;
  for (const [a, b] of ranges ?? []) {
    if (a > at) span.append(text.slice(at, a));
    span.append(el('b', { text: text.slice(a, b) }));
    at = b;
  }
  span.append(text.slice(at));
  return span;
}

/**
 * items: [{label, description, key, value}] or a function (query) => items (already filtered).
 * Resolves to the chosen item (with `query` set) or undefined.
 */
export function quickPick({ placeholder = '', items, value = '', onQuery, matchOn = 'label' } = {}) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const backdrop = el('div.backdrop.clear');
    const box = el('div.quickpick');
    const input = el('input', { placeholder, value, spellcheck: false });
    const list = el('div.items');
    box.append(input, list);
    backdrop.append(box);
    let shown = [];
    let focus = 0;
    let finished = false;
    const done = (item) => {
      if (finished) return;
      finished = true;
      backdrop.remove();
      if (!item) previous?.focus?.();
      resolve(item ? { ...item, query: input.value } : undefined);
    };
    const render = async () => {
      const query = input.value;
      const special = onQuery?.(query);
      if (special) {
        done(undefined);
        special();
        return;
      }
      let source = typeof items === 'function' ? await items(query) : items;
      if (typeof items !== 'function') {
        source = source
          .map((item) => ({ item, m: fuzzy(query, matchOn === 'description' ? `${item.description ?? ''} ${item.label}` : item.label) }))
          .filter((x) => x.m)
          .sort((a, b) => b.m.score - a.m.score)
          .map((x) => ({ ...x.item, ranges: matchOn === 'label' ? x.m.ranges : [] }));
      }
      if (query !== input.value) return;
      shown = source.slice(0, 300);
      focus = 0;
      list.replaceChildren(
        ...(shown.length
          ? shown.map((item, i) => {
              const row = el(
                'div.qp-item',
                { on: { mousedown: (e) => { e.preventDefault(); done(item); }, mousemove: () => setFocus(i) } },
                highlighted(item.label, item.ranges),
                item.description ? el('span.desc', { text: item.description }) : null,
                item.key ? el('span.key', { text: item.key }) : null,
              );
              return row;
            })
          : [el('div.qp-empty', { text: '一致する項目はありません' })]),
      );
      setFocus(0);
    };
    const setFocus = (i) => {
      const rows = list.querySelectorAll('.qp-item');
      rows[focus]?.classList.remove('focus');
      focus = Math.max(0, Math.min(i, shown.length - 1));
      rows[focus]?.classList.add('focus');
      rows[focus]?.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') setFocus(focus + 1);
      else if (e.key === 'ArrowUp') setFocus(focus - 1);
      else if (e.key === 'PageDown') setFocus(focus + 10);
      else if (e.key === 'PageUp') setFocus(focus - 10);
      else if (e.key === 'Enter') done(shown[focus]);
      else if (e.key === 'Escape') done(undefined);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) done(undefined);
    });
    overlay().append(backdrop);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    render();
  });
}

// Notifications ----------------------------------------------------------------------------

let toastBox = null;

/** kind: info | success | warning | error. actions: [{label, action}] */
export function notify(message, kind = 'info', actions = [], timeout) {
  if (!toastBox) {
    toastBox = el('div.toasts');
    overlay().append(toastBox);
  }
  const toast = el('div.toast.' + kind, { role: kind === 'error' ? 'alert' : 'status' });
  const close = () => toast.remove();
  toast.append(el('div.msg', { text: message }));
  const buttons = [...actions, { label: '閉じる' }];
  toast.append(
    el('div.actions', {}, buttons.map((a, i) =>
      el('button.btn' + (i === 0 && actions.length ? '.primary' : ''), {
        text: a.label,
        on: { click: () => { close(); a.action?.(); } },
      }),
    )),
  );
  toastBox.append(toast);
  while (toastBox.children.length > 4) toastBox.firstChild.remove();
  const ms = timeout ?? (actions.length ? 0 : kind === 'error' ? 12000 : 5000);
  if (ms) setTimeout(close, ms);
  return close;
}

// Splitters --------------------------------------------------------------------------------

export function makeSash(sash, { axis, get, set, onEnd }) {
  sash.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sash.setPointerCapture(e.pointerId);
    sash.classList.add('dragging');
    const start = axis === 'x' ? e.clientX : e.clientY;
    const initial = get();
    const move = (m) => set(initial + ((axis === 'x' ? m.clientX : m.clientY) - start));
    const up = () => {
      sash.classList.remove('dragging');
      sash.removeEventListener('pointermove', move);
      sash.removeEventListener('pointerup', up);
      onEnd?.();
    };
    sash.addEventListener('pointermove', move);
    sash.addEventListener('pointerup', up);
  });
}

// Docked tool windows in the manner of Visual Studio: each dock group has a title bar (the
// active window's name, its buttons, the window menu, auto-hide and close) and, when it holds
// more than one window, tabs along its bottom edge. Groups: right (Solution Explorer…),
// bottom-left (Error List, Output…), bottom-right (Call Stack… while debugging).
import { monaco } from './monaco.js';
import { store, emit, subscribe } from './store.js';
import { el, relativePath, basename, showMenu } from './ui.js';
import { detachedDiagnostics } from './lsp.js';
import { openFile, activeDoc } from './editors.js';

const windows = new Map();
const groups = new Map();

class ToolGroup {
  constructor(id) {
    this.id = id;
    this.el = document.getElementById(`tg-${id}`);
    this.title = el('div.tw-title');
    this.body = el('div.tw-body');
    this.tabs = el('div.tw-tabs');
    this.el.append(this.title, this.body, this.tabs);
    this.order = [];
    this.active = null;
    this.el.addEventListener('mousedown', () => focusGroup(this), true);
  }

  visible() {
    return this.order.filter((id) => !windows.get(id).hidden);
  }

  render() {
    const shown = this.visible();
    this.el.hidden = !shown.length;
    if (!shown.includes(this.active)) this.active = shown[0] ?? null;
    for (const id of this.order) {
      const w = windows.get(id);
      w.view.classList.toggle('active', id === this.active);
    }
    const w = this.active && windows.get(this.active);
    this.title.replaceChildren(
      el('span.name', { text: w ? w.title : '' }),
      ...(w?.actions ?? []),
      el('button.icon-btn', { title: 'ウィンドウ位置', text: '▾', on: { click: (e) => this.windowMenu(e) } }),
      el('button.icon-btn', { title: '自動的に隠す', text: '📌', on: { click: () => hideDock(this) } }),
      el('button.icon-btn', { title: '閉じる', text: '✕', on: { click: () => w && hideToolWindow(w.id) } }),
    );
    this.tabs.hidden = shown.length < 2;
    this.tabs.replaceChildren(
      ...shown.map((id) => {
        const tw = windows.get(id);
        return el('button.tw-tab' + (id === this.active ? '.active' : ''), {
          on: { click: () => showToolWindow(id) },
        }, tw.title, tw.count ? el('span.count', { text: `(${tw.count})` }) : null);
      }),
    );
    updateDocks();
  }

  windowMenu(e) {
    const items = [...windows.values()].filter((w) => w.group === this).map((w) => ({
      label: w.title,
      checked: !w.hidden,
      action: () => (w.hidden ? showToolWindow(w.id) : hideToolWindow(w.id)),
    }));
    showMenu(items, { x: e.clientX, y: e.clientY + 8 });
  }
}

function focusGroup(group) {
  for (const g of groups.values()) g.el.classList.toggle('focused', g === group);
  for (const g of document.querySelectorAll('.group.focused')) g.classList.remove('focused');
}

export function clearToolFocus() {
  for (const g of groups.values()) g.el.classList.remove('focused');
}

function updateDocks() {
  const bottom = document.getElementById('bottom-dock');
  const anyBottom = ['bottom-left', 'bottom-right'].some((id) => groups.get(id)?.visible().length);
  bottom.hidden = !anyBottom || bottom.dataset.collapsed === '1';
  document.getElementById('bottom-sash').hidden = bottom.hidden;
  const bothBottom = ['bottom-left', 'bottom-right'].every((id) => groups.get(id)?.visible().length);
  document.getElementById('bottom-split-sash').hidden = !bothBottom;
  const right = document.getElementById('right-dock');
  right.hidden = !groups.get('right')?.visible().length || right.dataset.collapsed === '1';
  document.getElementById('right-sash').hidden = right.hidden;
}

function hideDock(group) {
  const dock = group.id === 'right' ? document.getElementById('right-dock') : document.getElementById('bottom-dock');
  dock.dataset.collapsed = '1';
  updateDocks();
}

export function addToolWindow({ id, title, group = 'bottom-left', content, actions = [], hidden = false }) {
  if (!groups.has(group)) groups.set(group, new ToolGroup(group));
  const g = groups.get(group);
  const view = el('div.tw-view', { dataset: { view: id } }, content);
  g.body.append(view);
  g.order.push(id);
  const w = { id, title, group: g, view, actions, hidden, count: 0 };
  windows.set(id, w);
  g.render();
  return {
    setCount(n) {
      w.count = n;
      g.render();
    },
  };
}

/** Shows (re-opens) a tool window, brings it to the front of its group and its dock into view. */
export function showToolWindow(id, { focus = false } = {}) {
  const w = windows.get(id);
  if (!w) return;
  w.hidden = false;
  w.group.active = id;
  const dock = w.group.id === 'right' ? document.getElementById('right-dock') : document.getElementById('bottom-dock');
  dock.dataset.collapsed = '0';
  w.group.render();
  if (focus) focusGroup(w.group);
  emit('panel-shown', id);
}

export function hideToolWindow(id) {
  const w = windows.get(id);
  if (!w) return;
  w.hidden = true;
  w.group.render();
}

export function isToolWindowVisible(id) {
  const w = windows.get(id);
  return !!w && !w.hidden && w.group.active === id && !w.group.el.hidden && !w.group.el.closest('[hidden]');
}

// The older panel API, used by the rest of the window.
export const addPanelView = (id, title, content, actions = [], group = 'bottom-left') => addToolWindow({ id, title, content, actions, group });
export const showPanel = (id) => showToolWindow(id);
export const isPanelVisible = isToolWindowVisible;

export function togglePanel(id) {
  const bottom = document.getElementById('bottom-dock');
  if (id) {
    if (isToolWindowVisible(id)) hideDock(windows.get(id).group);
    else showToolWindow(id);
    return;
  }
  bottom.dataset.collapsed = bottom.hidden ? '0' : '1';
  updateDocks();
}

export function toggleRightDock() {
  const right = document.getElementById('right-dock');
  right.dataset.collapsed = right.hidden ? '0' : '1';
  updateDocks();
}

// Console (output, program console, immediate window) --------------------------------------

const MAX_CONSOLE_NODES = 4000;

export class Console {
  constructor() {
    this.el = el('pre.console', { tabindex: 0 });
    this.stick = true;
    this.el.addEventListener('scroll', () => {
      this.stick = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 4;
    });
  }

  append(text, cls) {
    if (!text) return;
    const last = this.el.lastChild;
    if (last && last.nodeType === 1 && (last.className || '') === (cls || '') && !last.dataset.fixed && last.textContent.length < 65536) {
      last.textContent += text;
    } else {
      this.el.append(el('span' + (cls ? '.' + cls : ''), { text }));
    }
    this.trim();
    this.scroll();
  }

  appendNode(node) {
    node.dataset.fixed = '1';
    this.el.append(node);
    this.trim();
    this.scroll();
  }

  trim() {
    while (this.el.childNodes.length > MAX_CONSOLE_NODES) this.el.firstChild.remove();
  }

  scroll() {
    if (this.stick) this.el.scrollTop = this.el.scrollHeight;
  }

  clear() {
    this.el.replaceChildren();
  }
}

export const output = new Console();

// Error List ---------------------------------------------------------------------------------

const errorFilter = { error: true, warning: true, info: true, scope: 'all', text: '', sort: 'severity', desc: false };
const errorBody = el('tbody');
const errorTable = el('table.grid', {},
  el('colgroup', {}, el('col', { style: { width: '26px' } }), el('col', { style: { width: '130px' } }), el('col'), el('col', { style: { width: '110px' } }), el('col', { style: { width: '160px' } }), el('col', { style: { width: '56px' } })),
  el('thead', {}, el('tr', {}, ...[
    ['', 'severity'], ['コード', 'code'], ['説明', 'message'], ['プロジェクト', 'project'], ['ファイル', 'file'], ['行', 'line'],
  ].map(([label, key]) => el('th.sortable', {
    text: label,
    on: { click: () => { errorFilter.desc = errorFilter.sort === key ? !errorFilter.desc : false; errorFilter.sort = key; renderProblems(); } },
  })))),
  errorBody,
);
const toggleButtons = {};
let problemsWindow = null;

function severityClass(severity) {
  if (severity === monaco.MarkerSeverity.Error) return ['sev-error', '⊗'];
  if (severity === monaco.MarkerSeverity.Warning) return ['sev-warning', '⚠'];
  return ['sev-info', 'ⓘ'];
}

function allProblems() {
  const list = [];
  for (const m of monaco.editor.getModelMarkers({})) {
    const path = m.resource.scheme === 'file' ? m.resource.fsPath : m.resource.toString();
    list.push({ ...m, path });
  }
  for (const { path, markers } of detachedDiagnostics.values()) {
    for (const m of markers) list.push({ ...m, path });
  }
  return list;
}

export function problemTotals() {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const m of allProblems()) {
    if (m.severity === monaco.MarkerSeverity.Error) errors++;
    else if (m.severity === monaco.MarkerSeverity.Warning) warnings++;
    else infos++;
  }
  return { errors, warnings, infos };
}

function renderProblems() {
  const totals = problemTotals();
  const docPath = activeDoc()?.path;
  const project = store.workspace?.name ?? '';
  const kind = (m) => (m.severity === monaco.MarkerSeverity.Error ? 'error' : m.severity === monaco.MarkerSeverity.Warning ? 'warning' : 'info');
  const text = errorFilter.text.toLowerCase();
  let list = allProblems().filter((m) => errorFilter[kind(m)]);
  if (errorFilter.scope === 'current') list = list.filter((m) => m.path === docPath);
  if (text) list = list.filter((m) => `${m.code ?? ''} ${m.message} ${m.path}`.toLowerCase().includes(text));
  const key = {
    severity: (m) => -m.severity,
    code: (m) => m.code ?? '',
    message: (m) => m.message,
    project: () => project,
    file: (m) => basename(m.path),
    line: (m) => m.startLineNumber,
  }[errorFilter.sort];
  list.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'ja');
    return (errorFilter.desc ? -c : c) || a.startLineNumber - b.startLineNumber;
  });
  errorBody.replaceChildren(
    ...list.map((m) => {
      const [cls, icon] = severityClass(m.severity);
      const row = el('tr', {
        title: m.message,
        on: {
          click: () => {
            for (const r of errorBody.children) r.classList.remove('selected');
            row.classList.add('selected');
          },
          dblclick: () => openFile(m.path, { selection: new monaco.Range(m.startLineNumber, m.startColumn, m.endLineNumber, m.endColumn) }),
        },
      },
      el('td.' + cls, { text: icon }),
      el('td', { text: m.code ?? '' }),
      el('td', { text: m.message.split('\n')[0] }),
      el('td', { text: project }),
      el('td', { text: basename(m.path), title: relativePath(store.workspace?.path, m.path) }),
      el('td.num', { text: String(m.startLineNumber) }),
      );
      return row;
    }),
  );
  toggleButtons.error.lastChild.textContent = `${totals.errors} 個のエラー`;
  toggleButtons.warning.lastChild.textContent = `${totals.warnings} 個の警告`;
  toggleButtons.info.lastChild.textContent = `${totals.infos} 件のメッセージ`;
  problemsWindow?.setCount(totals.errors + totals.warnings);
  emit('problem-totals', totals);
}

function errorListView() {
  const toggle = (key, icon, cls) => {
    const button = el('button.filter-toggle.on', {
      on: { click: () => { errorFilter[key] = !errorFilter[key]; button.classList.toggle('on', errorFilter[key]); renderProblems(); } },
    }, el('span.' + cls, { text: icon }), el('span'));
    toggleButtons[key] = button;
    return button;
  };
  const scope = el('select', {},
    el('option', { value: 'all', text: 'ソリューション全体' }),
    el('option', { value: 'current', text: '現在のドキュメント' }),
  );
  scope.addEventListener('change', () => { errorFilter.scope = scope.value; renderProblems(); });
  const search = el('input', { type: 'search', placeholder: 'エラー一覧を検索', spellcheck: false });
  search.addEventListener('input', () => { errorFilter.text = search.value; renderProblems(); });
  return el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } },
    el('div.tw-toolbar', {},
      scope,
      toggle('error', '⊗', 'sev-error'),
      toggle('warning', '⚠', 'sev-warning'),
      toggle('info', 'ⓘ', 'sev-info'),
      el('span', { text: 'ビルド + IntelliSense', style: { color: 'var(--fg-muted)', margin: '0 8px' } }),
      el('span.grow'),
      search,
    ),
    el('div.grid-wrap', {}, errorTable),
  );
}

export function initPanels() {
  for (const id of ['right', 'bottom-left', 'bottom-right']) {
    groups.set(id, new ToolGroup(id));
    groups.get(id).render();
  }
  problemsWindow = addToolWindow({ id: 'problems', title: 'エラー一覧', content: errorListView() });
  addToolWindow({
    id: 'output',
    title: '出力',
    content: el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } },
      el('div.tw-toolbar', {}, el('span', { text: '出力元: Epoch / 言語サーバー', style: { color: 'var(--fg-muted)' } }), el('span.grow'),
        el('button.icon-btn', { title: 'すべてクリア', text: '⌫', on: { click: () => output.clear() } })),
      output.el,
    ),
  });
  let rendering = false;
  const schedule = () => {
    if (rendering) return;
    rendering = true;
    requestAnimationFrame(() => {
      rendering = false;
      renderProblems();
    });
  };
  monaco.editor.onDidChangeMarkers(schedule);
  subscribe('problems-changed', schedule);
  subscribe('active-doc', () => errorFilter.scope === 'current' && schedule());
  subscribe('log', ({ channel, text, time }) => {
    const stamp = time.toLocaleTimeString('ja-JP', { hour12: false });
    output.append(`[${stamp}] ${channel}: ${text}\n`, channel === 'エラー' ? 'stderr' : undefined);
  });
  renderProblems();
}

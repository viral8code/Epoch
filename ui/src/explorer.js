// The file explorer: a lazily loaded tree of the open folder. New files, folders, rename and
// delete (to the trash) go through the backend, which keeps them inside the folder.
import { monaco } from './monaco.js';
import { call, errorText } from './ipc.js';
import { store, emit, subscribe } from './store.js';
import { el, notify, showMenu, prompt, confirm, pathKey, joinPath, dirname, relativePath } from './ui.js';
import { openFile, forgetPath, activeDoc } from './editors.js';
import { allDocs, findDoc, rebind } from './documents.js';

const tree = el('div.tree', { tabindex: 0, role: 'tree' });
let root = null;
let selected = null;
const nodes = new Map();

function node(entry, depth) {
  const key = pathKey(entry.path);
  let n = nodes.get(key);
  if (!n) {
    n = { ...entry, depth, expanded: false, children: null };
    nodes.set(key, n);
  } else {
    Object.assign(n, entry, { depth });
  }
  return n;
}

async function load(n) {
  try {
    const entries = await call('list_dir', { path: n.path });
    n.children = entries.map((e) => node(e, n.depth + 1));
  } catch (error) {
    n.children = [];
    notify(`${n.name} を読み込めませんでした。\n${errorText(error)}`, 'error');
  }
}

function visible() {
  const out = [];
  const walk = (n) => {
    for (const child of n.children ?? []) {
      out.push(child);
      if (child.isDir && child.expanded) walk(child);
    }
  };
  if (root) walk(root);
  return out;
}

function fileState() {
  const dirty = new Set(allDocs().filter((d) => d.dirty && d.path).map((d) => pathKey(d.path)));
  const errors = new Set();
  for (const m of monaco.editor.getModelMarkers({})) {
    if (m.severity === monaco.MarkerSeverity.Error && m.resource.scheme === 'file') errors.add(pathKey(m.resource.fsPath));
  }
  return { dirty, errors };
}

export function renderExplorer() {
  if (!root) {
    tree.replaceChildren(
      el('div.empty', {},
        el('div', { text: 'フォルダーが開かれていません。' }),
        el('button.btn.primary', { text: 'フォルダーを開く', on: { click: () => emit('command', 'file.openFolder') } }),
      ),
    );
    return;
  }
  const { dirty, errors } = fileState();
  if (filterText) {
    renderFiltered(dirty);
    return;
  }
  const project = store.workspace?.project;
  const header = [
    el('div.row', { style: { paddingLeft: '4px' }, title: store.workspace?.path ?? '' },
      el('span.twisty', { text: '' }),
      el('span.icon.ficon-sln', { text: '▣' }),
      el('span.label', { text: `ソリューション '${root.name}' (1/1 のプロジェクト)` }),
    ),
    el('div.row.bold', { style: { paddingLeft: '16px' }, title: project ? 'rewind.toml のプロジェクト' : '単独ファイルのフォルダー' },
      el('span.twisty', { text: '▾' }),
      el('span.icon.ficon-proj', { text: 'R' }),
      el('span.label', { text: root.name }),
      el('span.desc', { text: project?.language ? `(REWIND ${project.language})` : '(REWIND)' }),
    ),
  ];
  const rows = visible().map((n) => {
    const key = pathKey(n.path);
    const hasError = errors.has(key) || (n.isDir && [...errors].some((e) => e.startsWith(key + '\\') || e.startsWith(key + '/')));
    const row = el(
      'div.row' + (n === selected ? '.selected' : '') + (dirty.has(key) ? '.modified' : '') + (hasError ? '.has-error' : '') + (n.name.startsWith('.') ? '.dim' : ''),
      {
        role: 'treeitem',
        'aria-expanded': n.isDir ? String(n.expanded) : undefined,
        title: relativePath(store.workspace?.path, n.path),
        style: { paddingLeft: `${28 + (n.depth - 1) * 14}px` },
        on: {
          click: () => activate(n, false),
          dblclick: () => !n.isDir && openFile(n.path),
          contextmenu: (e) => {
            e.preventDefault();
            select(n);
            contextMenu(n, e);
          },
        },
      },
      el('span.twisty', { text: n.isDir ? (n.expanded ? '▾' : '▸') : '' }),
      iconFor(n),
      el('span.label', { text: n.name + (n.isSymlink ? ' ↗' : '') }),
    );
    return row;
  });
  tree.replaceChildren(...header, ...rows);
  tree.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' });
}

function iconFor(n) {
  const name = n.name;
  const [cls, text] = n.isDir
    ? ['ficon-dir', n.expanded ? '▭' : '▬']
    : /\.rw$/i.test(name) ? ['ficon-rw', '◆']
    : /\.rwc$/i.test(name) ? ['ficon-rw', '◇']
    : /^rewind\.(toml|lock)$/i.test(name) ? ['ficon-cfg', '⚙']
    : /\.(json|toml)$/i.test(name) ? ['ficon-json', '{}']
    : /\.md$/i.test(name) ? ['ficon-md', '¶']
    : ['ficon-cfg', '▤'];
  return el('span.icon.' + cls, { text });
}

// Search box of the Solution Explorer: a flat list of matching files.
let filterText = '';
let fileCache = null;

async function renderFiltered(dirty) {
  const query = filterText;
  if (!fileCache) {
    try {
      fileCache = await call('list_workspace_files');
    } catch {
      fileCache = [];
    }
  }
  if (query !== filterText) return;
  const lower = query.toLowerCase();
  const matches = fileCache.filter((f) => f.toLowerCase().includes(lower)).slice(0, 500);
  tree.replaceChildren(
    ...(matches.length
      ? matches.map((rel) => {
          const path = joinPath(root.path, rel);
          const name = rel.split(/[\/]/).pop();
          return el('div.row' + (dirty.has(pathKey(path)) ? '.modified' : ''), {
            style: { paddingLeft: '8px' },
            title: rel,
            on: { click: () => openFile(path, { focus: false }), dblclick: () => openFile(path) },
          }, iconFor({ name }), el('span.label', { text: name }), el('span.desc', { text: rel }));
        })
      : [el('div.empty', { text: '一致するファイルはありません。' })]),
  );
}

export const explorerSearch = el('input', { type: 'search', placeholder: 'ソリューション エクスプローラーの検索 (Ctrl+;)', spellcheck: false, style: { width: '100%' } });
explorerSearch.addEventListener('input', () => {
  filterText = explorerSearch.value.trim();
  if (!filterText) fileCache = null;
  renderExplorer();
});

function select(n) {
  selected = n;
  renderExplorer();
}

async function activate(n, keyboard) {
  selected = n;
  if (n.isDir) {
    n.expanded = !n.expanded;
    if (n.expanded && !n.children) await load(n);
    renderExplorer();
  } else {
    renderExplorer();
    await openFile(n.path, { focus: !keyboard });
  }
}

async function refresh() {
  if (!root) return;
  const reload = async (n) => {
    if (!n.children) return;
    await load(n);
    for (const child of n.children) if (child.isDir && child.expanded) await reload(child);
  };
  await reload(root);
  renderExplorer();
}

function targetDir(n) {
  if (!n) return root?.path;
  return n.isDir ? n.path : dirname(n.path);
}

const nameError = (v) => (!v.trim() ? '名前を入力してください' : /[<>:"/\\|?*]/.test(v) ? '使えない文字があります' : '');

export async function newFile(n = selected) {
  if (!root) return;
  const dir = targetDir(n);
  const name = await prompt('新しいファイル', { value: '.rw', select: [0, 0], validate: nameError });
  if (!name) return;
  try {
    const path = await call('create_file', { dir, name });
    await expandTo(path);
    await openFile(path);
  } catch (error) {
    notify(errorText(error), 'error');
  }
}

export async function newFolder(n = selected) {
  if (!root) return;
  const name = await prompt('新しいフォルダー', { validate: nameError });
  if (!name) return;
  try {
    const path = await call('create_dir', { dir: targetDir(n), name });
    await expandTo(path);
  } catch (error) {
    notify(errorText(error), 'error');
  }
}

async function rename(n) {
  const dot = n.isDir ? n.name.length : n.name.lastIndexOf('.');
  const name = await prompt('名前の変更', { value: n.name, select: [0, dot > 0 ? dot : n.name.length], validate: nameError });
  if (!name || name === n.name) return;
  try {
    const newPath = await call('rename_path', { path: n.path, newName: name });
    const oldKey = pathKey(n.path);
    for (const doc of allDocs()) {
      if (!doc.path) continue;
      const key = pathKey(doc.path);
      if (key === oldKey) rebind(doc, newPath);
      else if (key.startsWith(oldKey + '\\') || key.startsWith(oldKey + '/')) rebind(doc, newPath + doc.path.slice(n.path.length));
    }
    nodes.delete(oldKey);
    await refresh();
    await expandTo(newPath);
  } catch (error) {
    notify(errorText(error), 'error');
  }
}

async function remove(n) {
  const ok = await confirm(`${n.name} をごみ箱へ移動しますか?`, n.isDir ? 'フォルダーの中身もすべて移動します。' : '', 'ごみ箱へ移動');
  if (!ok) return;
  try {
    await call('delete_path', { path: n.path });
    forgetPath(n.path);
    nodes.delete(pathKey(n.path));
    if (selected === n) selected = null;
    await refresh();
  } catch (error) {
    notify(errorText(error), 'error');
  }
}

function contextMenu(n, e) {
  const isRw = !n.isDir && /\.rw$/i.test(n.name);
  showMenu(
    [
      { label: '新しいファイル…', action: () => newFile(n) },
      { label: '新しいフォルダー…', action: () => newFolder(n) },
      '-',
      ...(isRw ? [{ label: '開く', action: () => openFile(n.path) }, { label: '右に分割して開く', action: async () => { await openFile(n.path); emit('command', 'view.splitRight'); } }, '-'] : []),
      { label: '名前の変更…', key: 'F2', action: () => rename(n) },
      { label: 'ごみ箱へ移動', key: 'Delete', action: () => remove(n) },
      '-',
      { label: 'パスをコピー', action: () => navigator.clipboard.writeText(n.path) },
      { label: '相対パスをコピー', action: () => navigator.clipboard.writeText(relativePath(store.workspace?.path, n.path)) },
      { label: 'エクスプローラーで表示', action: () => call('reveal_path', { path: n.path }).catch((err) => notify(errorText(err), 'error')) },
    ],
    { x: e.clientX, y: e.clientY },
  );
}

/** Expands the folders above `path` and selects it. */
export async function expandTo(path) {
  if (!root) return;
  const rel = relativePath(root.path, path);
  if (rel === path) return;
  let n = root;
  if (!n.children) await load(n);
  for (const part of rel.split(/[\\/]/)) {
    const child = n.children?.find((c) => pathKey(c.name) === pathKey(part) || c.name === part);
    if (!child) {
      await load(n);
      const again = n.children?.find((c) => c.name === part);
      if (!again) break;
      n = again;
    } else {
      n = child;
    }
    if (n.isDir) {
      n.expanded = true;
      if (!n.children) await load(n);
    }
  }
  selected = n;
  renderExplorer();
}

export async function setExplorerRoot(workspace) {
  nodes.clear();
  selected = null;
  if (!workspace) {
    root = null;
    renderExplorer();
    return;
  }
  root = { path: workspace.path, name: workspace.name, isDir: true, depth: 0, expanded: true, children: null };
  await load(root);
  renderExplorer();
}

export function collapseAll() {
  for (const n of nodes.values()) n.expanded = false;
  renderExplorer();
}

export function explorerView() {
  return el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } },
    el('div.tw-toolbar', {},
      el('button.icon-btn', { title: 'アクティブ ドキュメントと同期', text: '⇄', on: { click: () => { const d = activeDoc(); if (d?.path) expandTo(d.path); } } }),
      el('button.icon-btn', { title: '最新の情報に更新', text: '⟳', on: { click: refresh } }),
      el('button.icon-btn', { title: 'すべて折りたたむ', text: '⊟', on: { click: collapseAll } }),
      el('span', { style: { width: '1px', height: '16px', background: 'var(--border)', margin: '0 3px' } }),
      el('button.icon-btn', { title: '新しいファイル', text: '🗋', on: { click: () => newFile() } }),
      el('button.icon-btn', { title: '新しいフォルダー', text: '🗀', on: { click: () => newFolder() } }),
    ),
    el('div', { style: { padding: '3px 4px', borderBottom: '1px solid var(--border)' } }, explorerSearch),
    tree,
  );
}

export function initExplorer() {
  tree.addEventListener('keydown', (e) => {
    const list = visible();
    const index = list.indexOf(selected);
    if (e.key === 'ArrowDown') select(list[Math.min(index + 1, list.length - 1)] ?? list[0]);
    else if (e.key === 'ArrowUp') select(list[Math.max(index - 1, 0)] ?? list[0]);
    else if (e.key === 'ArrowRight' && selected?.isDir && !selected.expanded) activate(selected, true);
    else if (e.key === 'ArrowLeft' && selected?.isDir && selected.expanded) activate(selected, true);
    else if (e.key === 'ArrowLeft' && selected) {
      const parent = list.slice(0, index).reverse().find((n) => n.isDir && n.depth < selected.depth);
      if (parent) select(parent);
    } else if (e.key === 'Enter' && selected) activate(selected, true);
    else if (e.key === 'F2' && selected) rename(selected);
    else if (e.key === 'Delete' && selected) remove(selected);
    else return;
    e.preventDefault();
  });
  const rerender = () => requestAnimationFrame(renderExplorer);
  subscribe('doc-dirty', rerender);
  monaco.editor.onDidChangeMarkers(rerender);
  subscribe('active-doc', (doc) => {
    if (doc?.path && store.workspace && findDoc(doc.path) === activeDoc()) expandTo(doc.path);
  });
  window.addEventListener('focus', () => refresh());
  renderExplorer();
}

export const explorerActions = () => [
  el('button.icon-btn', { title: '新しいファイル', text: '＋', on: { click: () => newFile() } }),
  el('button.icon-btn', { title: '新しいフォルダー', text: '⊞', on: { click: () => newFolder() } }),
  el('button.icon-btn', { title: '最新の情報に更新', text: '⟳', on: { click: refresh } }),
  el('button.icon-btn', { title: 'すべて折りたたむ', text: '⊟', on: { click: collapseAll } }),
];

export { joinPath };

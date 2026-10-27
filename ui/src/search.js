// Find and replace across the workspace. The search itself runs in Rust and streams results.
import { monaco } from './monaco.js';
import { call, on, errorText } from './ipc.js';
import { store } from './store.js';
import { el, notify, confirm, relativePath, basename } from './ui.js';
import { openFile } from './editors.js';
import { allDocs, findDoc, reloadDoc } from './documents.js';

const query = el('input', { placeholder: '検索', spellcheck: false });
const replacement = el('input', { placeholder: '置換', spellcheck: false });
const include = el('input', { placeholder: '対象のファイル（例: *.rw, src/**）', spellcheck: false });
const summary = el('div.search-summary');
const results = el('div.tree', { tabindex: 0 });
const toggles = { caseSensitive: false, wholeWord: false, regex: false };
let generation = 0;
let files = [];
let rendering = false;

function toggle(key, text) {
  const box = el('input', { type: 'checkbox' });
  box.addEventListener('change', () => {
    toggles[key] = box.checked;
    run();
  });
  return el('label', {}, box, text);
}

function currentQuery() {
  return {
    pattern: query.value,
    regex: toggles.regex,
    caseSensitive: toggles.caseSensitive,
    wholeWord: toggles.wholeWord,
    include: include.value.trim(),
  };
}

let timer = null;
function run() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    files = [];
    render();
    if (!query.value || !store.workspace) {
      summary.textContent = store.workspace ? '' : 'フォルダーを開くと検索できます。';
      generation = 0;
      return;
    }
    summary.textContent = '検索中…';
    try {
      generation = await call('search_start', { query: currentQuery() });
    } catch (error) {
      summary.textContent = errorText(error);
    }
  }, 200);
}

function scheduleRender() {
  if (rendering) return;
  rendering = true;
  requestAnimationFrame(() => {
    rendering = false;
    render();
  });
}

function highlight(preview, start, end) {
  const s = Math.max(0, start - 40);
  return el('span.label', {},
    (s > 0 ? '…' : '') + preview.slice(s, start).trimStart(),
    el('mark', { text: preview.slice(start, end) }),
    preview.slice(end, end + 120),
  );
}

function render() {
  const rows = [];
  for (const file of files) {
    rows.push(
      el('div.row', { style: { paddingLeft: '8px' }, title: file.path },
        el('span.twisty', { text: '▾' }),
        el('span.label', { text: basename(file.path) }),
        el('span.desc', { text: relativePath(store.workspace?.path, file.path) }),
        el('span.trail', { text: String(file.matches.length) }),
      ),
    );
    for (const m of file.matches.slice(0, 500)) {
      // Columns are UTF-16 (1-based), which is also how JS indexes strings.
      rows.push(
        el('div.row', {
          style: { paddingLeft: '30px' },
          on: { click: () => openFile(file.path, { selection: new monaco.Range(m.line, m.column, m.line, m.endColumn) }) },
        },
        highlight(m.preview, m.column - 1, m.endColumn - 1),
        el('span.trail', { text: String(m.line) }),
        ),
      );
    }
  }
  results.replaceChildren(...rows);
}

async function replaceAll() {
  if (!files.length || !query.value) return;
  const count = files.reduce((n, f) => n + f.matches.length, 0);
  const ok = await confirm(
    '置換',
    `${files.length} 個のファイルの ${count} 箇所を「${replacement.value}」に置き換えます。\n開いているファイルは編集中の内容に置換し、保存はしません。`,
    'すべて置換',
  );
  if (!ok) return;
  const q = currentQuery();
  const open = files.filter((f) => findDoc(f.path));
  const closed = files.filter((f) => !findDoc(f.path)).map((f) => f.path);
  let replaced = 0;
  try {
    // Open files: edit the model, so the change can be undone and is saved by the user.
    for (const f of open) {
      const doc = findDoc(f.path);
      const matches = doc.model.findMatches(q.pattern, false, q.regex, q.caseSensitive, q.wholeWord ? '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/? \t' : null, true);
      doc.model.pushEditOperations([], matches.map((m) => ({
        range: m.range,
        text: q.regex ? replacementFor(m.matches) : replacement.value,
      })), () => null);
      replaced += matches.length;
    }
    if (closed.length) {
      replaced += await call('search_replace', { query: q, replacement: replacement.value, paths: closed });
    }
    notify(`${replaced} 箇所を置換しました。`, 'success');
  } catch (error) {
    notify(`置換できませんでした。\n${errorText(error)}`, 'error');
  }
  for (const doc of allDocs()) if (!doc.dirty && closed.includes(doc.path)) await reloadDoc(doc);
  run();
}

function replacementFor(groups) {
  return replacement.value.replace(/\$(\d+|\$)/g, (whole, g) => (g === '$' ? '$' : groups?.[Number(g)] ?? whole));
}

/** The "フォルダーを指定して検索/置換" form and its results, as one tool window. */
export function searchView() {
  return el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } },
    el('div.search-form', {},
      el('label', { text: '検索する文字列:' }), query, el('button.btn.primary', { text: 'すべて検索', on: { click: run } }),
      el('label', { text: '置換後の文字列:' }), replacement, el('button.btn', { text: 'すべて置換', on: { click: replaceAll } }),
      el('label', { text: 'ファイルの種類:' }), include, el('span'),
      el('span'),
      el('div.opts', {},
        toggle('caseSensitive', '大文字と小文字を区別する'),
        toggle('wholeWord', '単語単位で検索する'),
        toggle('regex', '正規表現を使用する'),
      ),
    ),
    summary,
    results,
  );
}

export function focusSearch(text) {
  if (text) query.value = text;
  query.focus();
  query.select();
  if (text) run();
}

export function initSearch() {
  query.addEventListener('input', run);
  include.addEventListener('input', run);
  query.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  on('search-result', ({ generation: g, path, matches }) => {
    if (g !== generation) return;
    files.push({ path, matches });
    scheduleRender();
  });
  on('search-done', ({ generation: g, total, files: searched, limited }) => {
    if (g !== generation) return;
    summary.textContent = `${files.length} 個のファイルで ${total} 件${limited ? '（上限に達しました）' : ''}・${searched} 個を検索`;
    scheduleRender();
  });
}

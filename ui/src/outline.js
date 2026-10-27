// The outline of the active file, and the symbol path shown in the breadcrumbs.
import { monaco } from './monaco.js';
import { subscribe } from './store.js';
import { el, debounce } from './ui.js';
import { activeDoc, activeEditor, activeGroupObject } from './editors.js';
import { documentSymbols } from './lsp.js';

const list = el('div.tree', { tabindex: 0 });
let symbols = [];
let forDoc = null;

const K = monaco.languages.SymbolKind;
const ICON = {
  [K.Function]: ['ƒ', 'var(--info)'],
  [K.Method]: ['ƒ', 'var(--accent)'],
  [K.Struct]: ['S', 'var(--warning)'],
  [K.Class]: ['I', 'var(--warning)'],
  [K.Enum]: ['E', 'var(--warning)'],
  [K.Interface]: ['T', 'var(--ok)'],
  [K.Constant]: ['C', 'var(--history)'],
  [K.TypeParameter]: ['τ', 'var(--ok)'],
};
const KIND_NAME = {
  [K.Function]: '関数', [K.Method]: 'メソッド', [K.Struct]: '構造体', [K.Class]: 'impl', [K.Enum]: '列挙型',
  [K.Interface]: 'trait', [K.Constant]: '定数', [K.TypeParameter]: '型',
};

function flatten(items, depth = 0, out = []) {
  for (const s of items) {
    out.push({ ...s, depth });
    flatten(s.children ?? [], depth + 1, out);
  }
  return out;
}

function containing(items, position, path = []) {
  for (const s of items) {
    if (monaco.Range.containsPosition(s.range, position)) {
      path.push(s);
      return containing(s.children ?? [], position, path);
    }
  }
  return path;
}

function render() {
  const doc = activeDoc();
  if (!doc) {
    list.replaceChildren(el('div.empty', { text: 'ファイルが開かれていません。' }));
    return;
  }
  const flat = flatten(symbols);
  if (!flat.length) {
    list.replaceChildren(el('div.empty', { text: '宣言は見つかりませんでした。' }));
    return;
  }
  const position = activeEditor()?.getPosition();
  const here = position ? containing(symbols, position) : [];
  const current = here[here.length - 1];
  list.replaceChildren(
    ...flat.map((s) => {
      const [icon, color] = ICON[s.kind] ?? ['·', 'var(--fg-muted)'];
      return el('div.row' + (current && s.name === current.name && s.range.startLineNumber === current.range.startLineNumber ? '.selected' : ''), {
        style: { paddingLeft: `${10 + s.depth * 14}px` },
        on: {
          click: () => {
            const editor = activeEditor();
            editor?.setSelection(s.selectionRange);
            editor?.revealRangeInCenterIfOutsideViewport(s.selectionRange);
            editor?.focus();
          },
        },
      },
      el('span.icon', { text: icon, style: { color, fontWeight: '700' } }),
      el('span.label', { text: s.name }),
      el('span.desc', { text: KIND_NAME[s.kind] ?? '' }),
      el('span.trail', { text: String(s.selectionRange.startLineNumber) }),
      );
    }),
  );
}

const refresh = debounce(async () => {
  const doc = activeDoc();
  forDoc = doc;
  if (!doc) {
    symbols = [];
    render();
    return;
  }
  const result = await documentSymbols(doc).catch(() => []);
  if (forDoc !== doc) return;
  symbols = result ?? [];
  render();
  updateCrumbs();
}, 300);

function updateCrumbs() {
  const group = activeGroupObject();
  const editor = activeEditor();
  if (!group || !editor || group.active !== forDoc) return;
  const position = editor.getPosition();
  group.renderCrumbs(position ? containing(symbols, position) : [], symbols);
}

export function outlineView() {
  refresh();
  return list;
}

export function initOutline() {
  subscribe('active-doc', () => refresh());
  subscribe('doc-changed', ({ doc }) => {
    if (doc === activeDoc()) refresh();
  });
  subscribe('cursor', debounce(() => {
    updateCrumbs();
    render();
  }, 100));
}

// Editor groups: up to two side-by-side groups, each a Monaco editor with its own tabs.
import { monaco } from './monaco.js';
import { store, emit, subscribe } from './store.js';
import { allDocs, confirmDiscard, disposeDoc, loadDoc, saveDoc } from './documents.js';
import { el, notify, showMenu, relativePath, basename, pathKey } from './ui.js';
import { call, errorText } from './ipc.js';
import { monacoTheme } from './rewind-lang.js';
import { clearToolFocus } from './panels.js';

const area = () => document.getElementById('editor-area');
const groups = [];
let activeGroup = null;
let welcome = null;

export function editorOptions() {
  const s = store.settings;
  return {
    theme: monacoTheme(s.theme),
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight || 0,
    wordWrap: s.wordWrap ? 'on' : 'off',
    minimap: { enabled: s.minimap },
    renderWhitespace: s.renderWhitespace ? 'all' : 'selection',
    glyphMargin: true,
    automaticLayout: true,
    fixedOverflowWidgets: true,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    mouseWheelZoom: true,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    stickyScroll: { enabled: true },
    renderLineHighlight: 'line',
    // Outlining +/- boxes are always visible, as in Visual Studio.
    showFoldingControls: 'always',
    folding: true,
    linkedEditing: true,
    // Invisible and bidirectional characters stay highlighted ("trojan source"); Japanese text
    // is common in REWIND sources, so look-alike characters are not.
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: true, nonBasicASCII: false },
    'semanticHighlighting.enabled': false,
    suggest: { showWords: true, preview: true },
    quickSuggestions: { other: true, comments: false, strings: false },
    parameterHints: { enabled: true },
    hover: { delay: 350 },
    links: false,
    padding: { top: 4 },
  };
}

class Group {
  constructor() {
    this.tabs = [];
    this.active = null;
    this.viewStates = new Map();
    this.el = el('div.group');
    this.tabsEl = el('div.tabs', { role: 'tablist' });
    this.crumbsEl = el('div.navbar');
    this.host = el('div.editor-host');
    const wellMenu = el('button.icon-btn.well-menu', { title: '開いているドキュメントの一覧', text: '▾', on: { click: (e) => this.documentList(e) } });
    this.el.append(
      el('div.tabs-row', {}, this.tabsEl, wellMenu),
      el('div.doc-frame', {}, this.crumbsEl, this.host),
    );
    this.navScope = el('select', { title: 'スコープ' });
    this.navMember = el('select', { title: 'メンバー' });
    this.navProject = el('select', { title: 'プロジェクト', disabled: true });
    this.navScope.addEventListener('change', () => this.navigate(this.navScope));
    this.navMember.addEventListener('change', () => this.navigate(this.navMember));
    this.crumbsEl.append(this.navProject, this.navScope, this.navMember);
    this.editor = monaco.editor.create(this.host, { ...editorOptions(), model: null });
    this.editor.onDidFocusEditorWidget(() => setActiveGroup(this));
    this.editor.onDidChangeCursorPosition(() => emit('cursor', this));
    this.editor.onDidChangeCursorSelection(() => emit('cursor', this));
    this.el.addEventListener('mousedown', () => setActiveGroup(this), true);
    this.tabsEl.addEventListener('dblclick', (e) => {
      if (e.target === this.tabsEl) emit('command', 'file.new');
    });
    emit('editor-created', this.editor);
  }

  show(doc, { focus = true, selection } = {}) {
    if (!this.tabs.includes(doc)) {
      const index = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
      this.tabs.splice(index, 0, doc);
    }
    if (this.active !== doc) {
      if (this.active) this.viewStates.set(this.active, this.editor.saveViewState());
      this.active = doc;
      this.editor.setModel(doc.model);
      this.editor.updateOptions({ readOnly: doc.readOnly });
      const state = this.viewStates.get(doc);
      if (state) this.editor.restoreViewState(state);
    }
    if (selection) reveal(this.editor, selection);
    this.render();
    if (focus) this.editor.focus();
    setActiveGroup(this);
    emit('active-doc', doc);
  }

  remove(doc) {
    const index = this.tabs.indexOf(doc);
    if (index < 0) return;
    this.tabs.splice(index, 1);
    this.viewStates.delete(doc);
    if (this.active === doc) {
      this.active = null;
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      if (next) this.show(next, { focus: this === activeGroup });
      else this.editor.setModel(null);
    }
    this.render();
    if (!this.tabs.length && groups.length > 1) closeGroup(this);
    refreshWelcome();
    emit('active-doc', activeDoc());
  }

  render() {
    const markers = problemCounts();
    this.tabsEl.replaceChildren(
      ...this.tabs.map((doc) => {
        const sameName = allTabs().filter((d) => d !== doc && d.name === doc.name);
        const dir = sameName.length && doc.path ? relativePath(store.workspace?.path, doc.path).split(/[\\/]/).slice(-2, -1)[0] : '';
        const errors = markers.get(doc.uri.toString()) ?? 0;
        const tab = el(
          'div.doc-tab' + (doc === this.active ? '.active' : '') + (doc.dirty ? '.dirty' : ''),
          {
            role: 'tab',
            title: doc.path ?? doc.name,
            draggable: true,
            on: {
              mousedown: (e) => {
                if (e.button === 0) this.show(doc);
              },
              auxclick: (e) => {
                if (e.button === 1) closeTab(this, doc);
              },
              contextmenu: (e) => {
                e.preventDefault();
                tabMenu(this, doc, e);
              },
              dragstart: (e) => {
                e.dataTransfer.setData('text/x-epoch-tab', doc.key);
                dragging = { group: this, doc };
              },
              dragover: (e) => {
                if (dragging) {
                  e.preventDefault();
                  tab.classList.add('drop-target');
                }
              },
              dragleave: () => tab.classList.remove('drop-target'),
              drop: (e) => {
                e.preventDefault();
                tab.classList.remove('drop-target');
                if (dragging) moveTab(dragging.group, dragging.doc, this, this.tabs.indexOf(doc));
                dragging = null;
              },
            },
          },
          // Visual Studio marks unsaved documents with an asterisk after the name.
          el('span.name', { text: doc.name + (doc.dirty ? '*' : '') + (doc.readOnly ? ' 🔒' : '') }),
          dir ? el('span.dir', { text: dir }) : null,
          errors ? el('span.problems', { text: `⊗${errors}` }) : null,
          el('button.close', {
            title: '閉じる (Ctrl+F4)',
            text: '✕',
            on: {
              mousedown: (e) => e.stopPropagation(),
              click: (e) => {
                e.stopPropagation();
                closeTab(this, doc);
              },
            },
          }),
        );
        return tab;
      }),
    );
    this.tabsEl.querySelector('.doc-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.renderCrumbs();
  }

  documentList(e) {
    showMenu(
      [...this.tabs].sort((a, b) => a.name.localeCompare(b.name, 'ja')).map((doc) => ({
        label: doc.name + (doc.dirty ? '*' : ''),
        checked: doc === this.active,
        action: () => this.show(doc),
      })),
      { x: e.clientX - 200, y: e.clientY + 8 },
    );
  }

  /**
   * The navigation bar: project, scope (impl / trait / struct / enum, or the file itself) and
   * member, following the cursor. `symbols` is the outline of the active document.
   */
  renderCrumbs(symbolPath = this.symbolPath ?? [], symbols = this.symbols ?? []) {
    this.symbolPath = symbolPath;
    this.symbols = symbols;
    const doc = this.active;
    const option = (text, value) => el('option', { text, value });
    this.navProject.replaceChildren(option(store.workspace?.name ?? 'その他のファイル', ''));
    if (!doc) {
      this.navScope.replaceChildren();
      this.navMember.replaceChildren();
      return;
    }
    const containers = symbols.filter((s) => s.children?.length || [monaco.languages.SymbolKind.Class, monaco.languages.SymbolKind.Interface, monaco.languages.SymbolKind.Struct, monaco.languages.SymbolKind.Enum].includes(s.kind));
    this.navTargets = new Map();
    const scopeOptions = [option(`${doc.name}（グローバル）`, 'global')];
    containers.forEach((s, i) => {
      this.navTargets.set(`s${i}`, s);
      scopeOptions.push(option(s.name, `s${i}`));
    });
    this.navScope.replaceChildren(...scopeOptions);
    const scope = containers.find((s) => symbolPath.includes(s));
    this.navScope.value = scope ? `s${containers.indexOf(scope)}` : 'global';
    const members = scope ? scope.children ?? [] : symbols.filter((s) => !containers.includes(s));
    const memberOptions = [option('', '')];
    members.forEach((s, i) => {
      this.navTargets.set(`m${i}`, s);
      memberOptions.push(option(s.name, `m${i}`));
    });
    this.navMember.replaceChildren(...memberOptions);
    const member = members.find((s) => symbolPath.includes(s));
    this.navMember.value = member ? `m${members.indexOf(member)}` : '';
  }

  navigate(select) {
    const target = this.navTargets?.get(select.value);
    if (!target) return;
    this.editor.setSelection(target.selectionRange);
    this.editor.revealRangeInCenterIfOutsideViewport(target.selectionRange);
    this.editor.focus();
  }
}

let dragging = null;

function reveal(editor, selection) {
  const range = 'startLineNumber' in selection
    ? selection
    : new monaco.Range(selection.lineNumber, selection.column, selection.lineNumber, selection.column);
  editor.setSelection(range);
  editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth);
}

function allTabs() {
  return groups.flatMap((g) => g.tabs);
}

function problemCounts() {
  const counts = new Map();
  for (const marker of monaco.editor.getModelMarkers({})) {
    if (marker.severity !== monaco.MarkerSeverity.Error) continue;
    const key = marker.resource.toString();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function setActiveGroup(group) {
  // The focused document's tab takes the accent colour, as in Visual Studio.
  groups.forEach((g) => g.el.classList.toggle('focused', g === group));
  clearToolFocus();
  if (activeGroup === group) return;
  activeGroup = group;
  emit('active-doc', activeDoc());
  emit('cursor', group);
}

function closeGroup(group) {
  const index = groups.indexOf(group);
  if (index < 0 || groups.length === 1) return;
  for (const doc of group.tabs) {
    if (!groups[index === 0 ? 1 : 0].tabs.includes(doc)) groups[index === 0 ? 1 : 0].tabs.push(doc);
  }
  groups.splice(index, 1);
  group.editor.dispose();
  group.el.remove();
  activeGroup = null;
  setActiveGroup(groups[0]);
  groups[0].render();
}

function moveTab(fromGroup, doc, toGroup, index) {
  if (fromGroup === toGroup) {
    const tabs = fromGroup.tabs;
    tabs.splice(tabs.indexOf(doc), 1);
    tabs.splice(index < 0 ? tabs.length : index, 0, doc);
    fromGroup.render();
    return;
  }
  toGroup.show(doc);
  fromGroup.remove(doc);
}

function tabMenu(group, doc, event) {
  const others = group.tabs.filter((d) => d !== doc);
  const right = group.tabs.slice(group.tabs.indexOf(doc) + 1);
  showMenu(
    [
      { label: '閉じる', key: 'Ctrl+W', action: () => closeTab(group, doc) },
      { label: 'ほかのタブを閉じる', disabled: !others.length, action: () => closeTabs(group, others) },
      { label: '右側のタブを閉じる', disabled: !right.length, action: () => closeTabs(group, right) },
      { label: '保存済みのタブを閉じる', action: () => closeTabs(group, group.tabs.filter((d) => !d.dirty)) },
      { label: 'すべて閉じる', action: () => closeTabs(group, [...group.tabs]) },
      '-',
      { label: '右に分割', key: 'Ctrl+\\', action: () => splitRight(doc) },
      '-',
      { label: 'パスをコピー', disabled: !doc.path, action: () => navigator.clipboard.writeText(doc.path) },
      {
        label: '相対パスをコピー',
        disabled: !doc.path,
        action: () => navigator.clipboard.writeText(relativePath(store.workspace?.path, doc.path)),
      },
      {
        label: 'エクスプローラーで表示',
        disabled: !doc.path,
        action: () => call('reveal_path', { path: doc.path }).catch((e) => notify(errorText(e), 'error')),
      },
    ],
    { x: event.clientX, y: event.clientY },
  );
}

function refreshWelcome() {
  const empty = groups.every((g) => !g.active);
  welcome.hidden = !empty;
}

function maybeDispose(doc) {
  if (!allTabs().includes(doc)) disposeDoc(doc);
}

export async function closeTab(group, doc) {
  const elsewhere = groups.some((g) => g !== group && g.tabs.includes(doc));
  if (!elsewhere && !(await confirmDiscard([doc]))) return false;
  group.remove(doc);
  maybeDispose(doc);
  return true;
}

export async function closeTabs(group, list) {
  const unique = list.filter((doc) => !groups.some((g) => g !== group && g.tabs.includes(doc)));
  if (!(await confirmDiscard(unique))) return false;
  for (const doc of list) {
    group.remove(doc);
    maybeDispose(doc);
  }
  return true;
}

export async function closeAll() {
  if (!(await confirmDiscard(allDocs()))) return false;
  for (const group of [...groups]) {
    for (const doc of [...group.tabs]) group.remove(doc);
  }
  for (const doc of allDocs()) disposeDoc(doc);
  return true;
}

export function initEditors({ welcomeElement }) {
  welcome = welcomeElement;
  const group = new Group();
  groups.push(group);
  area().append(group.el, welcome);
  activeGroup = group;
  subscribe('doc-dirty', (doc) => {
    for (const g of groups) if (g.tabs.includes(doc)) g.render();
    // A file changed by a rename in another file gets a tab, so it can be saved.
    if (doc.dirty && !allTabs().includes(doc)) {
      activeGroup.tabs.push(doc);
      activeGroup.render();
    }
  });
  subscribe('doc-rebound', ({ doc, oldModel }) => {
    for (const g of groups) {
      if (g.active === doc && g.editor.getModel() === oldModel) {
        const state = g.editor.saveViewState();
        g.editor.setModel(doc.model);
        if (state) g.editor.restoreViewState(state);
      }
      g.render();
    }
  });
  monaco.editor.onDidChangeMarkers(() => {
    for (const g of groups) g.render();
  });
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== 'file') return false;
      openFile(resource.fsPath, { selection: selectionOrPosition });
      return true;
    },
  });
  refreshWelcome();
}

export function splitRight(doc = activeDoc()) {
  if (groups.length >= 2) {
    const other = groups.find((g) => g !== activeGroup);
    if (doc) other.show(doc);
    return;
  }
  const group = new Group();
  groups.push(group);
  area().insertBefore(group.el, welcome);
  groups.forEach((g) => g.el.classList.toggle('focused', g === group));
  if (doc) group.show(doc);
  else setActiveGroup(group);
}

export function focusActiveGroup() {
  if (activeGroup) setActiveGroup(activeGroup);
}

export function focusOtherGroup() {
  const other = groups.find((g) => g !== activeGroup);
  if (other) {
    setActiveGroup(other);
    other.editor.focus();
  }
}

/** Opens a file in the active group. `selection` is a Monaco range or position. */
export async function openFile(path, { selection, focus = true, group } = {}) {
  try {
    const doc = await loadDoc(path);
    (group ?? activeGroup).show(doc, { selection, focus });
    refreshWelcome();
    return doc;
  } catch (error) {
    notify(`${basename(path)} を開けませんでした。\n${errorText(error)}`, 'error');
    return null;
  }
}

export function showDoc(doc, options) {
  activeGroup.show(doc, options);
  refreshWelcome();
}

export function activeDoc() {
  return activeGroup?.active ?? null;
}

export function activeEditor() {
  return activeGroup?.editor ?? null;
}

export function activeGroupObject() {
  return activeGroup;
}

export function allGroups() {
  return groups;
}

export function openDocs() {
  const seen = new Set();
  return allTabs().filter((d) => (seen.has(d) ? false : seen.add(d)));
}

export function visibleEditorsFor(doc) {
  return groups.filter((g) => g.active === doc).map((g) => g.editor);
}

export function applySettingsToEditors() {
  const options = editorOptions();
  monaco.editor.setTheme(options.theme);
  for (const g of groups) g.editor.updateOptions(options);
  for (const doc of allDocs()) doc.applyOptions();
}

export function cycleTab(direction) {
  const g = activeGroup;
  if (!g?.tabs.length) return;
  const index = g.tabs.indexOf(g.active);
  g.show(g.tabs[(index + direction + g.tabs.length) % g.tabs.length]);
}

export async function closeActive() {
  const g = activeGroup;
  if (g?.active) await closeTab(g, g.active);
}

export async function saveActive(saveAs = false) {
  const doc = activeDoc();
  if (doc) await saveDoc(doc, { saveAs });
}

export async function saveAll() {
  for (const doc of allDocs()) if (doc.dirty) await saveDoc(doc);
}

/** Called after a file or folder was renamed or deleted in the explorer. */
export function forgetPath(path) {
  const key = pathKey(path);
  for (const doc of allDocs()) {
    if (!doc.path) continue;
    const docKey = pathKey(doc.path);
    if (docKey === key || docKey.startsWith(key + '\\') || docKey.startsWith(key + '/')) {
      doc.deleted = true;
      emit('doc-dirty', doc);
    }
  }
}

export function renderAllTabs() {
  for (const g of groups) g.render();
}

// The window, laid out like Visual Studio 2022/2026: menu bar with the feature search, the
// standard toolbar (Start ▶ / debug controls), the document well, tool windows docked right
// (Solution Explorer) and bottom (Error List, Output…), and the coloured status bar.
import { monaco } from './monaco.js';
import { call, on, errorText, setWindowTitle } from './ipc.js';
import { store, emit, subscribe } from './store.js';
import { el, makeSash, showMenu, closeMenu, notify, quickPick, fuzzy, debounce, basename, relativePath, joinPath } from './ui.js';
import { registerRewind, monacoTheme } from './rewind-lang.js';
import {
  initEditors, openFile, activeDoc, activeEditor, splitRight, focusOtherGroup, cycleTab, closeActive,
  saveActive, saveAll, closeAll, applySettingsToEditors, openDocs, showDoc,
} from './editors.js';
import { allDocs, checkExternalChanges, confirmDiscard, newUntitled, saveDoc } from './documents.js';
import { initPanels, togglePanel, showToolWindow, addToolWindow, problemTotals, toggleRightDock } from './panels.js';
import { initLsp, startLsp, stopLsp, lspStatus, documentSymbols } from './lsp.js';
import { initRun, runActive, checkActive, simpleTask, stopTask, isRunning, configureRun, checkOnSave, currentTask } from './run.js';
import {
  initDebug, startDebugging, stopDebugging, step, toggleBreakpointAtCursor, openTrace, debugSession, debugStateText,
  removeAllBreakpoints,
} from './debug.js';
import { initTimeline } from './timeline.js';
import { initExplorer, explorerView, setExplorerRoot, newFile, explorerSearch } from './explorer.js';
import { initSearch, searchView, focusSearch } from './search.js';
import { initOutline, outlineView } from './outline.js';
import { showOptions, saveSettingsPatch } from './settings-view.js';
import { register, run, initKeybindings, showPalette, menuItem, command } from './commands.js';

const $ = (id) => document.getElementById(id);

// Same drawing as icons/icon.png (scripts/make-icons.py): a counter-clockwise arrow, time going back.
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="13" fill="#4b4fc8"/><path d="M26.19 16.03A17 17 0 1 0 37.81 16.03" fill="none" stroke="#fff" stroke-width="3.6"/><path d="M30.67 13.43L40 10.01L35.63 22.04Z" fill="#fff"/><circle cx="32" cy="32" r="4.8" fill="#ffd166"/></svg>`;
const logo = () => el('img', { src: 'data:image/svg+xml,' + encodeURIComponent(LOGO_SVG), alt: '' });

let statusMessage = '準備完了';

function setStatusMessage(text) {
  statusMessage = text;
  renderStatus();
}

// Layout -----------------------------------------------------------------------------------

function buildLayout() {
  const right = $('right-dock');
  const bottom = $('bottom-dock');
  const bottomRight = $('tg-bottom-right');
  makeSash($('right-sash'), {
    axis: 'x',
    get: () => -right.getBoundingClientRect().width,
    set: (w) => { right.style.width = Math.max(180, Math.min(-w, innerWidth * 0.6)) + 'px'; },
  });
  makeSash($('bottom-sash'), {
    axis: 'y',
    get: () => -bottom.getBoundingClientRect().height,
    set: (h) => { bottom.style.height = Math.max(90, Math.min(-h, innerHeight * 0.75)) + 'px'; },
  });
  makeSash($('bottom-split-sash'), {
    axis: 'x',
    get: () => -bottomRight.getBoundingClientRect().width,
    set: (w) => { bottomRight.style.flex = `0 0 ${Math.max(160, Math.min(-w, bottom.clientWidth - 160))}px`; },
  });
  $('app-logo').append(logo());
  const search = el('div.box', { title: '機能とコマンドの検索 (Ctrl+Q)', on: { click: () => showPalette() } },
    el('span', { text: '🔍' }), el('span', { text: '検索' }), el('kbd', { text: 'Ctrl+Q' }));
  $('feature-search').append(search);
}

function buildWelcome() {
  const recent = el('div');
  const render = () => {
    const list = store.settings.recentWorkspaces ?? [];
    recent.replaceChildren(
      ...(list.length
        ? list.slice(0, 10).map((path) =>
          el('div.recent-item', { title: path, on: { click: () => openRecent(path) } },
            el('div.t', { text: basename(path) }), el('div.d', { text: path })))
        : [el('div', { text: '最近開いたフォルダーはありません。', style: { color: 'var(--fg-muted)' } })]),
    );
  };
  render();
  subscribe('settings-changed', render);
  subscribe('workspace-changed', render);
  const card = (glyph, title, detail, id) =>
    el('div.start-card', { on: { click: () => run(id) } },
      el('span.glyph', { text: glyph }),
      el('div', {}, el('div.t', { text: title }), el('div.d', { text: detail })));
  return el('div', { id: 'welcome' },
    el('div.welcome-inner', {},
      el('h1', {}, logo(), 'Epoch'),
      el('div.sub', { text: 'REWIND のための統合開発環境 — commit・revert・publish を、書いて、実行して、さかのぼる。' }),
      el('div', {}, el('h2', { text: '最近開いた項目' }), recent),
      el('div', {},
        el('h2', { text: '開始する' }),
        card('📂', 'フォルダーを開く', 'REWIND のプロジェクト（rewind.toml）や .rw ファイルのあるフォルダーを開きます', 'file.openFolder'),
        card('📄', '新しいファイル', '名前のない .rw ファイルを作成します', 'file.new'),
        card('⏺', '記録ファイル（trace）を開く', '記録した実行をデバッガーで開き、前後に移動して調べます', 'debug.openTrace'),
        card('⚙', 'オプション', 'rewind の場所、配色、エディターの設定', 'tools.options'),
      ),
    ),
  );
}

// Menus ------------------------------------------------------------------------------------

const MENUS = [
  ['ファイル(F)', ['file.new', 'file.open', 'file.openFolder', 'file.openRecent', 'debug.openTrace', '-', 'file.close', 'file.closeFolder', '-', 'file.save', 'file.saveAs', 'file.saveAll', '-', 'app.quit']],
  ['編集(E)', ['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.paste', '-', 'edit.find', 'edit.replace', 'search.inFiles', 'search.replaceInFiles', '-', 'nav.goToAll', 'editor.gotoLine', 'editor.gotoSymbol', '-', 'edit.format', 'edit.comment', 'edit.uncomment', 'edit.rename']],
  ['表示(V)', ['view.solutionExplorer', 'view.outline', 'view.errors', 'view.output', 'view.terminal', 'view.findResults', 'view.timeline', '-', 'nav.back', 'nav.forward', '-', 'view.palette', '-', 'view.zoomIn', 'view.zoomOut', '-', 'view.toggleRightDock', 'view.panel']],
  ['ビルド(B)', ['run.check', 'run.build', 'run.compile', 'run.doc']],
  ['デバッグ(D)', ['debug.start', 'run.run', 'run.stop', 'debug.restart', '-', 'debug.stepIn', 'debug.stepOver', 'debug.stepBack', 'debug.reverseContinue', '-', 'debug.toggleBreakpoint', 'debug.deleteBreakpoints', '-', 'view.breakpoints', 'view.locals', 'view.watch', 'view.callStack', 'view.immediate', '-', 'run.profile', 'run.configure']],
  ['テスト(S)', ['run.test', 'run.testFiltered']],
  ['ツール(T)', ['tools.options', 'help.restartLsp', 'help.toolchain']],
  ['ウィンドウ(W)', ['view.splitRight', 'view.focusOther', 'view.nextTab', 'view.prevTab', '-', 'window.closeAll', 'window.reset']],
  ['ヘルプ(H)', ['help.shortcuts', 'help.about']],
];

function buildMenus() {
  const bar = $('menubar');
  let open = null;
  const openMenu = (root, items) => {
    open = root;
    root.classList.add('open');
    const rect = root.getBoundingClientRect();
    showMenu(items.map((id) => (id === '-' ? '-' : menuItem(id))).filter(Boolean), { x: rect.left, y: rect.bottom }, () => {
      root.classList.remove('open');
      if (open === root) open = null;
    });
  };
  for (const [title, items] of MENUS) {
    const root = el('div.menu-root', { text: title });
    root.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (open === root) {
        closeMenu();
        return;
      }
      openMenu(root, items);
    });
    root.addEventListener('mouseenter', () => {
      if (open && open !== root) {
        closeMenu();
        openMenu(root, items);
      }
    });
    bar.append(root);
  }
}

// Standard toolbar -------------------------------------------------------------------------

function startTarget() {
  const doc = activeDoc();
  if (store.workspace?.project?.entry) return basename(store.workspace.project.entry);
  if (doc?.isRewind) return doc.name;
  return '起動対象なし';
}

function buildToolbar() {
  const bar = $('toolbar');
  const tb = (glyph, title, id, { label, cls = '', disabled } = {}) =>
    el('button.tb' + (cls ? '.' + cls : ''), {
      title,
      disabled: disabled ?? (command(id)?.enabled ? !command(id).enabled() : false),
      on: { click: () => run(id) },
    }, el('span.glyph', { text: glyph }), label ? el('span', { text: label }) : null);
  const sep = () => el('span.sep');
  const effects = el('select', { title: '許可する効果（--allow-effects）' },
    el('option', { value: '', text: '効果: 標準' }),
    el('option', { value: 'fileRead,fileWrite', text: '効果: ファイル' }),
    el('option', { value: 'fileRead,fileWrite,env,clock', text: '効果: ファイル・環境・時刻' }),
    el('option', { value: 'gui', text: '効果: GUI' }),
    el('option', { value: 'custom', text: '効果: カスタム…' }),
  );
  const render = () => {
    const debugging = debugSession().active;
    const running = isRunning();
    const current = store.settings.defaultEffects ?? '';
    effects.value = [...effects.options].some((o) => o.value === current) ? current : 'custom';
    if (effects.value === 'custom' && current) effects.options[4].text = `効果: ${current}`;
    const items = [
      tb('◀', '戻る (Ctrl+-)', 'nav.back', { disabled: !navHistory.canBack() }),
      tb('▶', '進む (Ctrl+Shift+-)', 'nav.forward', { disabled: !navHistory.canForward() }),
      sep(),
      tb('🗋', '新しいファイル (Ctrl+N)', 'file.new'),
      tb('📂', 'フォルダーを開く (Ctrl+Shift+Alt+O)', 'file.openFolder'),
      tb('💾', '保存 (Ctrl+S)', 'file.save'),
      tb('🗐', 'すべて保存 (Ctrl+Shift+S)', 'file.saveAll'),
      sep(),
      tb('↶', '元に戻す (Ctrl+Z)', 'edit.undo'),
      tb('↷', 'やり直し (Ctrl+Y)', 'edit.redo'),
      sep(),
      effects,
      sep(),
    ];
    if (!debugging) {
      items.push(
        tb('▶', `デバッグの開始 (F5)\n${startTarget()} を記録しながら実行し、デバッガーで開きます`, 'debug.start', { label: startTarget(), cls: 'start', disabled: running }),
        tb('▷', 'デバッグなしで開始 (Ctrl+F5)', 'run.run', { cls: 'start-plain', disabled: running }),
      );
      if (running) items.push(tb('■', '停止 (Shift+F5)', 'run.stop', { cls: 'stop', label: '停止' }));
      items.push(sep(), tb('✓', 'ソリューションのビルド = チェック (Ctrl+Shift+B)', 'run.check', { disabled: running }));
    } else {
      const s = debugSession();
      const can = s.stopped;
      items.push(
        tb('▶', '続行 (F5)', 'debug.start', { label: '続行', cls: 'start', disabled: !can || s.ended }),
        tb('■', 'デバッグの停止 (Shift+F5)', 'run.stop', { cls: 'stop', disabled: false }),
        tb('⟲', '再起動 (Ctrl+Shift+F5)', 'debug.restart', { disabled: false }),
        sep(),
        tb('⤓', 'ステップ イン (F11)', 'debug.stepIn', { disabled: !can || s.ended }),
        tb('⤼', 'ステップ オーバー (F10)', 'debug.stepOver', { disabled: !can || s.ended }),
        sep(),
        tb('⤺', 'ステップ バック (Alt+[)', 'debug.stepBack', { cls: 'rewind', disabled: !can }),
        tb('⏮', '逆方向に続行 (Alt+F5)', 'debug.reverseContinue', { cls: 'rewind', disabled: !can }),
        el('span.debug-state', { text: debugStateText() }),
      );
    }
    bar.replaceChildren(...items);
  };
  effects.addEventListener('change', async () => {
    let value = effects.value;
    if (value === 'custom') {
      await configureRun();
      render();
      return;
    }
    await saveSettingsPatch({ defaultEffects: value });
  });
  for (const event of ['task-state', 'debug-state', 'active-doc', 'workspace-changed', 'nav-changed', 'settings-changed']) subscribe(event, render);
  render();
}

// Navigation history (Ctrl+- / Ctrl+Shift+-) -------------------------------------------------

const navHistory = (() => {
  const back = [];
  const forward = [];
  let last = null;
  let moving = false;
  const here = () => {
    const doc = activeDoc();
    const position = activeEditor()?.getPosition();
    return doc?.path && position ? { path: doc.path, lineNumber: position.lineNumber, column: position.column } : null;
  };
  const go = async (from, to) => {
    const target = from.pop();
    if (!target) return;
    const current = here();
    if (current) to.push(current);
    moving = true;
    await openFile(target.path, { selection: new monaco.Range(target.lineNumber, target.column, target.lineNumber, target.column) });
    last = target;
    moving = false;
    emit('nav-changed');
  };
  return {
    record() {
      if (moving) return;
      const now = here();
      if (!now) return;
      if (last && (last.path !== now.path || Math.abs(last.lineNumber - now.lineNumber) > 8)) {
        back.push(last);
        if (back.length > 100) back.shift();
        forward.length = 0;
        emit('nav-changed');
      }
      last = now;
    },
    back: () => go(back, forward),
    forward: () => go(forward, back),
    canBack: () => back.length > 0,
    canForward: () => forward.length > 0,
  };
})();

// Status bar -------------------------------------------------------------------------------

function statusItem(text, { title, onClick, children, cls = '' } = {}) {
  return el('div.status-item' + (onClick ? '.clickable' : '') + cls, { title, on: onClick ? { click: onClick } : undefined }, ...(children ?? [text]));
}

function renderStatus() {
  const debug = debugSession();
  const bar = $('statusbar');
  bar.classList.toggle('debugging', debug.active);
  bar.classList.toggle('idle', !store.workspace && !debug.active);

  const left = [];
  let message = statusMessage;
  if (debug.active) message = `デバッグ中 — ${debugStateText()}`;
  else if (isRunning()) message = `${{ run: '実行中…', record: '記録中…', check: 'ビルド（チェック）中…', test: 'テスト中…', build: 'ビルド中…' }[currentTask()?.kind] ?? '実行中…'}`;
  left.push(statusItem(message, { cls: '.message' }));

  const right = [];
  const { errors, warnings } = problemTotals();
  right.push(statusItem(`⊗ ${errors}  ⚠ ${warnings}`, { title: 'エラー一覧', onClick: () => run('view.errors') }));
  if (store.workspace) {
    const lsp = lspStatus();
    const dot = { ready: 'ok', starting: 'busy', error: 'bad' }[lsp] ?? '';
    right.push(statusItem('', {
      title: '言語サーバー（rewind lsp）。クリックで再起動',
      onClick: () => run('help.restartLsp'),
      children: [el('span.dot' + (dot ? '.' + dot : '')), { ready: 'IntelliSense', starting: 'IntelliSense: 起動中', error: 'IntelliSense: 停止', off: 'IntelliSense: 停止' }[lsp]],
    }));
  }
  right.push(store.toolchain
    ? statusItem(store.toolchain.version, { title: store.toolchain.path, onClick: () => run('help.toolchain') })
    : statusItem('rewind が見つかりません', { title: store.toolchainError ?? '', onClick: () => run('tools.options') }));
  const doc = activeDoc();
  const editor = activeEditor();
  if (doc && editor) {
    const pos = editor.getPosition();
    if (pos) {
      const line = doc.model.getLineContent(pos.lineNumber);
      const before = line.slice(0, pos.column - 1);
      const tab = doc.model.getOptions().tabSize;
      let visual = 1;
      for (const ch of before) visual = ch === '\t' ? visual + tab - ((visual - 1) % tab) : visual + 1;
      right.push(statusItem(`行: ${pos.lineNumber}`, { onClick: () => run('editor.gotoLine') }));
      right.push(statusItem(`文字: ${[...before].length + 1}`));
      right.push(statusItem(`列: ${visual}`));
    }
    const options = doc.model.getOptions();
    right.push(statusItem(options.insertSpaces ? 'SPC' : 'TAB', { title: options.insertSpaces ? `空白 ${options.tabSize} 個` : `タブ幅 ${options.tabSize}`, onClick: () => run('tools.options') }));
    const eol = doc.model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
    right.push(statusItem(eol, {
      title: '改行コード（クリックで切り替え）',
      onClick: () => {
        doc.model.pushEOL(eol === 'CRLF' ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF);
        renderStatus();
      },
    }));
    right.push(statusItem(doc.bom ? 'UTF-8 (BOM)' : 'UTF-8', {
      title: 'クリックで BOM の有無を切り替え（保存時に反映）',
      onClick: () => { doc.bom = !doc.bom; doc.savedAlt = -1; emit('doc-dirty', doc); renderStatus(); },
    }));
  }
  const language = store.workspace?.project?.language;
  if (language) right.push(statusItem(`言語 ${language}`, { title: 'rewind.toml の language' }));
  $('status-left').replaceChildren(...left);
  $('status-right').replaceChildren(...right);
}

// Workspace and session --------------------------------------------------------------------

async function applyWorkspace(workspace) {
  store.workspace = workspace;
  await setExplorerRoot(workspace);
  $('solution-name').textContent = workspace?.name ?? '';
  emit('workspace-changed', workspace);
  if (workspace) {
    // A folder may change which rewind is allowed to run (never one inside the folder).
    const info = await call('toolchain_info');
    store.toolchain = info.toolchain ?? null;
    store.toolchainError = info.toolchainError ?? null;
    startLsp();
    showToolWindow('solution-explorer');
  } else {
    stopLsp();
  }
  setStatusMessage('準備完了');
  updateTitle();
  saveSession();
}

function rememberRecent(path) {
  store.settings.recentWorkspaces = [path, ...store.settings.recentWorkspaces.filter((p) => p !== path)].slice(0, 12);
}

async function openFolder() {
  if (!(await closeAll())) return;
  await stopDebugging();
  try {
    const workspace = await call('open_workspace_dialog');
    if (workspace) {
      rememberRecent(workspace.path);
      await applyWorkspace(workspace);
    }
  } catch (error) {
    notify(`フォルダーを開けませんでした。\n${errorText(error)}`, 'error');
  }
}

async function openRecent(path) {
  if (!(await closeAll())) return;
  await stopDebugging();
  try {
    const workspace = await call('open_recent_workspace', { path });
    rememberRecent(workspace.path);
    await applyWorkspace(workspace);
  } catch (error) {
    notify(`フォルダーを開けませんでした。\n${errorText(error)}`, 'error');
  }
}

async function closeFolder() {
  if (!(await closeAll())) return;
  await stopDebugging();
  await call('close_workspace');
  await applyWorkspace(null);
}

const saveSession = debounce(() => {
  const docs = openDocs().filter((d) => d.path);
  call('save_session', {
    session: {
      workspace: store.workspace?.path ?? null,
      openFiles: docs.map((d) => d.path),
      activeFile: activeDoc()?.path ?? null,
    },
  }).catch(() => {});
}, 500);

async function restoreSession(session) {
  if (!session.workspace) return;
  try {
    const workspace = await call('open_recent_workspace', { path: session.workspace });
    rememberRecent(workspace.path);
    await applyWorkspace(workspace);
  } catch {
    return;
  }
  for (const path of session.openFiles ?? []) {
    await openFile(path, { focus: false }).catch(() => {});
  }
  if (session.activeFile) await openFile(session.activeFile);
}

function updateTitle() {
  const doc = activeDoc();
  const parts = [];
  if (store.workspace) parts.push(store.workspace.name);
  if (doc) parts.push(doc.name + (doc.dirty ? '*' : ''));
  parts.push('Epoch');
  setWindowTitle(parts.join(' - '));
}

/** "すべてに移動" (Ctrl+T): files of the folder and declarations of the active file. */
async function goToAll(initial = '') {
  let files = [];
  if (store.workspace) {
    try {
      files = await call('list_workspace_files');
    } catch (error) {
      notify(errorText(error), 'error');
    }
  }
  const doc = activeDoc();
  const symbols = [];
  if (doc) {
    const walk = (list) => list.forEach((s) => { symbols.push(s); walk(s.children ?? []); });
    walk(await documentSymbols(doc).catch(() => []));
  }
  const recent = openDocs().filter((d) => d.path).map((d) => relativePath(store.workspace?.path, d.path));
  const picked = await quickPick({
    placeholder: 'すべてに移動: ファイル名、またはシンボル名（: で行番号、> でコマンド）',
    value: initial,
    onQuery: (q) => (q.startsWith('>') ? () => showPalette(q.slice(1)) : null),
    items: (query) => {
      const [name, line] = query.split(':');
      const q = name.trim();
      const scored = [];
      for (const s of symbols) {
        const m = fuzzy(q, s.name);
        if (m) scored.push({ score: m.score + 30, item: { label: s.name, ranges: m.ranges, description: `${doc.name} 行 ${s.selectionRange.startLineNumber}`, value: { symbol: s } } });
      }
      for (const file of files) {
        const m = fuzzy(q, basename(file)) ?? fuzzy(q, file);
        if (!m) continue;
        scored.push({
          score: m.score + (recent.includes(file) ? 50 : 0),
          item: { label: basename(file), ranges: fuzzy(q, basename(file))?.ranges ?? [], description: file, value: { file, line: Number(line) || 0 } },
        });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 200).map((x) => x.item);
    },
  });
  if (!picked) return;
  if (picked.value.symbol) {
    const editor = activeEditor();
    editor?.setSelection(picked.value.symbol.selectionRange);
    editor?.revealRangeInCenter(picked.value.symbol.selectionRange);
    editor?.focus();
    return;
  }
  const path = joinPath(store.workspace.path, picked.value.file);
  const line = picked.value.line;
  await openFile(path, line ? { selection: new monaco.Range(line, 1, line, 1) } : {});
}

async function openRecentPicker() {
  const items = (store.settings.recentWorkspaces ?? []).map((path) => ({ label: basename(path), description: path, value: path }));
  const picked = await quickPick({ placeholder: '最近使ったフォルダー', items, matchOn: 'description' });
  if (picked) openRecent(picked.value);
}

// Commands --------------------------------------------------------------------------------

function editorAction(id) {
  return () => {
    const editor = activeEditor();
    if (!editor?.getModel()) return;
    editor.focus();
    editor.getAction(id)?.run() ?? editor.trigger('menu', id, null);
  };
}

function zoom(delta) {
  saveSettingsPatch({ fontSize: Math.max(8, Math.min(48, store.settings.fontSize + delta)) });
}

async function restartDebugging() {
  await stopDebugging();
  await startDebugging();
}

async function runFilteredTests() {
  const { prompt } = await import('./ui.js');
  const filter = await prompt('実行するテストの名前（部分一致）');
  if (filter === undefined) return;
  const { runOptions } = await import('./run.js');
  runOptions.testFilter = filter;
  await simpleTask('test');
  runOptions.testFilter = null;
}

function registerCommands() {
  const hasDoc = () => !!activeDoc();
  const hasWorkspace = () => !!store.workspace;
  const debugging = () => debugSession().active;
  const C = (id, label, key, runFn, extra = {}) => register(id, { label, key, run: runFn, ...extra });
  const show = (id) => () => showToolWindow(id, { focus: true });

  C('file.new', '新しいファイル', 'Ctrl+N', () => showDoc(newUntitled()), { category: 'ファイル' });
  C('file.newInFolder', 'フォルダーに新しいファイルを追加…', 'Ctrl+Shift+A', () => newFile(), { enabled: hasWorkspace, category: 'ファイル' });
  C('file.open', 'ファイルを開く…', 'Ctrl+O', async () => {
    const paths = await call('open_file_dialog').catch((e) => { notify(errorText(e), 'error'); return []; });
    for (const path of paths) await openFile(path);
  }, { category: 'ファイル' });
  C('file.openFolder', 'フォルダーを開く…', 'Ctrl+Shift+Alt+O', openFolder, { category: 'ファイル' });
  C('file.openRecent', '最近使ったフォルダー…', null, openRecentPicker, { category: 'ファイル' });
  C('file.save', '保存', 'Ctrl+S', () => saveActive(false), { enabled: hasDoc, category: 'ファイル' });
  C('file.saveAs', '名前を付けて保存…', null, () => saveActive(true), { enabled: hasDoc, category: 'ファイル' });
  C('file.saveAll', 'すべて保存', 'Ctrl+Shift+S', saveAll, { category: 'ファイル' });
  C('file.close', '閉じる', ['Ctrl+F4', 'Ctrl+W'], closeActive, { enabled: hasDoc, category: 'ファイル' });
  C('file.closeFolder', 'フォルダーを閉じる', null, closeFolder, { enabled: hasWorkspace, category: 'ファイル' });
  C('app.quit', '終了', 'Alt+F4', () => quit(), { category: 'ファイル' });

  // Editing shortcuts belong to Monaco; the menu only shows them (menuKey).
  register('edit.undo', { label: '元に戻す', run: () => activeEditor()?.trigger('menu', 'undo', null), menuKey: 'Ctrl+Z' });
  register('edit.redo', { label: 'やり直し', run: () => activeEditor()?.trigger('menu', 'redo', null), menuKey: 'Ctrl+Y' });
  register('edit.cut', { label: '切り取り', run: editorAction('editor.action.clipboardCutAction'), menuKey: 'Ctrl+X' });
  register('edit.copy', { label: 'コピー', run: editorAction('editor.action.clipboardCopyAction'), menuKey: 'Ctrl+C' });
  register('edit.paste', { label: '貼り付け', run: editorAction('editor.action.clipboardPasteAction'), menuKey: 'Ctrl+V' });
  register('edit.find', { label: 'クイック検索', run: editorAction('actions.find'), menuKey: 'Ctrl+F' });
  register('edit.replace', { label: 'クイック置換', run: editorAction('editor.action.startFindReplaceAction'), menuKey: 'Ctrl+H' });
  register('edit.comment', { label: '選択範囲のコメント', run: editorAction('editor.action.addCommentLine'), menuKey: 'Ctrl+K, Ctrl+C' });
  register('edit.uncomment', { label: '選択範囲のコメントを解除', run: editorAction('editor.action.removeCommentLine'), menuKey: 'Ctrl+K, Ctrl+U' });
  register('edit.format', { label: 'ドキュメントのフォーマット', run: editorAction('editor.action.formatDocument'), menuKey: 'Shift+Alt+F' });
  register('edit.rename', { label: '名前の変更…', run: editorAction('editor.action.rename'), menuKey: 'F2' });
  register('editor.gotoLine', { label: '行に移動…', run: editorAction('editor.action.gotoLine'), menuKey: 'Ctrl+G' });
  register('editor.gotoSymbol', { label: 'メンバーに移動…', run: editorAction('editor.action.quickOutline'), menuKey: 'Alt+\\' });
  C('nav.goToAll', 'すべてに移動…', ['Ctrl+T', 'Ctrl+,', 'Ctrl+P'], () => goToAll());
  C('search.inFiles', 'フォルダーを指定して検索', 'Ctrl+Shift+F', () => {
    showToolWindow('find', { focus: true });
    const editor = activeEditor();
    const selection = editor?.getSelection();
    const text = selection && !selection.isEmpty() && selection.startLineNumber === selection.endLineNumber ? editor.getModel().getValueInRange(selection) : '';
    focusSearch(text);
  });
  C('search.replaceInFiles', 'フォルダーを指定して置換', 'Ctrl+Shift+H', () => { showToolWindow('find', { focus: true }); focusSearch(''); });

  C('view.palette', 'コマンド パレット（機能の検索）', ['Ctrl+Q', 'Ctrl+Shift+P', 'F1'], () => showPalette());
  C('view.solutionExplorer', 'ソリューション エクスプローラー', 'Ctrl+Alt+L', () => { showToolWindow('solution-explorer', { focus: true }); }, { category: '表示' });
  C('view.outline', 'ドキュメント アウトライン', 'Ctrl+Alt+T', show('outline'), { category: '表示' });
  C('view.errors', 'エラー一覧', 'Ctrl+Alt+E', show('problems'), { category: '表示' });
  C('view.output', '出力', 'Ctrl+Alt+O', show('output'), { category: '表示' });
  C('view.terminal', 'ターミナル', 'Ctrl+`', () => togglePanel('terminal'), { category: '表示' });
  C('view.findResults', '検索結果', null, show('find'), { category: '表示' });
  C('view.timeline', '履歴タイムライン', 'Ctrl+Alt+H', show('timeline'), { category: '表示' });
  C('view.breakpoints', 'ブレークポイント', 'Ctrl+Alt+B', show('breakpoints'), { category: 'デバッグ ウィンドウ' });
  C('view.locals', 'ローカル', null, show('locals'), { category: 'デバッグ ウィンドウ' });
  C('view.watch', 'ウォッチ 1', null, show('watch'), { category: 'デバッグ ウィンドウ' });
  C('view.callStack', '呼び出し履歴', 'Ctrl+Alt+C', show('call-stack'), { category: 'デバッグ ウィンドウ' });
  C('view.immediate', 'イミディエイト ウィンドウ', 'Ctrl+Alt+I', show('immediate'), { category: 'デバッグ ウィンドウ' });
  C('view.toggleRightDock', '右側のドッキングの表示切り替え', 'Ctrl+Alt+R', toggleRightDock, { category: '表示' });
  C('view.panel', '下側のドッキングの表示切り替え', 'Ctrl+J', () => togglePanel(), { category: '表示' });
  C('view.zoomIn', '拡大', ['Ctrl+Shift+.', 'Ctrl+Shift+>'], () => zoom(1), { category: '表示' });
  C('view.zoomOut', '縮小', ['Ctrl+Shift+,', 'Ctrl+Shift+<'], () => zoom(-1), { category: '表示' });
  C('nav.back', '前に移動', 'Ctrl+-', () => navHistory.back(), { category: '表示' });
  C('nav.forward', '次に移動', ['Ctrl+Shift+-', 'Ctrl+Shift+='], () => navHistory.forward(), { category: '表示' });
  C('view.splitRight', '新しい垂直タブ グループ', 'Ctrl+\\', () => splitRight(), { category: 'ウィンドウ' });
  C('view.focusOther', '次のタブ グループへ', 'Ctrl+Alt+\\', focusOtherGroup, { category: 'ウィンドウ' });
  C('view.nextTab', '次のドキュメント', ['Ctrl+Tab', 'Ctrl+PageDown'], () => cycleTab(1), { category: 'ウィンドウ' });
  C('view.prevTab', '前のドキュメント', ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], () => cycleTab(-1), { category: 'ウィンドウ' });
  C('window.closeAll', 'すべてのドキュメントを閉じる', null, closeAll, { category: 'ウィンドウ' });
  C('window.reset', 'ウィンドウ レイアウトのリセット', null, resetLayout, { category: 'ウィンドウ' });

  C('run.run', 'デバッグなしで開始', 'Ctrl+F5', runActive, { category: 'デバッグ' });
  C('run.stop', 'デバッグの停止', 'Shift+F5', () => (debugging() ? stopDebugging() : stopTask()), { category: 'デバッグ' });
  C('run.check', 'ソリューションのビルド（チェック）', 'Ctrl+Shift+B', checkActive, { category: 'ビルド' });
  C('run.build', 'プロジェクトのビルド（rewind build）', null, () => simpleTask('build'), { category: 'ビルド' });
  C('run.compile', '.rwc へコンパイル', null, () => simpleTask('compile'), { category: 'ビルド' });
  C('run.doc', '公開 API を Markdown で出力', null, () => simpleTask('doc'), { category: 'ビルド' });
  C('run.test', 'すべてのテストを実行', 'Ctrl+R', () => simpleTask('test'), { category: 'テスト' });
  C('run.testFiltered', 'テストを絞り込んで実行…', null, runFilteredTests, { category: 'テスト' });
  C('run.profile', 'パフォーマンス プロファイラー（仕事量）', 'Alt+F2', () => simpleTask('profile'), { category: 'デバッグ' });
  C('run.configure', '実行の設定（引数・効果・上限）…', null, configureRun, { category: 'デバッグ' });

  C('debug.start', 'デバッグの開始 / 続行', 'F5', startDebugging, { category: 'デバッグ', when: () => !document.activeElement?.closest?.('.console-input') });
  C('debug.restart', '再起動', 'Ctrl+Shift+F5', restartDebugging, { enabled: debugging, category: 'デバッグ' });
  C('debug.stepOver', 'ステップ オーバー', 'F10', () => step('next'), { enabled: debugging, category: 'デバッグ' });
  C('debug.stepIn', 'ステップ イン', 'F11', () => step('stepIn'), { enabled: debugging, category: 'デバッグ' });
  C('debug.stepBack', 'ステップ バック', ['Alt+[', 'Alt+F10'], () => step('stepBack'), { enabled: debugging, category: 'デバッグ' });
  C('debug.reverseContinue', '逆方向に続行', 'Alt+F5', () => step('reverseContinue'), { enabled: debugging, category: 'デバッグ' });
  C('debug.toggleBreakpoint', 'ブレークポイントの設定/解除', 'F9', toggleBreakpointAtCursor, { category: 'デバッグ' });
  C('debug.deleteBreakpoints', 'すべてのブレークポイントの削除', 'Ctrl+Shift+F9', removeAllBreakpoints, { category: 'デバッグ' });
  C('debug.openTrace', '記録ファイル（trace）を開く…', null, openTrace, { category: 'デバッグ' });

  C('tools.options', 'オプション…', null, () => showOptions(), { category: 'ツール' });
  C('help.shortcuts', 'キーボード ショートカットの一覧', null, () => showPalette());
  C('help.restartLsp', '言語サーバーの再起動', null, () => startLsp(), { enabled: hasWorkspace, category: 'ツール' });
  C('help.toolchain', 'rewind の情報', null, () => {
    if (store.toolchain) notify(`${store.toolchain.version}\n${store.toolchain.path}\n対応する言語: ${(store.toolchain.editorInfo?.languages?.supported ?? []).join(', ')}`, 'info');
    else notify(`rewind が見つかりません。\n${store.toolchainError ?? ''}`, 'error', [{ label: 'オプションを開く', action: () => showOptions('toolchain') }]);
  }, { category: 'ツール' });
  C('help.about', 'Epoch のバージョン情報', null, () =>
    notify(`Epoch ${store.version}\nREWIND のための統合開発環境（Rust + Tauri + Monaco）\nファイル操作は開いたフォルダーの中に限られ、コードは明示した操作でだけ実行されます。`, 'info'));
  C('focus.explorerSearch', 'ソリューション エクスプローラーを検索', 'Ctrl+;', () => { showToolWindow('solution-explorer', { focus: true }); explorerSearch.focus(); });
}

function resetLayout() {
  $('right-dock').style.width = '';
  $('bottom-dock').style.height = '';
  $('tg-bottom-right').style.flex = '';
  for (const id of ['solution-explorer', 'problems', 'output']) showToolWindow(id);
  showToolWindow('solution-explorer');
  showToolWindow('problems');
}

async function quit() {
  if (!(await confirmDiscard(allDocs(), '終了'))) return;
  saveSession.flush?.();
  await call('app_exit');
}

// Start-up ---------------------------------------------------------------------------------

function applyTheme() {
  document.documentElement.dataset.theme = store.settings.theme;
}

export async function start() {
  const init = await call('app_init');
  store.settings = init.settings;
  store.toolchain = init.toolchain ?? null;
  store.toolchainError = init.toolchainError ?? null;
  store.platform = init.platform;
  store.version = init.version;
  store.languageInfo = registerRewind(store.toolchain?.editorInfo);
  applyTheme();

  monaco.editor.setTheme(monacoTheme(store.settings.theme));
  buildLayout();
  initPanels();
  initEditors({ welcomeElement: buildWelcome() });
  addToolWindow({ id: 'solution-explorer', title: 'ソリューション エクスプローラー', group: 'right', content: explorerView() });
  addToolWindow({ id: 'outline', title: 'ドキュメント アウトライン', group: 'right', content: outlineView() });
  initRun();
  addToolWindow({ id: 'find', title: '検索結果 1', content: searchView() });
  initTimeline();
  initDebug();
  initLsp();
  initExplorer();
  initSearch();
  initOutline();
  registerCommands();
  initKeybindings();
  buildMenus();
  buildToolbar();
  showToolWindow('solution-explorer');
  showToolWindow('problems');

  const status = debounce(renderStatus, 50);
  for (const event of ['cursor', 'active-doc', 'lsp-status', 'problem-totals', 'task-state', 'debug-state', 'doc-dirty', 'workspace-changed']) subscribe(event, status);
  for (const event of ['active-doc', 'doc-dirty']) subscribe(event, updateTitle);
  for (const event of ['active-doc', 'doc-opened', 'doc-closed']) subscribe(event, saveSession);
  subscribe('cursor', debounce(() => navHistory.record(), 150));
  subscribe('active-doc', () => navHistory.record());
  subscribe('settings-changed', () => {
    applyTheme();
    applySettingsToEditors();
    renderStatus();
  });
  subscribe('task-finished', ({ kind, code }) => {
    const label = { check: 'ビルド（チェック）', build: 'ビルド', test: 'テスト', compile: 'コンパイル', run: '実行', record: '記録', profile: 'プロファイル', doc: 'API 文書' }[kind] ?? kind;
    setStatusMessage(code === 0 ? `${label}: 成功` : code === null ? `${label}: 停止しました` : `${label}: 失敗（終了コード ${code}）`);
  });

  const autoSave = new Map();
  subscribe('doc-changed', ({ doc }) => {
    if (!store.settings.autoSave || !doc.path) return;
    clearTimeout(autoSave.get(doc));
    autoSave.set(doc, setTimeout(() => doc.dirty && saveDoc(doc), store.settings.autoSaveDelayMs));
  });
  subscribe('doc-saved', (doc) => {
    setStatusMessage('項目を保存しました');
    checkOnSave(doc);
  });

  window.addEventListener('focus', () => checkExternalChanges());
  window.addEventListener('contextmenu', (e) => {
    // Only the editor, inputs and consoles get a native context menu; not the page itself.
    if (!e.target.closest('.monaco-editor, input, textarea, .console')) e.preventDefault();
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  on('close-requested', quit);

  renderStatus();
  updateTitle();
  await restoreSession(init.session);
  if (!store.toolchain) {
    notify(`rewind が見つかりませんでした。実行・ビルド・IntelliSense には REWIND SDK が必要です。\n${store.toolchainError ?? ''}`, 'warning', [
      { label: 'オプションを開く', action: () => showOptions('toolchain') },
    ]);
  }
}

// The replay debugger. F5 records the program (`rewind run --record … --record-mode debug`) and
// opens the trace in `rewind dap`; from there execution moves forwards and backwards through the
// recording. Nothing is executed again and no external operation happens while debugging.
import { monaco } from './monaco.js';
import { call, on, errorText } from './ipc.js';
import { store, emit, subscribe, log } from './store.js';
import { el, notify, pathKey, joinPath, dirname, basename, relativePath, prompt } from './ui.js';
import { Console, addToolWindow, showToolWindow, hideToolWindow } from './panels.js';
import { openFile, activeDoc, activeEditor } from './editors.js';
import { allDocs, findDoc } from './documents.js';
import { recordActive } from './run.js';
import { LANGUAGE_ID } from './rewind-lang.js';

const session = {
  active: false,
  generation: 0,
  stopped: false,
  ended: false,
  threadId: 0,
  frames: [],
  frameId: null,
  sourceRoot: null,
  trace: null,
};

/** pathKey -> {path, lines: Map<line, {verified, message}>} */
const breakpoints = new Map();
/** doc -> decoration ids */
const breakpointDecorations = new Map();
const currentLineDecorations = new Map();
const watches = [];

export const debugConsole = new Console();

export function debugSession() {
  return session;
}

// Breakpoints ------------------------------------------------------------------------------

function breakpointsFor(path) {
  const key = pathKey(path);
  if (!breakpoints.has(key)) breakpoints.set(key, { path, lines: new Map() });
  return breakpoints.get(key);
}

function renderBreakpointDecorations(doc) {
  if (!doc.path) return;
  const entry = breakpoints.get(pathKey(doc.path));
  const decorations = [...(entry?.lines ?? new Map())].map(([line, info]) => ({
    range: new monaco.Range(line, 1, line, 1),
    options: {
      glyphMarginClassName: info.verified === false ? 'bp-glyph-unverified' : 'bp-glyph',
      glyphMarginHoverMessage: { value: info.verified === false ? `ブレークポイント（この行には記録された命令がありません）${info.message ? `: ${info.message}` : ''}` : 'ブレークポイント' },
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  }));
  breakpointDecorations.set(doc, doc.model.deltaDecorations(breakpointDecorations.get(doc) ?? [], decorations));
}

export function toggleBreakpoint(path, line) {
  const entry = breakpointsFor(path);
  if (entry.lines.has(line)) entry.lines.delete(line);
  else entry.lines.set(line, { verified: undefined });
  const doc = findDoc(path);
  if (doc) renderBreakpointDecorations(doc);
  renderDebugViews();
  if (session.active) sendBreakpoints(entry).catch(() => {});
}

export function toggleBreakpointAtCursor() {
  const doc = activeDoc();
  const editor = activeEditor();
  if (!doc?.path || !editor) return;
  toggleBreakpoint(doc.path, editor.getPosition().lineNumber);
}

async function sendBreakpoints(entry) {
  const body = await call('dap_request', {
    command: 'setBreakpoints',
    arguments: { source: { path: entry.path, name: basename(entry.path) }, breakpoints: [...entry.lines.keys()].map((line) => ({ line })) },
  });
  const lines = [...entry.lines.keys()];
  (body?.breakpoints ?? []).forEach((bp, i) => {
    const line = lines[i];
    if (line !== undefined) entry.lines.set(line, { verified: bp.verified, message: bp.message });
  });
  const doc = findDoc(entry.path);
  if (doc) renderBreakpointDecorations(doc);
  renderDebugViews();
}

// Session ----------------------------------------------------------------------------------

const DEBUG_WINDOWS = ['locals', 'watch', 'call-stack', 'immediate'];
let wasActive = false;

/** Visual Studio's debug layout: the debug windows open while debugging and close after. */
function setDebugUi() {
  if (session.active && !wasActive) {
    for (const id of DEBUG_WINDOWS) showToolWindow(id);
    showToolWindow('breakpoints');
    showToolWindow('locals');
    showToolWindow('call-stack');
  } else if (!session.active && wasActive) {
    for (const id of DEBUG_WINDOWS) hideToolWindow(id);
    hideToolWindow('breakpoints');
  }
  wasActive = session.active;
  renderDebugViews();
  emit('debug-state', session);
}

/** Resolves a frame's source (relative to the program root) to a file path. */
function sourcePath(source) {
  const path = source?.path ?? source?.name;
  if (!path) return null;
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')) return path;
  const base = session.sourceRoot ?? store.workspace?.path;
  return base ? joinPath(base, path.replace(/\//g, store.platform === 'windows' ? '\\' : '/')) : path;
}

export async function startDebugging() {
  if (session.active) {
    if (session.stopped) await step('continue');
    return;
  }
  const recorded = await recordActive();
  if (!recorded) return;
  const project = store.workspace?.project;
  const sourceRoot = project ? store.workspace.path : dirname(recorded.file);
  await launch(recorded.trace, sourceRoot);
}

export async function openTrace() {
  if (!store.workspace) {
    notify('フォルダーを開いてから記録を開いてください。', 'warning');
    return;
  }
  const trace = await call('open_trace_dialog').catch((e) => notify(errorText(e), 'error'));
  if (!trace) return;
  const doc = activeDoc();
  const sourceRoot = store.workspace.project || !doc?.path ? store.workspace.path : dirname(doc.path);
  await launch(trace, sourceRoot);
}

async function launch(trace, sourceRoot) {
  if (session.active) await stopDebugging();
  debugConsole.append(`記録を開いています: ${relativePath(store.workspace?.path, trace)}\n`, 'system');
  let started;
  try {
    started = await call('dap_start', { trace, sourceRoot });
  } catch (error) {
    notify(`デバッガーを開始できませんでした。\n${errorText(error)}`, 'error');
    return;
  }
  Object.assign(session, {
    active: true,
    generation: started.generation,
    stopped: false,
    ended: false,
    frames: [],
    frameId: null,
    sourceRoot,
    trace,
  });
  emit('trace-recorded', { trace, sourceRoot });
  setDebugUi();
  try {
    for (const entry of breakpoints.values()) {
      if (entry.lines.size) await sendBreakpoints(entry);
    }
    await call('dap_request', { command: 'configurationDone', arguments: {} });
  } catch (error) {
    notify(`デバッガーの準備に失敗しました。\n${errorText(error)}`, 'error');
    await stopDebugging();
  }
}

export async function stopDebugging() {
  if (!session.active) return;
  session.active = false;
  session.stopped = false;
  await call('dap_stop').catch(() => {});
  clearCurrentLine();
  debugConsole.append('デバッグを終了しました。\n', 'system');
  setDebugUi();
}

export async function step(command) {
  if (!session.active || !session.stopped) return;
  if (session.ended && ['continue', 'next', 'stepIn'].includes(command)) {
    notify('記録の終端です。逆方向に進めるか、デバッグを終了してください。', 'info');
    return;
  }
  session.stopped = false;
  emit('debug-state', session);
  try {
    await call('dap_request', { command, arguments: { threadId: session.threadId } });
  } catch (error) {
    session.stopped = true;
    emit('debug-state', session);
    notify(errorText(error), 'warning');
  }
}

async function onStopped(body) {
  session.stopped = true;
  session.ended = false;
  session.threadId = body.threadId ?? session.threadId ?? 0;
  try {
    const stack = await call('dap_request', { command: 'stackTrace', arguments: { threadId: session.threadId, startFrame: 0, levels: 200 } });
    session.frames = stack?.stackFrames ?? [];
    const threads = await call('dap_request', { command: 'threads', arguments: {} });
    session.threads = threads?.threads ?? [];
  } catch (error) {
    session.frames = [];
    log('デバッグ', errorText(error));
  }
  session.reason = body.reason;
  await selectFrame(session.frames[0]);
  setDebugUi();
}

async function selectFrame(frame) {
  session.frameId = frame?.id ?? null;
  session.scopes = [];
  clearCurrentLine();
  if (!frame) return;
  const path = sourcePath(frame.source);
  if (path && frame.line) {
    const doc = await openFile(path, { selection: new monaco.Range(frame.line, frame.column || 1, frame.line, frame.column || 1), focus: false });
    if (doc) showCurrentLine(doc, frame.line, frame === session.frames[0]);
  }
  try {
    const scopes = await call('dap_request', { command: 'scopes', arguments: { frameId: frame.id } });
    session.scopes = scopes?.scopes ?? [];
  } catch (error) {
    log('デバッグ', errorText(error));
  }
  await evaluateWatches();
  renderDebugViews();
}

function showCurrentLine(doc, line, top) {
  currentLineDecorations.set(
    doc,
    doc.model.deltaDecorations(currentLineDecorations.get(doc) ?? [], [
      {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: top ? 'debug-current-line' : 'debug-history-line',
          glyphMarginClassName: 'debug-arrow-glyph',
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      },
    ]),
  );
}

function clearCurrentLine() {
  for (const [doc, ids] of currentLineDecorations) {
    if (!doc.model.isDisposed()) doc.model.deltaDecorations(ids, []);
  }
  currentLineDecorations.clear();
}

async function evaluate(expression, context = 'watch') {
  if (!session.active || !session.stopped) return null;
  return call('dap_request', {
    command: 'evaluate',
    arguments: { expression, frameId: session.frameId ?? undefined, context },
  });
}

async function evaluateWatches() {
  for (const watch of watches) {
    try {
      const result = await evaluate(watch.expression);
      watch.value = result?.result ?? '';
      watch.error = null;
    } catch (error) {
      watch.value = '';
      watch.error = errorText(error);
    }
  }
}

// Views: Visual Studio's debug tool windows -------------------------------------------------

function stoppedLabel(reason) {
  return { entry: '開始位置で停止', breakpoint: 'ブレークポイントで停止', step: 'ステップ完了', pause: '一時停止' }[reason] ?? '停止中';
}

export function debugStateText() {
  if (!session.active) return '';
  if (session.ended) return '記録の終端';
  return session.stopped ? stoppedLabel(session.reason) : '移動中…';
}

const localsBody = el('tbody');
const watchBody = el('tbody');
const stackBody = el('tbody');
const breakpointBody = el('tbody');

function grid(columns, body) {
  return el('div.grid-wrap', {},
    el('table.grid', {},
      el('colgroup', {}, ...columns.map(([, width]) => el('col', { style: width ? { width } : {} }))),
      el('thead', {}, el('tr', {}, ...columns.map(([label]) => el('th', { text: label })))),
      body,
    ),
  );
}

/** Rows of a variables grid (name / value / type); children load when a row is expanded. */
function variableRows(variables, depth, body, after) {
  const rows = [];
  for (const v of variables) {
    const expandable = v.variablesReference > 0;
    let expanded = false;
    let children = [];
    const twisty = el('span.twisty', { text: expandable ? '▶' : '' });
    const row = el('tr', { title: `${v.name}: ${v.type ?? ''} = ${v.value}` },
      el('td', { style: { paddingLeft: `${4 + depth * 14}px` } }, twisty, el('span.var-name', { text: v.name })),
      el('td.var-value', { text: v.value }),
      el('td.var-type', { text: v.type ?? '' }),
    );
    twisty.addEventListener('click', async () => {
      if (!expandable) return;
      expanded = !expanded;
      twisty.textContent = expanded ? '▼' : '▶';
      children.forEach((c) => c.remove());
      children = [];
      if (!expanded) return;
      try {
        const result = await call('dap_request', { command: 'variables', arguments: { variablesReference: v.variablesReference } });
        children = variableRows(result?.variables ?? [], depth + 1, body, row);
      } catch (error) {
        children = [el('tr', {}, el('td', { colSpan: 3, text: errorText(error) }))];
        row.after(...children);
      }
    });
    rows.push(row);
  }
  if (after) after.after(...rows);
  else body.append(...rows);
  return rows;
}

let renderToken = 0;

async function renderLocals() {
  const token = ++renderToken;
  const fresh = el('tbody');
  if (session.active && session.stopped) {
    for (const scope of session.scopes ?? []) {
      try {
        const result = await call('dap_request', { command: 'variables', arguments: { variablesReference: scope.variablesReference } });
        variableRows(result?.variables ?? [], 0, fresh);
      } catch (error) {
        fresh.append(el('tr', {}, el('td', { colSpan: 3, text: errorText(error) })));
      }
    }
  }
  if (token !== renderToken) return;
  localsBody.replaceChildren(...fresh.children);
}

function renderWatches() {
  const rows = watches.map((w, i) =>
    el('tr', { title: w.error ?? w.value ?? '' },
      el('td', {}, el('span.var-name', { text: w.expression })),
      el('td.var-value' + (w.error ? '.sev-error' : ''), { text: w.error ?? w.value ?? '' }),
      el('td', {}, el('button.icon-btn', { text: '✕', title: '削除', on: { click: () => { watches.splice(i, 1); renderWatches(); } } })),
    ),
  );
  const input = el('input', { placeholder: '監視する式を追加（name / name.field / name[3]）', spellcheck: false, style: { width: '100%', border: 'none', background: 'transparent' } });
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    watches.push({ expression: input.value.trim() });
    await evaluateWatches();
    renderWatches();
  });
  watchBody.replaceChildren(...rows, el('tr', {}, el('td', { colSpan: 3 }, input)));
}

function renderStack() {
  stackBody.replaceChildren(
    ...session.frames.map((frame) =>
      el('tr' + (frame.id === session.frameId ? '.selected' : ''), {
        on: { dblclick: () => selectFrame(frame).then(renderDebugViews) },
      },
      el('td', { text: frame.id === session.frames[0]?.id ? '➔' : frame.id === session.frameId ? '▷' : '', style: { color: '#ffcc00' } }),
      el('td', { text: `${frame.name}()` }),
      el('td', { text: `${frame.source?.name ?? ''} 行 ${frame.line ?? ''}` }),
      el('td', { text: 'REWIND' }),
      ),
    ),
  );
}

function renderBreakpoints() {
  const rows = [];
  for (const entry of breakpoints.values()) {
    for (const [line, info] of [...entry.lines].sort((a, b) => a[0] - b[0])) {
      rows.push(
        el('tr', {
          title: info.message ?? '',
          on: { dblclick: () => openFile(entry.path, { selection: new monaco.Range(line, 1, line, 1) }) },
        },
        el('td', { text: info.verified === false ? '○' : '●', style: { color: '#e51400' } }),
        el('td', { text: `${basename(entry.path)}、行 ${line}` }),
        el('td', { text: relativePath(store.workspace?.path, dirname(entry.path)) || '.' }),
        el('td', { text: info.verified === false ? '記録された命令がない行' : session.active ? '有効' : '' }),
        el('td', {}, el('button.icon-btn', { text: '✕', title: '削除', on: { click: () => toggleBreakpoint(entry.path, line) } })),
        ),
      );
    }
  }
  breakpointBody.replaceChildren(...rows);
}

function renderDebugViews() {
  renderLocals();
  renderWatches();
  renderStack();
  renderBreakpoints();
}

export function removeAllBreakpoints() {
  for (const entry of breakpoints.values()) {
    for (const line of [...entry.lines.keys()]) toggleBreakpoint(entry.path, line);
  }
}

// Wiring ----------------------------------------------------------------------------------

export function initDebug() {
  const replInput = el('input', { placeholder: '式を評価（停止中のみ）: name、name.field、name[3]', spellcheck: false });
  replInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const expression = replInput.value.trim();
    if (!expression) return;
    replInput.value = '';
    debugConsole.append(`› ${expression}\n`, 'command');
    try {
      const result = await evaluate(expression, 'repl');
      debugConsole.append(`${result?.result ?? '（停止中ではありません）'}\n`);
    } catch (error) {
      debugConsole.append(`${errorText(error)}\n`, 'stderr');
    }
  });
  addToolWindow({
    id: 'locals',
    title: 'ローカル',
    hidden: true,
    content: grid([['名前', '34%'], ['値'], ['型', '18%']], localsBody),
  });
  addToolWindow({
    id: 'watch',
    title: 'ウォッチ 1',
    hidden: true,
    content: grid([['名前', '34%'], ['値'], ['', '30px']], watchBody),
  });
  addToolWindow({
    id: 'call-stack',
    title: '呼び出し履歴',
    group: 'bottom-right',
    hidden: true,
    content: grid([['', '22px'], ['名前', '40%'], ['位置'], ['言語', '70px']], stackBody),
  });
  addToolWindow({
    id: 'breakpoints',
    title: 'ブレークポイント',
    group: 'bottom-right',
    hidden: true,
    content: grid([['', '22px'], ['名前', '40%'], ['フォルダー'], ['状態', '25%'], ['', '30px']], breakpointBody),
    actions: [el('button.icon-btn', { title: 'すべてのブレークポイントを削除', text: '⊘', on: { click: removeAllBreakpoints } })],
  });
  addToolWindow({
    id: 'immediate',
    title: 'イミディエイト ウィンドウ',
    group: 'bottom-right',
    hidden: true,
    content: el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } },
      debugConsole.el,
      el('div.console-input', {}, el('span.prompt', { text: '>' }), replInput),
    ),
    actions: [el('button.icon-btn', { title: 'すべてクリア', text: '⌫', on: { click: () => debugConsole.clear() } })],
  });

  on('dap-event', async ({ generation, event, body }) => {
    if (generation !== session.generation || !session.active) return;
    if (event === 'stopped') await onStopped(body ?? {});
    else if (event === 'terminated') {
      session.stopped = true;
      session.ended = true;
      debugConsole.append('記録の終端に達しました。逆方向には引き続き進めます。\n', 'system');
      setDebugUi();
    } else if (event === 'output') {
      debugConsole.append(body?.output ?? '', body?.category === 'stderr' ? 'stderr' : undefined);
    }
  });
  on('dap-log', ({ generation, line }) => {
    if (generation === session.generation) debugConsole.append(line + '\n', 'system');
  });
  on('dap-exit', ({ generation }) => {
    if (generation !== session.generation || !session.active) return;
    session.active = false;
    session.stopped = false;
    clearCurrentLine();
    debugConsole.append('デバッガーが終了しました。\n', 'system');
    setDebugUi();
  });

  // Editors created before this module started are wired up too.
  const attach = (editor) => {
    editor.onMouseDown((e) => {
      const type = e.target.type;
      if (type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
      const doc = allDocs().find((d) => d.model === editor.getModel());
      if (doc?.path && e.target.position) toggleBreakpoint(doc.path, e.target.position.lineNumber);
    });
  };
  monaco.editor.getEditors().forEach(attach);
  subscribe('editor-created', attach);
  subscribe('doc-opened', (doc) => renderBreakpointDecorations(doc));
  subscribe('doc-closed', (doc) => {
    breakpointDecorations.delete(doc);
    currentLineDecorations.delete(doc);
  });

  // Hovering a name while stopped shows its recorded value.
  monaco.languages.registerHoverProvider(LANGUAGE_ID, {
    async provideHover(model, position) {
      if (!session.active || !session.stopped) return null;
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      try {
        const result = await evaluate(word.word, 'hover');
        if (!result?.result) return null;
        return {
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          contents: [{ value: '**' + word.word + '** (記録された値)' }, { value: '```\n' + result.result + '\n```' }],
        };
      } catch {
        return null;
      }
    },
  });
  setDebugUi();
}

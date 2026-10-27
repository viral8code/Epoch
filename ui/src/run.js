// Running REWIND programs and tools: the "ターミナル" panel shows the program's output and sends
// typed lines to its standard input. Errors arrive as JSON diagnostics and become clickable
// lines and entries in the problems list.
import { monaco } from './monaco.js';
import { call, on, errorText } from './ipc.js';
import { store, emit, log } from './store.js';
import { el, notify, basename, relativePath, prompt, joinPath } from './ui.js';
import { Console, addPanelView, showPanel } from './panels.js';
import { activeDoc, openFile } from './editors.js';
import { allDocs, findDoc, saveDoc } from './documents.js';
import { lspStatus } from './lsp.js';

const RUN_OWNER = 'rewind-run';
const CHECK_OWNER = 'rewind-check';
const terminal = new Console();
const input = el('input', { placeholder: '実行中のプログラムへの入力（Enter で送信）', spellcheck: false, disabled: true });
const stopButton = el('button.icon-btn', { title: '停止 (Shift+F5)', text: '■', disabled: true, on: { click: () => stopTask() } });

/** id -> {kind, file, resolve, started, ...} */
const tasks = new Map();
let current = null;
const history = [];
let historyIndex = -1;

export const runOptions = { args: [], effects: null, steps: null };

export function isRunning() {
  return !!current;
}

export function currentTask() {
  return current;
}

function setRunning(task) {
  current = task;
  input.disabled = !task || !task.interactive;
  stopButton.disabled = !task;
  emit('task-state', task);
}

/** One line of JSON on stderr is a REWIND diagnostic. */
function parseDiagnostic(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const json = JSON.parse(trimmed);
    if (!json.diagnostic && !json.message) return null;
    return json;
  } catch {
    return null;
  }
}

function resolveSource(source, task) {
  if (!source) return task.file;
  if (/^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('/') || source.startsWith('\\\\')) return source;
  const base = task.cwd ?? store.workspace?.path;
  return base ? joinPath(base, source.replace(/\//g, store.platform === 'windows' ? '\\' : '/')) : source;
}

/** Character column (from the compiler) to a Monaco range covering the word there. */
function markerRange(model, line, column) {
  const lineCount = model?.getLineCount() ?? 0;
  if (!model || line < 1 || line > lineCount) return new monaco.Range(line, 1, line, 2);
  const text = model.getLineContent(line);
  const chars = [...text];
  const utf16 = chars.slice(0, Math.max(0, column - 1)).join('').length + 1;
  const word = model.getWordAtPosition({ lineNumber: line, column: utf16 });
  if (word) return new monaco.Range(line, word.startColumn, line, word.endColumn);
  return new monaco.Range(line, utf16, line, utf16 + Math.max(1, (chars[column - 1] ?? ' ').length));
}

const checkMarkers = new Map();

function addProblem(owner, path, diagnostic) {
  const doc = findDoc(path);
  if (!doc) return;
  const range = markerRange(doc.model, diagnostic.line ?? 1, diagnostic.column ?? 1);
  const message = [diagnostic.message, ...(diagnostic.hints ?? [])].join('\n');
  const marker = {
    severity: monaco.MarkerSeverity.Error,
    message,
    code: diagnostic.code ?? undefined,
    source: owner === RUN_OWNER ? 'rewind run' : 'rewind check',
    ...range,
    startLineNumber: range.startLineNumber,
    startColumn: range.startColumn,
    endLineNumber: range.endLineNumber,
    endColumn: range.endColumn,
  };
  const key = `${owner}|${doc.key}`;
  const list = checkMarkers.get(key) ?? [];
  list.push(marker);
  checkMarkers.set(key, list);
  monaco.editor.setModelMarkers(doc.model, owner, list);
}

function clearProblems(owner) {
  for (const key of [...checkMarkers.keys()]) {
    if (!key.startsWith(owner + '|')) continue;
    checkMarkers.delete(key);
  }
  for (const doc of allDocs()) monaco.editor.setModelMarkers(doc.model, owner, []);
}

function renderDiagnostic(json, task) {
  const d = json.diagnostic ?? {};
  const source = resolveSource(d.source, task);
  if (task.quiet) {
    if (d.line && source) addProblem(CHECK_OWNER, source, d);
    return;
  }
  const where = d.line ? `${relativePath(store.workspace?.path, source)}:${d.line}:${d.column ?? 1}` : '';
  const head = `${d.code ?? 'error'}${where ? ` — ${where}` : ''}\n  ${d.message ?? json.message}\n`;
  const node = el('span.diag', {
    text: head,
    on: {
      click: async () => {
        if (!d.line || !source) return;
        const doc = await openFile(source);
        if (doc) {
          const editor = monaco.editor.getEditors().find((e) => e.getModel() === doc.model);
          const range = markerRange(doc.model, d.line, d.column ?? 1);
          editor?.setSelection(range);
          editor?.revealRangeInCenter(range);
        }
      },
    },
  });
  terminal.appendNode(node);
  for (const hint of d.hints ?? []) terminal.append(`  ヒント: ${hint}\n`, 'hint');
  for (const related of d.related ?? []) {
    const text = typeof related === 'string' ? related : `${related.message ?? ''} ${related.source ?? ''}:${related.line ?? ''}:${related.column ?? ''}`;
    terminal.append(`  関連: ${text}\n`, 'system');
  }
  for (const cause of d.causes ?? []) terminal.append(`  原因: ${typeof cause === 'string' ? cause : JSON.stringify(cause)}\n`, 'system');
  if (d.line && source) addProblem(task.kind === 'check' ? CHECK_OWNER : RUN_OWNER, source, d);
}

function handleOutput(task, stream, text) {
  if (stream !== 'stderr') {
    if (!task.quiet) terminal.append(text, stream === 'system' ? 'system' : undefined);
    task.stdout += text.length < 1e6 ? text : '';
    return;
  }
  task.stderrCarry += text;
  const lines = task.stderrCarry.split('\n');
  task.stderrCarry = lines.pop();
  for (const line of lines) {
    const json = parseDiagnostic(line);
    if (json) renderDiagnostic(json, task);
    else if (!task.quiet) terminal.append(line + '\n', 'stderr');
  }
}

const KIND_LABEL = {
  run: '実行', record: '記録', check: 'チェック', test: 'テスト', build: 'ビルド', compile: 'コンパイル', profile: 'プロファイル', doc: 'API 文書',
};

/**
 * Starts a task. Resolves with {code, trace, stdout} when it ends.
 * `quiet` tasks (check on save) do not take over the panel.
 */
export async function startTask(kind, { file = null, quiet = false, filter } = {}) {
  if (!store.workspace) {
    notify('フォルダーを開いてから実行してください。', 'warning');
    return null;
  }
  if (!store.toolchain) {
    notify(`rewind が見つかりません。設定で場所を指定してください。\n${store.toolchainError ?? ''}`, 'error', [
      { label: '設定を開く', action: () => emit('command', 'view.settings') },
    ]);
    return null;
  }
  if (!quiet && current) {
    notify('別のプログラムが実行中です。停止してから実行してください。', 'warning', [{ label: '停止', action: () => stopTask() }]);
    return null;
  }
  const effects = runOptions.effects ?? store.settings.defaultEffects ?? '';
  const request = {
    kind,
    file,
    effects: ['run', 'record', 'profile', 'compile'].includes(kind) ? effects : '',
    args: ['run', 'record'].includes(kind) ? runOptions.args : [],
    steps: runOptions.steps,
    filter: filter ?? null,
  };
  let started;
  try {
    started = await call('task_start', { request });
  } catch (error) {
    if (!quiet) notify(`${KIND_LABEL[kind]}を開始できませんでした。\n${errorText(error)}`, 'error');
    return null;
  }
  return new Promise((resolve) => {
    const task = {
      id: started.id,
      kind,
      file,
      quiet,
      cwd: started.cwd,
      interactive: kind === 'run' || kind === 'record' || kind === 'profile',
      stdout: '',
      stderrCarry: '',
      started: performance.now(),
      resolve,
    };
    tasks.set(task.id, task);
    if (!quiet) {
      clearProblems(kind === 'check' ? CHECK_OWNER : RUN_OWNER);
      terminal.append(`\n▶ ${started.commandLine}\n`, 'command');
      if (effects && request.effects) terminal.append(`  許可した効果: ${effects}\n`, 'system');
      showPanel('terminal');
      setRunning(task);
      if (task.interactive) input.focus();
    } else {
      clearProblems(CHECK_OWNER);
    }
  });
}

export async function stopTask() {
  if (!current) return;
  await call('task_kill', { id: current.id }).catch(() => {});
}

function finish({ id, code, elapsedMs, trace }) {
  const task = tasks.get(id);
  if (!task) return;
  tasks.delete(id);
  if (task.stderrCarry) handleOutput(task, 'stderr', '\n');
  if (!task.quiet) {
    const seconds = (elapsedMs / 1000).toFixed(2);
    const ok = code === 0;
    const status = code === null ? '停止しました' : ok ? '正常に終了しました' : `終了コード ${code}`;
    terminal.append(`■ ${KIND_LABEL[task.kind]}: ${status}（${seconds} 秒）\n`, ok ? 'ok' : 'system');
    if (current?.id === id) setRunning(null);
    emit('task-finished', { kind: task.kind, code });
  }
  task.resolve({ code, trace, stdout: task.stdout });
}

// Commands ---------------------------------------------------------------------------------

async function targetFile() {
  const doc = activeDoc();
  const project = store.workspace?.project;
  if (doc?.isRewind && doc.path) {
    if (doc.dirty) await saveDoc(doc);
    return doc.path;
  }
  if (project?.entry && store.workspace) {
    return joinPath(store.workspace.path, project.entry.replace(/\//g, store.platform === 'windows' ? '\\' : '/'));
  }
  if (doc && !doc.path) {
    if (await saveDoc(doc)) return doc.path;
    return null;
  }
  notify('実行する .rw ファイルを開いてください。', 'warning');
  return null;
}

async function saveAllDirty() {
  for (const doc of allDocs()) if (doc.dirty && doc.path) await saveDoc(doc);
}

export async function runActive() {
  const file = await targetFile();
  if (file) {
    await saveAllDirty();
    await startTask('run', { file });
  }
}

/** Records a debug trace of the active file; resolves to the trace path when it succeeded. */
export async function recordActive() {
  const file = await targetFile();
  if (!file) return null;
  await saveAllDirty();
  const result = await startTask('record', { file });
  if (!result) return null;
  if (!result.trace) return null;
  try {
    const stamp = await call('file_stamp', { path: result.trace });
    if (!stamp) {
      terminal.append('記録ファイルが作られませんでした（コンパイルエラーの可能性があります）。\n', 'stderr');
      return null;
    }
  } catch {
    return null;
  }
  return { trace: result.trace, file };
}

export async function checkActive() {
  await saveAllDirty();
  const doc = activeDoc();
  const file = store.workspace?.project ? null : doc?.isRewind ? doc.path : null;
  const result = await startTask('check', { file });
  if (result?.code === 0) terminal.append('✓ 誤りは見つかりませんでした\n', 'ok');
}

export async function simpleTask(kind) {
  if (kind === 'test' || kind === 'build') {
    if (!store.workspace?.project) {
      notify('テストとビルドには rewind.toml のあるフォルダーが必要です。', 'warning');
      return;
    }
    await saveAllDirty();
    let filter = null;
    if (kind === 'test' && runOptions.testFilter) filter = runOptions.testFilter;
    await startTask(kind, { filter });
    return;
  }
  const file = await targetFile();
  if (!file) return;
  await saveAllDirty();
  await startTask(kind, { file });
}

export async function configureRun() {
  const args = await prompt('プログラムの引数（空白区切り、"..." で空白を含められます）', {
    value: runOptions.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '),
  });
  if (args === undefined) return;
  runOptions.args = [...args.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  const effects = await prompt('許可する効果（例: fileRead,fileWrite,env,clock,gui,network）', {
    value: runOptions.effects ?? store.settings.defaultEffects ?? '',
    validate: (v) => (v === '' || /^[A-Za-z0-9]+(,[A-Za-z0-9]+)*$/.test(v.replace(/\s/g, '')) ? '' : 'カンマ区切りの名前で指定してください'),
  });
  if (effects === undefined) return;
  runOptions.effects = effects.replace(/\s/g, '');
  const steps = await prompt('命令数の上限（--steps、空なら指定なし）', {
    value: runOptions.steps ? String(runOptions.steps) : '',
    validate: (v) => (v === '' || /^\d{1,15}$/.test(v) ? '' : '正の整数で指定してください'),
  });
  if (steps === undefined) return;
  runOptions.steps = steps ? Number(steps) : null;
  notify('実行の設定を更新しました。', 'success');
}

/** Saving a REWIND file checks it with the compiler when the language server is not running. */
export async function checkOnSave(doc) {
  if (!store.settings.checkOnSave || !doc.isRewind || !doc.path || !store.toolchain || !store.workspace) return;
  if (lspStatus() === 'ready' || current) return;
  const result = await startTask('check', { file: store.workspace.project ? null : doc.path, quiet: true });
  if (!result) return;
  log('チェック', result.code === 0 ? `${basename(doc.path)}: 誤りはありません` : `${basename(doc.path)}: 誤りがあります`);
}

export function initRun() {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && current) {
      const text = input.value;
      history.unshift(text);
      history.length = Math.min(history.length, 100);
      historyIndex = -1;
      terminal.append(text + '\n', 'command');
      call('task_input', { id: current.id, text: text + '\n' }).catch((err) => terminal.append(errorText(err) + '\n', 'system'));
      input.value = '';
    } else if (e.key === 'ArrowUp' && history.length) {
      historyIndex = Math.min(historyIndex + 1, history.length - 1);
      input.value = history[historyIndex];
    } else if (e.key === 'ArrowDown') {
      historyIndex = Math.max(historyIndex - 1, -1);
      input.value = historyIndex < 0 ? '' : history[historyIndex];
    } else if (e.key === 'd' && e.ctrlKey && current) {
      call('task_close_input', { id: current.id });
      terminal.append('[入力を閉じました]\n', 'system');
    } else return;
    e.preventDefault();
  });
  const eof = el('button.btn', {
    text: 'EOF',
    title: '入力を閉じる (Ctrl+D)',
    on: { click: () => current && call('task_close_input', { id: current.id }).then(() => terminal.append('[入力を閉じました]\n', 'system')) },
  });
  const view = el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } },
    terminal.el,
    el('div.console-input', {}, el('span.prompt', { text: '入力 ›' }), input, eof),
  );
  addPanelView('terminal', 'ターミナル', view, [
    stopButton,
    el('button.icon-btn', { title: 'ターミナルを消去', text: '⌫', on: { click: () => terminal.clear() } }),
  ]);
  on('task-output', ({ id, stream, text }) => {
    const task = tasks.get(id);
    if (task) handleOutput(task, stream, text);
  });
  on('task-exit', finish);
}

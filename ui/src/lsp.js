// The language client: keeps `rewind lsp` in step with the open REWIND files and turns its
// answers into Monaco features (diagnostics, hover, completion, definition, references, rename,
// signature help, formatting, code actions, outline). Positions: Monaco and LSP both count
// UTF-16 code units; Monaco is 1-based, LSP 0-based.
import { monaco } from './monaco.js';
import { call, on, errorText } from './ipc.js';
import { store, emit, subscribe, log } from './store.js';
import { allDocs, findDoc, loadDoc } from './documents.js';
import { LANGUAGE_ID, SNIPPETS } from './rewind-lang.js';
import { notify, pathKey } from './ui.js';
import { localSymbols } from './symbols.js';

export const OWNER = 'rewind';

const state = {
  status: 'off', // off | starting | ready | error
  generation: 0,
  capabilities: {},
  restarts: [],
};
/** doc -> {version, changes[], timer} */
const sync = new Map();
/** pathKey -> LSP diagnostics for files without a model */
export const detachedDiagnostics = new Map();

export function lspStatus() {
  return state.status;
}

function setStatus(status, detail) {
  state.status = status;
  emit('lsp-status', { status, detail });
}

// URIs in the form REWIND writes them (`file:///C:/dir/a%20b.rw`).
export function toLspUri(path) {
  let text = path.replace(/\\/g, '/');
  const encoded = [...new TextEncoder().encode(text)]
    .map((b) => {
      const c = String.fromCharCode(b);
      return /[A-Za-z0-9/\-._~:]/.test(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0');
    })
    .join('');
  return encoded.startsWith('//') ? `file:${encoded}` : `file:///${encoded.replace(/^\/+/, '')}`;
}

export function fromLspUri(uri) {
  if (!uri?.startsWith('file:')) return null;
  let rest = uri.slice('file:'.length).replace(/^\/\/(localhost)?/, '');
  const bytes = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '%' && /^[0-9a-fA-F]{2}$/.test(rest.slice(i + 1, i + 3))) {
      bytes.push(parseInt(rest.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...new TextEncoder().encode(rest[i]));
    }
  }
  let path = new TextDecoder().decode(new Uint8Array(bytes));
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  if (store.platform === 'windows') path = path.replace(/\//g, '\\');
  return path;
}

const toPosition = (p) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const toRange = (r) => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});
const fromRange = (r) =>
  new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);

function inWorkspace(path) {
  const root = store.workspace?.path;
  if (!root || !path) return false;
  const key = pathKey(path);
  const rootKey = pathKey(root);
  return key.startsWith(rootKey + '\\') || key.startsWith(rootKey + '/');
}

function eligible(doc) {
  return doc && doc.path && doc.isRewind && inWorkspace(doc.path);
}

function docForModel(model) {
  return allDocs().find((d) => d.model === model);
}

// Lifecycle ---------------------------------------------------------------------------------

export async function startLsp() {
  if (!store.workspace || !store.toolchain) {
    setStatus('off');
    return;
  }
  setStatus('starting');
  sync.clear();
  try {
    const result = await call('lsp_start');
    state.generation = result.generation;
    state.capabilities = result.capabilities ?? {};
    setStatus('ready', result.serverInfo);
    log('言語サーバー', `起動しました: ${result.serverInfo?.name ?? 'rewind'} ${result.serverInfo?.version ?? ''}`);
    for (const doc of allDocs()) openInServer(doc);
  } catch (error) {
    setStatus('error', errorText(error));
    log('言語サーバー', `起動できませんでした: ${errorText(error)}`);
  }
}

export async function stopLsp() {
  sync.clear();
  setStatus('off');
  await call('lsp_stop').catch(() => {});
  monaco.editor.removeAllMarkers(OWNER);
  detachedDiagnostics.clear();
  emit('problems-changed');
}

function openInServer(doc) {
  if (state.status !== 'ready' || !eligible(doc) || sync.has(doc)) return;
  sync.set(doc, { version: 1, changes: [], timer: null });
  call('lsp_notify', {
    method: 'textDocument/didOpen',
    params: {
      textDocument: { uri: toLspUri(doc.path), languageId: LANGUAGE_ID, version: 1, text: doc.model.getValue() },
    },
  }).catch(() => {});
}

/** Sends the edits collected since the last flush (changes are debounced while typing). */
function flush(doc) {
  const entry = sync.get(doc);
  if (!entry || !entry.changes.length) return;
  clearTimeout(entry.timer);
  entry.version += 1;
  const contentChanges = entry.changes;
  entry.changes = [];
  call('lsp_notify', {
    method: 'textDocument/didChange',
    params: { textDocument: { uri: toLspUri(doc.path), version: entry.version }, contentChanges },
  }).catch(() => {});
}

function closeInServer(doc, path = doc.path) {
  const entry = sync.get(doc);
  if (!entry) return;
  clearTimeout(entry.timer);
  sync.delete(doc);
  if (state.status === 'ready' && path) {
    call('lsp_notify', { method: 'textDocument/didClose', params: { textDocument: { uri: toLspUri(path) } } }).catch(() => {});
  }
}

async function request(method, doc, params) {
  if (state.status !== 'ready' || !eligible(doc)) return null;
  openInServer(doc);
  flush(doc);
  try {
    return await call('lsp_request', { method, params: { textDocument: { uri: toLspUri(doc.path) }, ...params } });
  } catch (error) {
    // The server answers with an error while the file does not compile; that is not news.
    log('言語サーバー', `${method}: ${errorText(error)}`);
    return null;
  }
}

// Diagnostics -------------------------------------------------------------------------------

const SEVERITY = {
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint,
};

function toMarker(diagnostic, path, model) {
  let range = diagnostic.range;
  // Module-level diagnostics come at 0:0 with the real position in relatedInformation.
  const empty = range.start.line === 0 && range.start.character === 0 && range.end.line === 0 && range.end.character === 0;
  if (empty) {
    const same = (diagnostic.relatedInformation ?? []).find((r) => pathKey(fromLspUri(r.location.uri) ?? '') === pathKey(path));
    if (same) range = same.location.range;
  }
  let r = fromRange(range);
  if (model && r.isEmpty()) {
    const word = model.getWordAtPosition(r.getStartPosition());
    r = word
      ? new monaco.Range(r.startLineNumber, word.startColumn, r.startLineNumber, word.endColumn)
      : new monaco.Range(r.startLineNumber, r.startColumn, r.startLineNumber, r.startColumn + 1);
  }
  return {
    severity: SEVERITY[diagnostic.severity] ?? monaco.MarkerSeverity.Error,
    message: diagnostic.message,
    code: diagnostic.code ? String(diagnostic.code) : undefined,
    source: diagnostic.source ?? 'rewind',
    startLineNumber: r.startLineNumber,
    startColumn: r.startColumn,
    endLineNumber: r.endLineNumber,
    endColumn: r.endColumn,
    relatedInformation: (diagnostic.relatedInformation ?? [])
      .filter((info) => info.message !== 'diagnostic originates in this module')
      .map((info) => {
        const target = fromLspUri(info.location.uri);
        const rr = fromRange(info.location.range);
        return {
          resource: monaco.Uri.file(target ?? path),
          message: info.message,
          startLineNumber: rr.startLineNumber,
          startColumn: rr.startColumn,
          endLineNumber: rr.endLineNumber,
          endColumn: rr.endColumn,
        };
      }),
  };
}

function onDiagnostics(params) {
  const path = fromLspUri(params.uri);
  if (!path) return;
  const doc = findDoc(path);
  if (doc) {
    monaco.editor.setModelMarkers(doc.model, OWNER, params.diagnostics.map((d) => toMarker(d, path, doc.model)));
    detachedDiagnostics.delete(pathKey(path));
  } else if (params.diagnostics.length) {
    detachedDiagnostics.set(pathKey(path), { path, markers: params.diagnostics.map((d) => toMarker(d, path, null)) });
  } else {
    detachedDiagnostics.delete(pathKey(path));
  }
  emit('problems-changed');
}

// Conversions -------------------------------------------------------------------------------

function markdown(contents) {
  if (!contents) return [];
  if (typeof contents === 'string') return [{ value: contents }];
  if (Array.isArray(contents)) return contents.flatMap(markdown);
  if ('kind' in contents) {
    return [{ value: contents.kind === 'plaintext' ? contents.value.replace(/[\\`*_{}[\]()#+\-.!<>]/g, '\\$&') : contents.value }];
  }
  if ('language' in contents) return [{ value: '```' + contents.language + '\n' + contents.value + '\n```' }];
  return [];
}

// LSP CompletionItemKind (1-based) -> Monaco CompletionItemKind
const K = monaco.languages.CompletionItemKind;
const COMPLETION_KIND = [K.Text, K.Text, K.Method, K.Function, K.Constructor, K.Field, K.Variable, K.Class,
  K.Interface, K.Module, K.Property, K.Unit, K.Value, K.Enum, K.Keyword, K.Snippet, K.Color, K.File,
  K.Reference, K.Folder, K.EnumMember, K.Constant, K.Struct, K.Event, K.Operator, K.TypeParameter];

// LSP SymbolKind (1-based) -> Monaco SymbolKind (0-based, same order)
const symbolKind = (kind) => Math.max(0, (kind ?? 13) - 1);

async function ensureModels(paths) {
  for (const path of paths) {
    if (!findDoc(path)) {
      try {
        await loadDoc(path);
      } catch {
        // A file that cannot be read is skipped; Monaco reports the missing model.
      }
    }
  }
}

async function toLocations(result) {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  const locations = list
    .map((l) => ('targetUri' in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l))
    .map((l) => ({ path: fromLspUri(l.uri), range: fromRange(l.range) }))
    .filter((l) => l.path);
  await ensureModels([...new Set(locations.map((l) => l.path))]);
  return locations.map((l) => ({ uri: findDoc(l.path)?.uri ?? monaco.Uri.file(l.path), range: l.range }));
}

async function toWorkspaceEdit(edit) {
  if (!edit) return { edits: [] };
  const byPath = [];
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) byPath.push([fromLspUri(uri), edits]);
  for (const change of edit.documentChanges ?? []) {
    if (change.textDocument && change.edits) byPath.push([fromLspUri(change.textDocument.uri), change.edits]);
  }
  await ensureModels(byPath.map(([path]) => path).filter(Boolean));
  const edits = [];
  for (const [path, list] of byPath) {
    const doc = path && findDoc(path);
    if (!doc) continue;
    for (const e of list) {
      edits.push({ resource: doc.uri, textEdit: { range: fromRange(e.range), text: e.newText }, versionId: undefined });
    }
  }
  return { edits };
}

/** Formats a document through the server (used by format-on-save). */
export async function formatDocument(doc) {
  const options = { tabSize: store.settings.tabSize, insertSpaces: store.settings.insertSpaces };
  const edits = await request('textDocument/formatting', doc, { options });
  if (!edits?.length) return;
  doc.model.pushEditOperations(
    [],
    edits.map((e) => ({ range: fromRange(e.range), text: e.newText })),
    () => null,
  );
}

/** The outline of a document: from the server, or found locally when it is not available. */
export async function documentSymbols(doc) {
  const result = eligible(doc) ? await request('textDocument/documentSymbol', doc, {}) : null;
  if (!result) return localSymbols(doc.model);
  return result.map(function convert(s) {
    const range = fromRange(s.range ?? s.location.range);
    return {
      name: s.name,
      detail: s.detail ?? '',
      kind: symbolKind(s.kind),
      tags: [],
      range,
      selectionRange: s.selectionRange ? fromRange(s.selectionRange) : range,
      children: (s.children ?? []).map(convert),
    };
  });
}

// Providers --------------------------------------------------------------------------------

function registerProviders() {
  const L = monaco.languages;

  L.registerHoverProvider(LANGUAGE_ID, {
    async provideHover(model, position) {
      const doc = docForModel(model);
      const result = await request('textDocument/hover', doc, { position: toPosition(position) });
      if (!result?.contents) return null;
      return { contents: markdown(result.contents), range: result.range ? fromRange(result.range) : undefined };
    },
  });

  L.registerCompletionItemProvider(LANGUAGE_ID, {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position, context) {
      const doc = docForModel(model);
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const result = await request('textDocument/completion', doc, {
        position: toPosition(position),
        context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter },
      });
      const items = (Array.isArray(result) ? result : result?.items ?? []).map((item) => ({
        label: item.label,
        kind: COMPLETION_KIND[item.kind] ?? K.Text,
        detail: item.detail,
        documentation: item.documentation ? markdown(item.documentation)[0] : undefined,
        insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
        range: item.textEdit?.range ? fromRange(item.textEdit.range) : range,
        sortText: item.sortText,
        filterText: item.filterText,
      }));
      const memberAccess = context.triggerCharacter === '.' || model.getValueInRange(
        new monaco.Range(position.lineNumber, Math.max(1, word.startColumn - 1), position.lineNumber, word.startColumn),
      ) === '.';
      if (!memberAccess) {
        const seen = new Set(items.map((i) => i.label));
        for (const keyword of store.languageInfo?.keywords ?? []) {
          if (!seen.has(keyword)) items.push({ label: keyword, kind: K.Keyword, insertText: keyword, range, sortText: '~' + keyword });
        }
        for (const s of SNIPPETS) {
          items.push({
            label: s.label,
            kind: K.Snippet,
            detail: s.detail,
            insertText: s.body,
            insertTextRules: L.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            sortText: '~~' + s.label,
          });
        }
      }
      return { suggestions: items, incomplete: false };
    },
  });

  L.registerDefinitionProvider(LANGUAGE_ID, {
    async provideDefinition(model, position) {
      return toLocations(await request('textDocument/definition', docForModel(model), { position: toPosition(position) }));
    },
  });

  L.registerReferenceProvider(LANGUAGE_ID, {
    async provideReferences(model, position, context) {
      return toLocations(
        await request('textDocument/references', docForModel(model), {
          position: toPosition(position),
          context: { includeDeclaration: context.includeDeclaration },
        }),
      );
    },
  });

  L.registerRenameProvider(LANGUAGE_ID, {
    async provideRenameEdits(model, position, newName) {
      const result = await request('textDocument/rename', docForModel(model), { position: toPosition(position), newName });
      if (!result) return { edits: [], rejectReason: '名前を変更できませんでした（ファイルにエラーがないか確認してください）' };
      return toWorkspaceEdit(result);
    },
    async resolveRenameLocation(model, position) {
      const doc = docForModel(model);
      const result = await request('textDocument/prepareRename', doc, { position: toPosition(position) });
      const word = model.getWordAtPosition(position);
      if (!result) {
        if (state.status === 'ready' && eligible(doc)) return { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: 'ここでは名前を変更できません' };
        return { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: '言語サーバーが動いていません' };
      }
      const range = fromRange(result.range ?? result);
      return { range, text: result.placeholder ?? model.getValueInRange(range) ?? word?.word ?? '' };
    },
  });

  L.registerSignatureHelpProvider(LANGUAGE_ID, {
    signatureHelpTriggerCharacters: ['(', ','],
    async provideSignatureHelp(model, position) {
      const result = await request('textDocument/signatureHelp', docForModel(model), { position: toPosition(position) });
      if (!result?.signatures?.length) return null;
      return {
        value: {
          signatures: result.signatures.map((s) => ({
            label: s.label,
            documentation: s.documentation ? markdown(s.documentation)[0] : undefined,
            parameters: (s.parameters ?? []).map((p) => ({ label: p.label, documentation: p.documentation ? markdown(p.documentation)[0] : undefined })),
          })),
          activeSignature: result.activeSignature ?? 0,
          activeParameter: result.activeParameter ?? 0,
        },
        dispose() {},
      };
    },
  });

  L.registerDocumentFormattingEditProvider(LANGUAGE_ID, {
    displayName: 'REWIND',
    async provideDocumentFormattingEdits(model, options) {
      const result = await request('textDocument/formatting', docForModel(model), {
        options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
      });
      return (result ?? []).map((e) => ({ range: fromRange(e.range), text: e.newText }));
    },
  });

  L.registerCodeActionProvider(LANGUAGE_ID, {
    async provideCodeActions(model, range, context) {
      const doc = docForModel(model);
      const diagnostics = context.markers
        .filter((m) => m.owner === OWNER || !m.owner)
        .map((m) => ({
          range: toRange(m),
          message: m.message,
          severity: m.severity === monaco.MarkerSeverity.Error ? 1 : m.severity === monaco.MarkerSeverity.Warning ? 2 : 3,
          code: m.code,
          source: m.source,
        }));
      const result = await request('textDocument/codeAction', doc, { range: toRange(range), context: { diagnostics } });
      const actions = [];
      for (const action of result ?? []) {
        if (!action.edit) continue;
        actions.push({
          title: action.title,
          kind: action.kind ?? 'quickfix',
          isPreferred: action.isPreferred,
          diagnostics: context.markers,
          edit: await toWorkspaceEdit(action.edit),
        });
      }
      return { actions, dispose() {} };
    },
  });

  L.registerDocumentSymbolProvider(LANGUAGE_ID, {
    displayName: 'REWIND',
    async provideDocumentSymbols(model) {
      const doc = docForModel(model);
      return doc ? documentSymbols(doc) : localSymbols(model);
    },
  });
}

// Wiring -----------------------------------------------------------------------------------

export function initLsp() {
  registerProviders();
  on('lsp-notification', ({ generation, method, params }) => {
    if (generation !== state.generation) return;
    if (method === 'textDocument/publishDiagnostics') onDiagnostics(params);
    else if (method === 'window/logMessage') log('言語サーバー', params?.message ?? '');
    else if (method === 'window/showMessage') notify(params?.message ?? '', params?.type === 1 ? 'error' : 'info');
  });
  on('lsp-log', ({ generation, line }) => {
    if (generation === state.generation) log('言語サーバー', line);
  });
  on('lsp-exit', ({ generation }) => {
    if (generation !== state.generation || state.status === 'off') return;
    sync.clear();
    setStatus('error', '終了しました');
    const now = Date.now();
    state.restarts = state.restarts.filter((t) => now - t < 60_000);
    if (state.restarts.length < 3) {
      state.restarts.push(now);
      log('言語サーバー', '予期せず終了したため、再起動します');
      setTimeout(startLsp, 500);
    } else {
      notify('言語サーバーが繰り返し終了しました。', 'error', [{ label: '再起動', action: startLsp }]);
    }
  });
  subscribe('doc-opened', (doc) => openInServer(doc));
  subscribe('doc-closed', (doc) => {
    closeInServer(doc);
    if (doc.path) monaco.editor.setModelMarkers(doc.model, OWNER, []);
  });
  subscribe('doc-changed', ({ doc, event }) => {
    const entry = sync.get(doc);
    if (!entry) return;
    for (const change of event.changes) {
      entry.changes.push({ range: toRange(change.range), rangeLength: change.rangeLength, text: change.text });
    }
    // Large paste or many edits: one full-text replacement is cheaper than a long list.
    if (entry.changes.length > 200) entry.changes = [{ text: doc.model.getValue() }];
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flush(doc), 250);
  });
  subscribe('doc-saved', (doc) => {
    if (!sync.has(doc)) {
      openInServer(doc);
      return;
    }
    flush(doc);
    call('lsp_notify', { method: 'textDocument/didSave', params: { textDocument: { uri: toLspUri(doc.path) } } }).catch(() => {});
  });
}

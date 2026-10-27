// Open documents: one Monaco model per file, saving with conflict detection, reloading when the
// file changes on disk, untitled buffers.
import { monaco } from './monaco.js';
import { call, errorText } from './ipc.js';
import { store, emit } from './store.js';
import { ask, basename, notify, pathKey } from './ui.js';
import { LANGUAGE_ID } from './rewind-lang.js';

let untitledCounter = 0;
/** pathKey (or untitled id) -> Doc */
const docs = new Map();

export class Doc {
  constructor({ path, text, stamp = null, bom = false, readOnly = false }) {
    this.path = path;
    this.stamp = stamp;
    this.bom = bom;
    this.readOnly = readOnly;
    this.deleted = false;
    if (path) {
      this.key = pathKey(path);
      this.uri = monaco.Uri.file(path);
    } else {
      untitledCounter += 1;
      this.untitled = `Untitled-${untitledCounter}`;
      this.key = `untitled:${this.untitled}`;
      this.uri = monaco.Uri.parse(`untitled:${this.untitled}`);
    }
    this.model = monaco.editor.createModel(text, languageFor(path), this.uri);
    this.applyOptions();
    this.savedAlt = this.model.getAlternativeVersionId();
    this.wasDirty = false;
    this.model.onDidChangeContent((event) => {
      emit('doc-changed', { doc: this, event });
      if (this.dirty !== this.wasDirty) {
        this.wasDirty = this.dirty;
        emit('doc-dirty', this);
      }
    });
  }

  get name() {
    return this.path ? basename(this.path) : this.untitled;
  }

  get dirty() {
    return this.model.getAlternativeVersionId() !== this.savedAlt;
  }

  get isRewind() {
    return this.model.getLanguageId() === LANGUAGE_ID;
  }

  applyOptions() {
    const s = store.settings;
    this.model.updateOptions({ tabSize: s.tabSize, indentSize: s.tabSize, insertSpaces: s.insertSpaces });
  }

  markSaved() {
    this.savedAlt = this.model.getAlternativeVersionId();
    this.wasDirty = false;
    emit('doc-dirty', this);
  }
}

function languageFor(path) {
  return path && /\.rw$/i.test(path) ? LANGUAGE_ID : 'plaintext';
}

export function allDocs() {
  return [...docs.values()];
}

export function findDoc(path) {
  return docs.get(pathKey(path));
}

export function findDocByUri(uri) {
  const text = uri.toString();
  return allDocs().find((d) => d.uri.toString() === text);
}

/** Returns the open document for `path`, reading the file the first time. */
export async function loadDoc(path) {
  const existing = findDoc(path);
  if (existing) return existing;
  const file = await call('read_text_file', { path });
  // Another call may have loaded it while this one waited.
  const raced = findDoc(file.path);
  if (raced) return raced;
  const doc = new Doc({ path: file.path, text: file.text, stamp: file.stamp, bom: file.bom, readOnly: file.readOnly });
  docs.set(doc.key, doc);
  emit('doc-opened', doc);
  return doc;
}

export function newUntitled(text = '') {
  const doc = new Doc({ path: null, text });
  monaco.editor.setModelLanguage(doc.model, LANGUAGE_ID);
  docs.set(doc.key, doc);
  emit('doc-opened', doc);
  return doc;
}

export function disposeDoc(doc) {
  if (!docs.has(doc.key)) return;
  docs.delete(doc.key);
  emit('doc-closed', doc);
  doc.model.dispose();
}

/** Formats with the language server first when the user asked for it. */
async function beforeSave(doc) {
  if (store.settings.formatOnSave && doc.isRewind) {
    const { formatDocument } = await import('./lsp.js');
    await formatDocument(doc).catch(() => {});
  }
}

/** Saves; resolves to true when the file was written. */
export async function saveDoc(doc, { saveAs = false } = {}) {
  let path = doc.path;
  if (!path || saveAs) {
    path = await call('save_file_dialog', { suggested: doc.path ? basename(doc.path) : `${doc.name}.rw` });
    if (!path) return false;
  }
  if (path === doc.path) await beforeSave(doc);
  const text = doc.model.getValue();
  const write = (force) =>
    call('write_text_file', {
      path,
      text,
      bom: doc.bom,
      expected: path === doc.path && !doc.deleted ? doc.stamp : null,
      force,
    });
  let stamp;
  try {
    stamp = await write(false);
  } catch (error) {
    const message = errorText(error);
    if (!message.startsWith('CONFLICT')) {
      notify(`${basename(path)} を保存できませんでした。\n${message}`, 'error');
      return false;
    }
    const choice = await ask(
      `${basename(path)} はディスク上で変更されています`,
      'ほかのプログラムがこのファイルを書き換えました。どちらを残しますか。',
      [
        { label: 'キャンセル', value: 'cancel' },
        { label: 'ディスクの内容を読み込む', value: 'reload' },
        { label: '上書きする', value: 'overwrite', primary: true },
      ],
    );
    if (choice === 'reload') {
      await reloadDoc(doc);
      return false;
    }
    if (choice !== 'overwrite') return false;
    try {
      stamp = await write(true);
    } catch (again) {
      notify(`${basename(path)} を保存できませんでした。\n${errorText(again)}`, 'error');
      return false;
    }
  }
  if (path !== doc.path) {
    rebind(doc, path);
  }
  doc.stamp = stamp;
  doc.deleted = false;
  doc.markSaved();
  emit('doc-saved', doc);
  return true;
}

/** Moves a document to a new path (save as, rename in the explorer). */
export function rebind(doc, newPath) {
  const old = { key: doc.key, uri: doc.uri, model: doc.model };
  const alt = doc.model.getAlternativeVersionId();
  const savedOffset = doc.savedAlt === alt;
  docs.delete(doc.key);
  emit('doc-closed', doc);
  doc.path = newPath;
  doc.untitled = undefined;
  doc.key = pathKey(newPath);
  doc.uri = monaco.Uri.file(newPath);
  const existing = monaco.editor.getModel(doc.uri);
  existing?.dispose();
  doc.model = monaco.editor.createModel(old.model.getValue(), languageFor(newPath), doc.uri);
  doc.applyOptions();
  doc.savedAlt = savedOffset ? doc.model.getAlternativeVersionId() : -1;
  doc.model.onDidChangeContent((event) => {
    emit('doc-changed', { doc, event });
    if (doc.dirty !== doc.wasDirty) {
      doc.wasDirty = doc.dirty;
      emit('doc-dirty', doc);
    }
  });
  docs.set(doc.key, doc);
  emit('doc-rebound', { doc, oldModel: old.model });
  emit('doc-opened', doc);
  old.model.dispose();
}

export async function reloadDoc(doc) {
  if (!doc.path) return;
  try {
    const file = await call('read_text_file', { path: doc.path });
    if (file.text !== doc.model.getValue()) {
      doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: file.text }], () => null);
    }
    doc.stamp = file.stamp;
    doc.bom = file.bom;
    doc.readOnly = file.readOnly;
    doc.deleted = false;
    doc.markSaved();
  } catch (error) {
    notify(`${doc.name} を読み込めませんでした。\n${errorText(error)}`, 'error');
  }
}

/** Compares open files with the disk; called when the window regains focus. */
export async function checkExternalChanges() {
  for (const doc of allDocs()) {
    if (!doc.path) continue;
    let stamp;
    try {
      stamp = await call('file_stamp', { path: doc.path });
    } catch {
      continue;
    }
    if (!stamp) {
      if (!doc.deleted) {
        doc.deleted = true;
        emit('doc-dirty', doc);
        notify(`${doc.name} はディスクから削除されました。保存すると作り直します。`, 'warning');
      }
      continue;
    }
    if (doc.stamp && stamp.modifiedMs === doc.stamp.modifiedMs && stamp.len === doc.stamp.len) continue;
    if (!doc.dirty) {
      await reloadDoc(doc);
    } else if (!doc.conflictNotified) {
      doc.conflictNotified = true;
      notify(`${doc.name} はほかのプログラムで変更されました。編集中の内容があります。`, 'warning', [
        { label: 'ディスクから読み込む', action: () => { doc.conflictNotified = false; reloadDoc(doc); } },
        { label: '編集中の内容を残す', action: () => { doc.conflictNotified = false; doc.stamp = stamp; } },
      ]);
    }
  }
}

/** Asks about unsaved documents. Resolves to false when the user cancels. */
export async function confirmDiscard(list, what = '閉じる') {
  const dirty = list.filter((d) => d.dirty);
  if (!dirty.length) return true;
  const names = dirty.map((d) => `・${d.name}`).join('\n');
  const choice = await ask(
    dirty.length === 1 ? `${dirty[0].name} の変更を保存しますか?` : `${dirty.length} 個のファイルの変更を保存しますか?`,
    `${names}\n\n保存しないと、変更は失われます。`,
    [
      { label: 'キャンセル', value: 'cancel' },
      { label: `保存せずに${what}`, value: 'discard' },
      { label: `保存して${what}`, value: 'save', primary: true },
    ],
  );
  if (choice === 'discard') return true;
  if (choice !== 'save') return false;
  for (const doc of dirty) {
    if (!(await saveDoc(doc))) return false;
  }
  return true;
}

// A local outline for when the language server cannot answer (no compiler, a file outside the
// folder). It follows `rewind tokens`' rules: comments and strings are skipped, `fn` inside an
// `impl` or `trait` body is a method.
import { monaco } from './monaco.js';

const DECLARATIONS = new Set(['fn', 'struct', 'record', 'enum', 'trait', 'impl', 'const', 'type']);
const S = monaco.languages.SymbolKind;
const KIND = { fn: S.Function, method: S.Method, struct: S.Struct, record: S.Struct, enum: S.Enum, trait: S.Interface, impl: S.Class, const: S.Constant, type: S.TypeParameter };

function* words(text) {
  let i = 0;
  let line = 1;
  let col = 1;
  const n = text.length;
  const advance = (count) => {
    for (let k = 0; k < count && i < n; k++) {
      if (text[i] === '\n') { line++; col = 1; } else col++;
      i++;
    }
  };
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') advance(1);
    } else if (c === '/' && text[i + 1] === '*') {
      let depth = 0;
      while (i < n) {
        if (text[i] === '/' && text[i + 1] === '*') { depth++; advance(2); }
        else if (text[i] === '*' && text[i + 1] === '/') { depth--; advance(2); if (!depth) break; }
        else advance(1);
      }
    } else if (c === '"') {
      let quotes = 0;
      while (text[i + quotes] === '"') quotes++;
      if (quotes >= 3) {
        advance(quotes);
        const close = '"'.repeat(quotes);
        while (i < n && text.slice(i, i + quotes) !== close) advance(1);
        advance(quotes);
      } else {
        advance(1);
        while (i < n && text[i] !== '"' && text[i] !== '\n') advance(text[i] === '\\' ? 2 : 1);
        advance(1);
      }
    } else if (/[\p{L}_]/u.test(c)) {
      const start = i;
      const startLine = line;
      const startCol = col;
      while (i < n && /[\p{L}\p{N}_]/u.test(text[i])) advance(1);
      yield { kind: 'word', text: text.slice(start, i), line: startLine, col: startCol, endCol: col };
    } else if ('{};'.includes(c)) {
      yield { kind: c, line, col };
      advance(1);
    } else {
      advance(1);
    }
  }
}

export function localSymbols(model) {
  const result = [];
  const braces = [];
  let containerPending = false;
  let previous = null;
  const tokens = [...words(model.getValue())];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === '{') {
      braces.push(containerPending);
      containerPending = false;
    } else if (token.kind === '}') {
      braces.pop();
    } else if (token.kind === ';') {
      containerPending = false;
    } else if (DECLARATIONS.has(token.text) && previous?.text !== '.') {
      const name = tokens[index + 1];
      if (name?.kind !== 'word') continue;
      if (token.text === 'trait' || token.text === 'impl') containerPending = true;
      const kind = token.text === 'fn' && braces[braces.length - 1] === true ? 'method' : token.text;
      const range = new monaco.Range(name.line, name.col, name.line, name.endCol);
      result.push({ name: name.text, detail: '', kind: KIND[kind] ?? S.Function, tags: [], range, selectionRange: range, children: [] });
    }
    previous = token;
  }
  return result;
}

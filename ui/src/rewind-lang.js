// The REWIND language for Monaco: a tokenizer built from `rewind editor-info` (with a built-in
// copy of the 4.0.0 words for when no compiler is found), editing rules, themes and snippets.
import { monaco } from './monaco.js';

export const LANGUAGE_ID = 'rewind';

const FALLBACK_INFO = {
  keywords: ['fn', 'let', 'var', 'const', 'struct', 'record', 'enum', 'trait', 'impl', 'type', 'import',
    'as', 'pub', 'private', 'async', 'mut', 'if', 'else', 'match', 'while', 'for', 'in', 'break',
    'continue', 'return', 'defer', 'using', 'commit', 'revert', 'resume', 'drop', 'publish',
    'branch', 'runtime', 'external', 'begin', 'move', 'spawn', 'await'],
  contextualKeywords: ['value', 'capture', 'borrow', 'force', 'live', 'fresh', 'test', 'where', 'effects', 'captures'],
  literalWords: ['true', 'false', 'None'],
  removedWords: ['null'],
};

// The words that make REWIND what it is get their own colour.
const HISTORY_WORDS = ['commit', 'revert', 'resume', 'drop', 'publish', 'branch', 'begin'];
const DECLARATION_WORDS = ['fn', 'struct', 'record', 'enum', 'trait', 'impl', 'type', 'const', 'let', 'var'];
// Control flow gets Visual Studio's "control keyword" colour.
const CONTROL_WORDS = ['if', 'else', 'match', 'while', 'for', 'in', 'break', 'continue', 'return', 'await', 'spawn', 'defer'];

export function registerRewind(editorInfo) {
  const info = editorInfo && Array.isArray(editorInfo.keywords) ? editorInfo : FALLBACK_INFO;
  const keywords = info.keywords.filter((w) => !HISTORY_WORDS.includes(w));
  monaco.languages.register({ id: LANGUAGE_ID, extensions: ['.rw'], aliases: ['REWIND', 'rewind'] });

  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, {
    unicode: true,
    defaultToken: '',
    keywords,
    historyWords: HISTORY_WORDS.filter((w) => info.keywords.includes(w)),
    declarationWords: DECLARATION_WORDS,
    controlWords: CONTROL_WORDS.filter((w) => info.keywords.includes(w)),
    literals: info.literalWords ?? FALLBACK_INFO.literalWords,
    removed: info.removedWords ?? [],
    contextual: info.contextualKeywords ?? [],
    tokenizer: {
      root: [
        { include: '@whitespace' },
        [/"{3,}/, { token: 'string.raw', next: '@raw.$0' }],
        [/"/, { token: 'string.quote', next: '@string' }],
        [/0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+/, 'number'],
        [/\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?/, 'number'],
        // A capitalised word is a type or a variant (or the literal None).
        [/\p{Lu}[\p{L}\p{N}_]*/, { cases: { '@literals': 'constant', '@default': 'type.identifier' } }],
        // A lower-case word directly followed by `(` is a call, unless it is a keyword.
        [/[\p{L}_][\p{L}\p{N}_]*(?=\s*\()/, {
          cases: {
            '@historyWords': 'keyword.history',
            '@controlWords': 'keyword.control',
            '@keywords': 'keyword',
            '@literals': 'constant',
            '@default': 'function',
          },
        }],
        [/[\p{L}_][\p{L}\p{N}_]*/, {
          cases: {
            '@historyWords': 'keyword.history',
            '@controlWords': 'keyword.control',
            '@keywords': 'keyword',
            '@literals': 'constant',
            '@removed': 'invalid',
            '@default': 'identifier',
          },
        }],
        [/[{}()[\]]/, '@brackets'],
        [/==|!=|<=|>=|&&|\|\||\+=|-=|\*=|\/=|%=|->|=>|::|\.\./, 'operator'],
        [/[=+\-*/%.!<>?:|&]/, 'operator'],
        [/[,;]/, 'delimiter'],
        [/./, 'invalid'],
      ],
      whitespace: [
        [/\s+/, 'white'],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
      ],
      // Block comments nest.
      comment: [
        [/[^/*]+/, 'comment'],
        [/\/\*/, 'comment', '@push'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
      string: [
        [/[^\\"$]+/, 'string'],
        [/\\./, 'string.escape'],
        [/\$\{/, { token: 'delimiter.interpolation', next: '@interpolation' }],
        [/\$/, 'string'],
        [/"/, { token: 'string.quote', next: '@pop' }],
      ],
      interpolation: [
        [/\}/, { token: 'delimiter.interpolation', next: '@pop' }],
        [/\{/, { token: 'delimiter.bracket', next: '@braces' }],
        { include: '@root' },
      ],
      braces: [
        [/\}/, { token: 'delimiter.bracket', next: '@pop' }],
        [/\{/, { token: 'delimiter.bracket', next: '@push' }],
        { include: '@root' },
      ],
      // Raw strings close with the same number of quotes that opened them ($S2).
      raw: [
        [/[^"]+/, 'string.raw'],
        [/"+/, { cases: { '$0==$S2': { token: 'string.raw', next: '@pop' }, '@default': 'string.raw' } }],
      ],
    },
  });

  monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string', 'comment'] },
      { open: '/*', close: ' */', notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
    ],
    wordPattern: /(-?\d*\.\d\w*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g,
    indentationRules: {
      increaseIndentPattern: /^.*(\{[^}"']*|\([^)"']*|\[[^\]"']*)$/,
      decreaseIndentPattern: /^\s*[}\])].*$/,
    },
    onEnterRules: [
      {
        beforeText: /^\s*\/\*\*(?!\/)([^*]|\*(?!\/))*$/,
        afterText: /^\s*\*\/$/,
        action: { indentAction: monaco.languages.IndentAction.IndentOutdent, appendText: ' * ' },
      },
      { beforeText: /^\s*\/\*\*(?!\/)([^*]|\*(?!\/))*$/, action: { indentAction: monaco.languages.IndentAction.None, appendText: ' * ' } },
      { beforeText: /^(\t|( {2}))* \*( ([^*]|\*(?!\/))*)?$/, action: { indentAction: monaco.languages.IndentAction.None, appendText: '* ' } },
    ],
    folding: { markers: { start: /^\s*\/\/\s*#?region\b/, end: /^\s*\/\/\s*#?endregion\b/ } },
  });

  defineThemes();
  return info;
}

// Colours follow Visual Studio's Dark and Light/Blue editor themes; the history words of REWIND
// (commit, revert, publish…) keep a colour of their own.
function defineThemes() {
  monaco.editor.defineTheme('epoch-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '569cd6' },
      { token: 'keyword.control', foreground: 'd8a0df' },
      { token: 'keyword.history', foreground: 'ff9e3d', fontStyle: 'bold' },
      { token: 'constant', foreground: '569cd6' },
      { token: 'type.identifier', foreground: '4ec9b0' },
      { token: 'function', foreground: 'dcdcaa' },
      { token: 'identifier', foreground: '9cdcfe' },
      { token: 'number', foreground: 'b5cea8' },
      { token: 'string', foreground: 'd69d85' },
      { token: 'string.quote', foreground: 'd69d85' },
      { token: 'string.raw', foreground: 'd69d85' },
      { token: 'string.escape', foreground: 'ffd68f' },
      { token: 'delimiter.interpolation', foreground: 'ffd68f', fontStyle: 'bold' },
      { token: 'comment', foreground: '57a64a' },
      { token: 'operator', foreground: 'b4b4b4' },
      { token: 'delimiter', foreground: 'b4b4b4' },
      { token: 'invalid', foreground: 'ff6464', fontStyle: 'underline' },
    ],
    colors: {
      'editor.background': '#1e1e1e',
      'editor.foreground': '#dcdcdc',
      'editorLineNumber.foreground': '#2b91af',
      'editorLineNumber.activeForeground': '#2b91af',
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#464646',
      'editor.selectionBackground': '#264f78',
      'editor.inactiveSelectionBackground': '#3a3d41',
      'editorIndentGuide.background1': '#404040',
      'editorGutter.background': '#1e1e1e',
      'editorBracketMatch.background': '#0e4583',
      'editorBracketMatch.border': '#00000000',
      'minimap.background': '#1e1e1e',
      'editorWidget.background': '#252526',
      'editorWidget.border': '#3f3f46',
      'editorSuggestWidget.background': '#1b1b1c',
      'editorSuggestWidget.selectedBackground': '#264f78',
      'editorHoverWidget.background': '#1b1b1c',
    },
  });
  monaco.editor.defineTheme('epoch-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '0000ff' },
      { token: 'keyword.control', foreground: '8f08c4' },
      { token: 'keyword.history', foreground: 'c25700', fontStyle: 'bold' },
      { token: 'constant', foreground: '0000ff' },
      { token: 'type.identifier', foreground: '2b91af' },
      { token: 'function', foreground: '74531f' },
      { token: 'identifier', foreground: '1f377f' },
      { token: 'number', foreground: '000000' },
      { token: 'string', foreground: 'a31515' },
      { token: 'string.quote', foreground: 'a31515' },
      { token: 'string.raw', foreground: '800000' },
      { token: 'string.escape', foreground: 'b776fb' },
      { token: 'delimiter.interpolation', foreground: 'b776fb', fontStyle: 'bold' },
      { token: 'comment', foreground: '008000' },
      { token: 'operator', foreground: '000000' },
      { token: 'delimiter', foreground: '000000' },
      { token: 'invalid', foreground: 'e51400', fontStyle: 'underline' },
    ],
    colors: {
      'editorLineNumber.foreground': '#2b91af',
      'editorLineNumber.activeForeground': '#2b91af',
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#e5e5e5',
      'editor.selectionBackground': '#add6ff',
      'editorBracketMatch.background': '#dbe0e6',
      'editorBracketMatch.border': '#00000000',
    },
  });
}

export function monacoTheme(theme) {
  return theme === 'dark' ? 'epoch-dark' : 'epoch-light';
}

/** Snippets offered next to the language server's completions. */
export const SNIPPETS = [
  { label: 'main', detail: 'fn main() -> Int', body: 'fn main() -> Int {\n\t$0\n\treturn 0;\n}' },
  { label: 'fn', detail: '関数', body: 'fn ${1:name}(${2}) -> ${3:Int} {\n\t$0\n}' },
  { label: 'commit/revert', detail: '保存点を作り、戻す', body: 'commit ${1:point};\n$0\nrevert ${1:point};' },
  { label: 'publish', detail: '保留中の出力を確定する', body: 'publish;' },
  { label: 'match', detail: 'match 式', body: 'match ${1:value} {\n\t${2:Some(x)} => {\n\t\t$0\n\t},\n\t${3:None} => {},\n}' },
  { label: 'if', detail: 'if 文', body: 'if ${1:condition} {\n\t$0\n}' },
  { label: 'ifelse', detail: 'if / else', body: 'if ${1:condition} {\n\t$2\n} else {\n\t$0\n}' },
  { label: 'for', detail: 'for ループ', body: 'for ${1:x} in ${2:0..n} {\n\t$0\n}' },
  { label: 'while', detail: 'while ループ', body: 'while ${1:condition} {\n\t$0\n}' },
  { label: 'struct', detail: '構造体', body: 'struct ${1:Name} {\n\t${2:field}: ${3:Int},\n}' },
  { label: 'enum', detail: '列挙型', body: 'enum ${1:Name} {\n\t${2:Variant},\n}' },
  { label: 'impl', detail: 'impl ブロック', body: 'impl ${1:Type} {\n\t$0\n}' },
  { label: 'trait', detail: 'trait', body: 'trait ${1:Name} {\n\t$0\n}' },
  { label: 'import', detail: '標準ライブラリの import', body: 'import std.${1:text} as ${2:text};' },
  { label: 'println', detail: 'Out.println', body: 'Out.println(${1});' },
];

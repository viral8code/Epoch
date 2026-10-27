// Tools > Options: a modal dialog with a category tree, in the manner of Visual Studio. Values
// are validated again (and clamped) by the backend before they are saved.
import { call, errorText } from './ipc.js';
import { store, emit } from './store.js';
import { el, notify } from './ui.js';

const PAGES = [
  { id: 'general', parent: '環境', title: '全般' },
  { id: 'fonts', parent: '環境', title: 'フォントおよび色' },
  { id: 'editor', parent: 'テキスト エディター', title: 'REWIND' },
  { id: 'toolchain', parent: 'REWIND', title: 'ツールチェーン' },
  { id: 'run', parent: 'REWIND', title: '実行とデバッグ' },
];

let draft = null;

function field(label, input, help) {
  return el('label.field', {}, el('span', { text: label }), input, help ? el('small', { text: help }) : null);
}

function check(label, key, help) {
  const input = el('input', { type: 'checkbox', checked: !!draft[key] });
  input.addEventListener('change', () => { draft[key] = input.checked; });
  return el('label.check', {}, input, el('div', {}, el('div', { text: label }), help ? el('small', { text: help }) : null));
}

function number(key, min, max) {
  const input = el('input', { type: 'number', min, max, value: draft[key], style: { width: '120px' } });
  input.addEventListener('change', () => { draft[key] = Number(input.value); });
  return input;
}

function text(key, placeholder = '') {
  const input = el('input', { value: draft[key] ?? '', placeholder, spellcheck: false });
  input.addEventListener('input', () => { draft[key] = input.value; });
  return input;
}

function page(id) {
  if (id === 'general') {
    const theme = el('select', { style: { width: '200px' } },
      el('option', { value: 'dark', text: 'ダーク' }),
      el('option', { value: 'light', text: '淡色' }),
      el('option', { value: 'blue', text: '青' }),
    );
    theme.value = draft.theme;
    theme.addEventListener('change', () => { draft.theme = theme.value; });
    return [el('h3', { text: '視覚効果' }), field('配色テーマ', theme, 'Visual Studio と同じく、ダーク・淡色・青から選べます。')];
  }
  if (id === 'fonts') {
    return [
      el('h3', { text: 'テキスト エディター' }),
      field('フォント', text('fontFamily')),
      field('サイズ', number('fontSize', 8, 48)),
      field('行の高さ（0 で自動）', number('lineHeight', 0, 80)),
    ];
  }
  if (id === 'editor') {
    return [
      el('h3', { text: 'タブ' }),
      field('タブのサイズ / インデントのサイズ', number('tabSize', 1, 16)),
      check('空白の挿入', 'insertSpaces', 'オフにするとタブを保持します。'),
      el('h3', { text: '表示' }),
      check('右端で折り返す', 'wordWrap'),
      check('スクロール バーにマップ モードを使用する（ミニマップ）', 'minimap'),
      check('スペースとタブを表示する', 'renderWhitespace'),
      el('h3', { text: '保存' }),
      check('保存時にドキュメントをフォーマットする', 'formatOnSave', '言語サーバーの整形（rewind fmt と同じ規則）を使います。'),
      check('自動保存', 'autoSave', '編集が止まってから少し後に保存します。'),
      field('自動保存までの時間（ミリ秒）', number('autoSaveDelayMs', 200, 60000)),
    ];
  }
  if (id === 'toolchain') {
    const status = store.toolchain
      ? `検出: ${store.toolchain.version}\n${store.toolchain.path}`
      : `見つかりません: ${store.toolchainError ?? ''}`;
    const path = text('rewindPath', '空欄なら PATH から探します');
    return [
      el('h3', { text: 'rewind コマンド' }),
      field('rewind の場所',
        el('div.inline', {}, path, el('button.btn', {
          text: '参照…',
          on: {
            click: async () => {
              const picked = await call('pick_rewind_dialog');
              if (picked) {
                draft.rewindPath = picked;
                path.value = picked;
              }
            },
          },
        })),
        `${status}\n開いているフォルダーの中にある rewind は、安全のため実行しません。`,
      ),
      check('保存時にチェックする', 'checkOnSave', '言語サーバーが動いていないとき、保存のたびに rewind check で誤りを調べます。'),
    ];
  }
  if (id === 'run') {
    return [
      el('h3', { text: '効果（--allow-effects）' }),
      field('既定で許可する効果', text('defaultEffects', '例: fileRead,fileWrite'),
        '実行と、デバッグのための記録で渡します。空なら標準の効果（入出力・引数・ロケール・乱数・タスク）だけです。\nファイル・環境変数・時刻・GUI・ネットワークは、ここか「実行の設定」で明示したときだけ許可されます。'),
      el('h3', { text: 'デバッグ' }),
      el('small', { text: 'F5 は、プログラムを --record-mode debug で記録しながら実行し、その記録をデバッガーで開きます。\nデバッグ中はプログラムを再実行せず、記録を前後に移動します（ステップ バック・逆方向に続行）。' }),
    ];
  }
  return [];
}

export function showOptions(initial = 'general') {
  draft = { ...store.settings };
  const backdrop = el('div.backdrop');
  const pane = el('div.form');
  const nav = el('div.nav');
  let current = initial;
  const renderNav = () => {
    const rows = [];
    let lastParent = null;
    for (const p of PAGES) {
      if (p.parent !== lastParent) {
        rows.push(el('div.row', {}, el('span.twisty', { text: '▾' }), el('span.label', { text: p.parent })));
        lastParent = p.parent;
      }
      rows.push(el('div.row.child' + (p.id === current ? '.selected' : ''), {
        on: { click: () => { current = p.id; renderNav(); pane.replaceChildren(...page(current)); } },
      }, el('span.label', { text: p.title })));
    }
    nav.replaceChildren(...rows);
  };
  const close = () => {
    backdrop.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const save = async () => {
    try {
      const result = await call('save_settings', { settings: draft });
      store.settings = result.settings;
      store.toolchain = result.toolchain ?? null;
      store.toolchainError = result.toolchainError ?? null;
      emit('settings-changed', store.settings);
      close();
    } catch (error) {
      notify(`設定を保存できませんでした。\n${errorText(error)}`, 'error');
    }
  };
  renderNav();
  pane.replaceChildren(...page(current));
  backdrop.append(
    el('div.options', { role: 'dialog', 'aria-modal': 'true' },
      el('div.dlg-title', {}, el('span', { text: 'オプション' }), el('button.icon-btn', { text: '✕', on: { click: close } })),
      el('div.split', {}, nav, el('div.pane', {}, pane)),
      el('div.foot', {},
        el('small', { text: `Epoch ${store.version}`, style: { marginRight: 'auto', color: 'var(--fg-muted)' } }),
        el('button.btn.primary', { text: 'OK', on: { click: save } }),
        el('button.btn', { text: 'キャンセル', on: { click: close } }),
      ),
    ),
  );
  window.addEventListener('keydown', onKey, true);
  document.getElementById('overlay-root').append(backdrop);
}

export async function saveSettingsPatch(patch) {
  const result = await call('save_settings', { settings: { ...store.settings, ...patch } });
  store.settings = result.settings;
  emit('settings-changed', store.settings);
}

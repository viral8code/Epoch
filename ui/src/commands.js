// Commands, their keyboard shortcuts and the command palette.
import { quickPick } from './ui.js';
import { activeEditor } from './editors.js';
import { subscribe } from './store.js';

const commands = new Map();

/** register('file.save', {label: '保存', key: 'Ctrl+S', run}) */
export function register(id, spec) {
  commands.set(id, { id, ...spec });
}

export function run(id, ...args) {
  const command = commands.get(id);
  if (!command) {
    console.warn('unknown command', id);
    return;
  }
  if (command.enabled && !command.enabled()) return;
  return command.run(...args);
}

export function command(id) {
  return commands.get(id);
}

function normalize(event) {
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  let key = event.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  if (event.code === 'Backquote') key = '`';
  if (event.code === 'Backslash' || event.code === 'IntlYen') key = '\\';
  if (event.code === 'Comma') key = ',';
  parts.push(key);
  return parts.join('+');
}

export function initKeybindings() {
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.isComposing || event.keyCode === 229) return; // IME conversion in progress
      if (document.querySelector('.backdrop')) return; // dialogs handle their own keys
      const combo = normalize(event);
      for (const command of commands.values()) {
        if (!command.key) continue;
        const keys = Array.isArray(command.key) ? command.key : [command.key];
        if (!keys.includes(combo)) continue;
        if (command.when && !command.when()) continue;
        event.preventDefault();
        event.stopPropagation();
        run(command.id);
        return;
      }
    },
    true,
  );
  subscribe('command', (id) => run(id));
}

function shortcut(command) {
  return (Array.isArray(command.key) ? command.key[0] : command.key) ?? command.menuKey;
}

/** The palette lists app commands and the active editor's own actions. */
export async function showPalette(initial = '') {
  const items = [...commands.values()]
    .filter((c) => c.label && (!c.enabled || c.enabled()))
    .map((c) => ({ label: c.label, description: c.category ?? '', key: shortcut(c), value: () => run(c.id) }));
  const editor = activeEditor();
  if (editor?.getModel()) {
    const seen = new Set(items.map((i) => i.label));
    for (const action of editor.getSupportedActions()) {
      if (!action.label || seen.has(action.label)) continue;
      seen.add(action.label);
      items.push({ label: action.label, description: 'エディター', value: () => { editor.focus(); action.run(); } });
    }
  }
  items.sort((a, b) => a.label.localeCompare(b.label, 'ja'));
  const picked = await quickPick({ placeholder: '実行するコマンドを入力', items, value: initial, matchOn: 'description' });
  picked?.value();
}

export function menuItem(id) {
  const c = commands.get(id);
  if (!c) return null;
  return { label: c.menuLabel ?? c.label, key: shortcut(c), disabled: c.enabled ? !c.enabled() : false, action: () => run(id) };
}

// The checkpoint timeline of a recording: one lane per task, `commit` / `revert` / `publish`
// and the other history operations in order. A revert is joined by an arc to the commit it
// returns to. Clicking an operation opens its source line.
import { monaco } from './monaco.js';
import { call, errorText } from './ipc.js';
import { store, subscribe } from './store.js';
import { el, notify, joinPath, relativePath, basename } from './ui.js';
import { addPanelView, showPanel } from './panels.js';
import { openFile } from './editors.js';

const NS = 'http://www.w3.org/2000/svg';
const STYLE = {
  ApplicationEntry: { color: 'var(--fg-faint)', shape: 'dot', label: '開始' },
  Halt: { color: 'var(--fg-faint)', shape: 'dot', label: '終了' },
  Commit: { color: 'var(--info)', shape: 'circle', label: 'commit' },
  Revert: { color: 'var(--history)', shape: 'diamond', label: 'revert' },
  Resume: { color: 'var(--warning)', shape: 'diamond', label: 'resume' },
  Drop: { color: 'var(--fg-muted)', shape: 'cross', label: 'drop' },
  Branch: { color: 'var(--accent)', shape: 'circle', label: 'branch' },
  Publish: { color: 'var(--publish)', shape: 'square', label: 'publish' },
  Spawn: { color: 'var(--fg-muted)', shape: 'dot', label: 'spawn' },
  Await: { color: 'var(--fg-muted)', shape: 'dot', label: 'await' },
};

let current = null;
const info = el('span', { text: '記録がありません' });
const filterSelect = el('select', { title: '表示する操作' },
  el('option', { value: 'history', text: 'commit / revert / publish' }),
  el('option', { value: 'all', text: 'すべての操作' }),
);
const canvas = el('div.timeline-canvas');
const table = el('div.tree', { style: { flex: '0 1 30%', minHeight: '0', overflow: 'auto', borderTop: '1px solid var(--border)' } });

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function shape(kind, x, y) {
  const style = STYLE[kind] ?? STYLE.Spawn;
  // CSS variables work in `style`, not in presentation attributes.
  const style_ = `fill:${style.color}`;
  switch (style.shape) {
    case 'circle': return svg('circle', { cx: x, cy: y, r: 7, style: style_ });
    case 'square': return svg('rect', { x: x - 6.5, y: y - 6.5, width: 13, height: 13, rx: 2, style: style_ });
    case 'diamond': return svg('path', { d: `M${x} ${y - 8} L${x + 8} ${y} L${x} ${y + 8} L${x - 8} ${y} Z`, style: style_ });
    case 'cross': return svg('path', { d: `M${x - 6} ${y - 6} L${x + 6} ${y + 6} M${x + 6} ${y - 6} L${x - 6} ${y + 6}`, style: `fill:none;stroke:${style.color};stroke-width:2.5` });
    default: return svg('circle', { cx: x, cy: y, r: 4, style: style_ });
  }
}

function sourcePath(source) {
  const base = current?.sourceRoot ?? store.workspace?.path;
  if (!source || !base) return null;
  return joinPath(base, source.replace(/\//g, store.platform === 'windows' ? '\\' : '/'));
}

function openRow(row) {
  const path = sourcePath(row.source);
  if (path && row.line) openFile(path, { selection: new monaco.Range(row.line, row.column || 1, row.line, row.column || 1) });
}

function render() {
  if (!current) {
    canvas.replaceChildren(el('div.empty', {},
      el('div', { text: 'F5（記録してデバッグ）で記録すると、ここに commit・revert・publish の流れが表示されます。' }),
      el('button.btn', { text: '記録ファイルを開く…', on: { click: pickTrace } }),
    ));
    table.replaceChildren();
    return;
  }
  const { timeline } = current;
  const rows = timeline.rows.filter((r) => filterSelect.value === 'all' || !['Spawn', 'Await'].includes(r.operation));
  const tasks = [...new Set(rows.map((r) => r.task))].sort((a, b) => a - b);
  const laneY = new Map(tasks.map((t, i) => [t, 46 + i * 64]));
  const step = 46;
  const left = 110;
  const width = left + Math.max(rows.length, 1) * step + 60;
  const height = 46 + tasks.length * 64 + 20;
  const root = svg('svg', { width, height, role: 'img', 'aria-label': 'チェックポイントのタイムライン' });

  tasks.forEach((task) => {
    const y = laneY.get(task);
    root.append(svg('line', { class: 'lane', x1: left - 20, y1: y, x2: width - 20, y2: y }));
    root.append(svg('text', { class: 'lane-label', x: 12, y: y + 4 }, task === 0 ? 'main タスク' : `タスク ${task}`));
  });

  // Arcs from each revert back to the latest earlier commit with the same name.
  const lastCommit = new Map();
  rows.forEach((row, i) => {
    const x = left + i * step;
    const y = laneY.get(row.task);
    if (row.operation === 'Commit' && row.name) lastCommit.set(`${row.task}|${row.name}`, { x, y });
    if ((row.operation === 'Revert' || row.operation === 'Resume') && row.name) {
      const target = lastCommit.get(`${row.task}|${row.name}`);
      if (target) {
        const lift = Math.min(36, 14 + (x - target.x) / 12);
        root.append(svg('path', { class: 'arc', d: `M${x} ${y - 9} C ${x} ${y - lift - 9}, ${target.x} ${target.y - lift - 9}, ${target.x} ${target.y - 9}` }));
      }
    }
  });

  rows.forEach((row, i) => {
    const x = left + i * step;
    const y = laneY.get(row.task);
    const group = svg('g', { class: 'node', tabindex: 0 });
    group.append(svg('title', {}, `#${row.event} ${STYLE[row.operation]?.label ?? row.operation}${row.name ? ' ' + row.name : ''}\n${row.source}:${row.line}:${row.column}\n${row.text}`));
    group.append(shape(row.operation, x, y));
    const caption = row.name ?? (row.operation === 'Publish' ? 'publish' : '');
    if (caption) group.append(svg('text', { x, y: y + 22, 'text-anchor': 'middle' }, caption.length > 10 ? caption.slice(0, 9) + '…' : caption));
    group.addEventListener('click', () => openRow(row));
    group.addEventListener('keydown', (e) => { if (e.key === 'Enter') openRow(row); });
    root.append(group);
  });
  canvas.replaceChildren(root);

  table.replaceChildren(
    ...rows.map((row) =>
      el('div.row', { style: { paddingLeft: '12px' }, on: { click: () => openRow(row) } },
        el('span.icon', { text: '●', style: { color: STYLE[row.operation]?.color ?? 'var(--fg-muted)' } }),
        el('span.label', { text: `${STYLE[row.operation]?.label ?? row.operation}${row.name ? ' ' + row.name : ''}` }),
        el('span.desc', { text: row.text }),
        el('span.trail', { text: `#${row.event}  ${row.source}:${row.line}` }),
      ),
    ),
  );
  const r = timeline.result;
  const result = !r ? '' : r.ok === true || r.error === null ? '成功' : `失敗: ${JSON.stringify(r.error ?? r).slice(0, 100)}`;
  info.textContent = `${relativePath(store.workspace?.path, current.trace)} — 全 ${timeline.totalEvents.toLocaleString()} 命令中 ${timeline.rows.length.toLocaleString()} 件${timeline.limited ? '（上限で打ち切り）' : ''}${result ? ` — 結果 ${result}` : ''}`;
}

export async function loadTimeline(trace, sourceRoot) {
  try {
    const timeline = await call('load_timeline', { trace, sourceRoot });
    current = { trace, sourceRoot, timeline };
    render();
  } catch (error) {
    notify(`タイムラインを読み込めませんでした。\n${errorText(error)}`, 'error');
  }
}

async function pickTrace() {
  const trace = await call('open_trace_dialog').catch((e) => notify(errorText(e), 'error'));
  if (trace) {
    await loadTimeline(trace, store.workspace?.path ?? null);
    showPanel('timeline');
  }
}

export function initTimeline() {
  filterSelect.addEventListener('change', render);
  const view = el('div.timeline', {},
    el('div.timeline-bar', {},
      info,
      filterSelect,
      el('div.legend', {},
        ...['Commit', 'Revert', 'Publish', 'Resume', 'Drop'].map((k) => el('span', {}, el('span', { text: '●', style: { color: STYLE[k].color } }), STYLE[k].label)),
      ),
    ),
    canvas,
    table,
  );
  addPanelView('timeline', '履歴タイムライン', view, [
    el('button.icon-btn', { title: '記録ファイルを開く', text: '📂', on: { click: pickTrace } }),
    el('button.icon-btn', { title: '再読み込み', text: '⟳', on: { click: () => current && loadTimeline(current.trace, current.sourceRoot) } }),
  ]);
  subscribe('trace-recorded', ({ trace, sourceRoot }) => loadTimeline(trace, sourceRoot));
  render();
}

export function timelineFileName() {
  return current ? basename(current.trace) : null;
}

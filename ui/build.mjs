// Bundles the window into ui/dist: one script, one stylesheet, the editor worker and fonts.
// Everything is served from the app itself; the window loads nothing from the network.
//
//   npm ci && npm run build        (once, and after changing ui/src)
//   npm run watch                  (rebuild on change while developing)

import * as esbuild from 'esbuild';
import { readFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const monacoEditor = join(here, 'node_modules', 'monaco-editor', 'esm', 'vs', 'editor');

// Monaco's editor.main.js also pulls in ~80 languages and the TypeScript/CSS/HTML/JSON
// services. Epoch edits REWIND (plus plain text), so the entry keeps every editor feature but
// drops those, which removes most of the bundle.
const monacoEntry = {
  name: 'monaco-epoch',
  setup(build) {
    build.onResolve({ filter: /^monaco-epoch$/ }, () => ({ path: 'monaco-epoch', namespace: 'monaco-epoch' }));
    // Japanese UI strings (not reachable through the package's export map).
    build.onResolve({ filter: /^monaco-nls-ja$/ }, () => ({
      path: join(here, 'node_modules', 'monaco-editor', 'esm', 'vs', 'nls', 'lang', 'ja.js'),
    }));
    build.onLoad({ filter: /.*/, namespace: 'monaco-epoch' }, () => {
      const source = readFileSync(join(monacoEditor, 'editor.main.js'), 'utf8');
      const kept = source
        .split('\n')
        .filter((line) => !/languages\/(definitions|features)\/|monaco-lsp-client|export \{ (index as lsp|__src_languages)/.test(line))
        .join('\n');
      return { contents: kept, resolveDir: monacoEditor, loader: 'js' };
    });
  },
};

// Monaco 0.57 vendors DOMPurify 3.4.15, which has known sanitizer bypasses (GHSA-p98j-92pf-mc4p
// and others). Its sanitizer renders hover and completion markdown from the language server, so
// the bundle uses the patched release pinned in package.json instead.
const patchedDompurify = {
  name: 'patched-dompurify',
  setup(build) {
    build.onResolve({ filter: /\/dompurify\/dompurify\.js$/ }, () => ({
      path: join(here, 'node_modules', 'dompurify', 'dist', 'purify.es.mjs'),
    }));
  },
};

const watch = process.argv.includes('--watch');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
copyFileSync(join(here, 'src', 'index.html'), join(dist, 'index.html'));

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  target: ['chrome120'],
  legalComments: 'external',
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: { app: join(here, 'src', 'main.js') },
    outdir: dist,
    format: 'esm',
    loader: { '.ttf': 'file', '.css': 'css' },
    assetNames: 'assets/[name]-[hash]',
    plugins: [monacoEntry, patchedDompurify],
  }),
  esbuild.context({
    ...common,
    entryPoints: { 'editor.worker': join(monacoEditor, 'editor.worker.js') },
    outdir: dist,
    format: 'iife',
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}

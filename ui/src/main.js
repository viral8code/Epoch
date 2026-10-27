// Monaco reads its UI strings at module evaluation, so the Japanese table loads first.
import 'monaco-nls-ja';
import './styles.css';
import { start } from './app.js';

start().catch((error) => {
  console.error(error);
  document.body.textContent = `Epoch を起動できませんでした: ${error?.message ?? error}`;
});

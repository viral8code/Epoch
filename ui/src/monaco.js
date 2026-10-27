// Monaco, without its bundled languages (see build.mjs). The editor worker is served by the app.
import * as monaco from 'monaco-epoch';

self.MonacoEnvironment = {
  getWorker() {
    return new Worker(new URL('./editor.worker.js', document.baseURI));
  },
};

export default monaco;
export { monaco };

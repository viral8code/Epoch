// Shared application state and a tiny event bus between the modules of the window.

export const store = {
  settings: null,
  toolchain: null,
  toolchainError: null,
  platform: 'windows',
  version: '',
  /** {path, name, project} of the open folder, or null. */
  workspace: null,
};

const listeners = new Map();

export function subscribe(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

export function emit(event, data) {
  for (const handler of listeners.get(event) ?? []) {
    try {
      handler(data);
    } catch (error) {
      console.error(`listener for ${event} failed`, error);
    }
  }
}

/** The output log ("出力" panel). Modules write here instead of the console. */
export function log(channel, text) {
  emit('log', { channel, text, time: new Date() });
}

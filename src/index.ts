import { LocalTranslationPlugin } from './lifecycle';

let instance: LocalTranslationPlugin | null = null;

export interface StartupParams {
  id: string;
  version: string;
  rootURI: string;
}

async function startup(params: StartupParams): Promise<void> {
  if (instance) {
    await instance.shutdown();
    instance = null;
  }
  instance = new LocalTranslationPlugin(params);
  await instance.startup();
}

async function shutdown(): Promise<void> {
  if (!instance) return;
  const current = instance;
  instance = null;
  await current.shutdown();
}

function install(): void {
  // nothing to do: assets are prepared on first use, not at install time
}

function uninstall(): void {
  // never touch user PDFs, library data or the project model
}

const api = {
  startup,
  shutdown,
  install,
  uninstall,
  get instance(): LocalTranslationPlugin | null {
    return instance;
  },
  openPreferences(): void {
    instance?.openPreferences();
  },
};

(globalThis as unknown as Record<string, unknown>).__ZoteroTranslate = api;

export default api;

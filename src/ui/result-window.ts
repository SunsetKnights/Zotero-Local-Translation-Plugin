import type { TranslationTask } from '../../shared/types';

export interface ResultWindowCallbacks {
  onCancel(task: TranslationTask): void;
  onRetry(task: TranslationTask): void;
  onCopy(text: string): void;
  onSettings(): void;
}

interface ResultWindowView {
  render(task: TranslationTask): void;
  setStatus(text: string): void;
}

interface PluginWindow extends Window {
  __ztInit?: (payload: { callbacks: ResultWindowCallbacks; task: TranslationTask }) => void;
  __ztView?: ResultWindowView;
}

interface WindowEntry {
  win: PluginWindow;
  task: TranslationTask;
}

/**
 * One non-modal result window per reader. The window never owns model state: the
 * plugin pushes task snapshots into it, which keeps late responses from the
 * previous selection out of the UI.
 */
export class ResultWindowRegistry {
  private readonly windows = new Map<string, WindowEntry>();
  private readonly rootURI: string;
  private readonly callbacks: ResultWindowCallbacks;

  constructor(rootURI: string, callbacks: ResultWindowCallbacks) {
    this.rootURI = rootURI;
    this.callbacks = callbacks;
  }


  openOrFocus(readerKey: string, task: TranslationTask): PluginWindow | null {
    const existing = this.windows.get(readerKey);
    if (existing && !existing.win.closed) {
      if (task.generation < existing.task.generation) return existing.win;
      existing.win.focus();
      this.render(readerKey, task);
      return existing.win;
    }
    if (existing) {
      this.windows.delete(readerKey);
    }

    const mainWindow = Zotero.getMainWindow();
    if (!mainWindow) return null;

    const name = `zotero-translation-${readerKey.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    // openDialog expects a XUL document; our result window is HTML, so it is
    // opened as a chrome window and initialized once its document has loaded.
    const win = mainWindow.open(
      'chrome://localtranslation/content/translation.xhtml',
      name,
      'chrome,centerscreen,resizable,width=620,height=560',
    ) as PluginWindow | null;

    if (!win) return null;
    const entry: WindowEntry = { win, task };
    this.windows.set(readerKey, entry);
    const init = () => {
      try {
        if (win.closed || this.windows.get(readerKey) !== entry) {
          win.removeEventListener('load', init);
          return;
        }
        if (!String(win.document?.URL ?? '').includes('translation.xhtml') || !win.__ztInit) return;
        win.__ztInit({ callbacks: this.callbacks, task: entry.task });
        win.removeEventListener('load', init);
      }
      catch {
        // the window was closed while loading
      }
    };
    // The initial about:blank load or a committed document without its script
    // must not consume initialization. Always deliver the most recent task.
    win.addEventListener('load', init);
    init();
    // No unload-based cleanup: Gecko fires unload for the initial about:blank
    // document as well, and at that point the new document may already be
    // committed. Closed windows are pruned lazily in openOrFocus()/render().
    return win;
  }

  render(readerKey: string, task: TranslationTask): void {
    const entry = this.windows.get(readerKey);
    if (!entry) return;
    const { win } = entry;
    if (win.closed) {
      this.windows.delete(readerKey);
      return;
    }
    if (task.generation < entry.task.generation) return;
    entry.task = task;
    win.__ztView?.render(task);
  }

  close(readerKey: string): void {
    const win = this.windows.get(readerKey)?.win;
    this.windows.delete(readerKey);
    if (win && !win.closed) {
      win.close();
    }
  }

  closeAll(): void {
    for (const key of [...this.windows.keys()]) {
      this.close(key);
    }
  }
}

import type { SelectionSnapshot } from '../../../shared/types';

export interface ReaderEvent {
  reader?: { tabID?: string; itemID?: number };
  doc?: Document;
  params?: { annotation?: { text?: string } };
  append?: (...nodes: any[]) => void;
}

export interface ReaderAdapterDeps {
  pluginID: string;
  onSelection(snapshot: SelectionSnapshot): void;
  log(message: string): void;
}

const registered = new Set<string>();

// The reader popup has its own document and resets native button styling.
// Keep these rules with the appended button rather than the result-window CSS.
const SELECTION_BUTTON_CSS = `
  button.zt-translate-button {
    all: unset !important;
    box-sizing: border-box !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    width: calc(100% - 8px) !important;
    min-height: 34px !important;
    margin: 4px !important;
    padding: 7px 14px !important;
    border: 1px solid #0b63ce !important;
    border-radius: 6px !important;
    background: #0b63ce !important;
    color: #fff !important;
    font: inherit !important;
    font-weight: 600 !important;
    line-height: 1.4 !important;
    text-align: center !important;
    cursor: pointer !important;
  }
  button.zt-translate-button:hover {
    background: #0854b3 !important;
    border-color: #0854b3 !important;
  }
  button.zt-translate-button:active {
    background: #064594 !important;
  }
  button.zt-translate-button:focus-visible {
    outline: 2px solid Highlight !important;
    outline-offset: 2px !important;
  }
  @media (prefers-color-scheme: dark) {
    button.zt-translate-button {
      background: #8ac4ff !important;
      border-color: #8ac4ff !important;
      color: #102a43 !important;
    }
    button.zt-translate-button:hover {
      background: #b1d8ff !important;
      border-color: #b1d8ff !important;
    }
    button.zt-translate-button:active {
      background: #70b5fa !important;
    }
  }
`;

/**
 * Adds a "翻译" button to the PDF selection popup.
 *
 * Uses only the documented Reader event payload (event.doc, event.append,
 * event.params.annotation.text) and never touches private reader internals.
 * Rendering the button does not load the model: the work starts on click.
 */
export class ReaderAdapter {
  private handler: ((event: ReaderEvent) => void) | null = null;

  constructor(private readonly deps: ReaderAdapterDeps) {}

  register(): void {
    if (this.handler) return;
    this.handler = (event: ReaderEvent) => this.handleEvent(event);
    Zotero.Reader.registerEventListener('renderTextSelectionPopup', this.handler, this.deps.pluginID);
    registered.add(this.deps.pluginID);
    this.deps.log('reader selection popup listener registered');
  }

  unregister(): void {
    if (!this.handler) return;
    Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', this.handler);
    this.handler = null;
    registered.delete(this.deps.pluginID);
    this.deps.log('reader selection popup listener removed');
  }

  private handleEvent(event: ReaderEvent): void {
    try {
      const text = event?.params?.annotation?.text;
      if (typeof text !== 'string' || text.trim().length === 0) {
        return;
      }
      const doc = event.doc;
      const append = event.append;
      if (!doc || typeof append !== 'function') {
        return;
      }

      const reader = event.reader;
      const readerKey = readerKeyOf(reader);
      const attachmentId = typeof reader?.itemID === 'number' ? reader.itemID : null;

      const button = doc.createElement('button');
      button.textContent = '翻译';
      button.setAttribute('type', 'button');
      button.className = 'zt-translate-button';
      button.addEventListener('click', () => {
        this.deps.onSelection({ readerKey, attachmentId, rawText: text });
      });
      const style = doc.createElement('style');
      style.textContent = SELECTION_BUTTON_CSS;
      append(style, button);
    }
    catch (e) {
      this.deps.log(`selection popup handler failed: ${String(e)}`);
    }
  }
}

export function readerKeyOf(reader?: { tabID?: string; itemID?: number }): string {
  if (reader && typeof reader.tabID === 'string' && reader.tabID.length > 0) {
    return `tab:${reader.tabID}`;
  }
  if (reader && typeof reader.itemID === 'number') {
    return `attachment:${reader.itemID}`;
  }
  return 'attachment:unknown';
}

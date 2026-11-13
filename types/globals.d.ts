// Minimal ambient declarations for the Zotero plugin sandbox and the Gecko
// privileges that Zotero injects (see chrome/content/zotero/xpcom/plugins.js).
// Deliberately narrow: only what this plugin uses.

declare const Zotero: any;
declare const Services: any;
declare const Components: any;
declare const ChromeUtils: {
  importESModule(url: string): any;
};
declare const IOUtils: {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, options?: Record<string, unknown>): Promise<void>;
  readUTF8(path: string): Promise<string>;
  writeUTF8(path: string, data: string): Promise<void>;
  open(path: string, mode: string): Promise<{
    write(bytes: Uint8Array): Promise<void>;
    close(): Promise<void>;
  }>;
  makeDirectory(path: string, options?: { createAncestors?: boolean; ignoreExisting?: boolean }): Promise<void>;
  move(src: string, dest: string): Promise<void>;
  remove(path: string, options?: { recursive?: boolean; ignoreAbsent?: boolean }): Promise<void>;
  stat(path: string): Promise<{ size: number; lastModified: number }>;
};
declare const PathUtils: {
  join(...parts: string[]): string;
  parent(path: string): string;
  tempDir: string;
  profileDir: string;
};
declare const Localization: any;
declare const fetch: (url: string) => Promise<{
  ok: boolean;
  status: number;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
  text(): Promise<string>;
}>;

interface Window {
  arguments?: any[];
  __ztView?: any;
  __ztCloseWithoutPrompt?: () => void;
  Zotero?: any;
}

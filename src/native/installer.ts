// Installs only the native runtime. Model files belong to the user and are
// never extracted, moved, hashed or deleted by this installer.

export interface InstallerLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export interface InstallManifests {
  pluginVersion: string;
  /** Legacy metadata, used only by the caller when migrating an old profile. */
  model?: { file: string; sha256: string; bytes: number };
  runtime: {
    buildId: string;
    /** Engine identity recorded in the generated runtime manifest. */
    engineCommit?: string;
    engineVersion?: string;
    files: Array<{ name: string; sha256: string; bytes: number }>;
  };
}

export interface InstallResult {
  baseDir: string;
  /** Legacy callers may attach these; runtime installation never populates them. */
  modelPath?: string;
  modelSha256?: string;
  helperPath: string;
  runtimeBuildId: string;
}

export interface InstallProgress {
  phase: 'runtime' | 'verify';
  loadedBytes: number;
  totalBytes: number;
}

interface InstallState extends InstallResult {
  installedAt: string;
  pluginVersion: string;
  helperSha256: string;
}

/** Streaming file writer. Zotero's IOUtils has no writable handle API, so the
 *  installer uses the XPCOM byte stream, which was verified in Zotero 10. */
class FileSink {
  private readonly fos: any;
  private readonly bos: any;

  constructor(targetPath: string) {
    const file = Zotero.File.pathToFile(targetPath);
    this.fos = Components.classes['@mozilla.org/network/file-output-stream;1']
      .createInstance(Components.interfaces.nsIFileOutputStream);
    // write | create | truncate
    this.fos.init(file, 0x02 | 0x08 | 0x20, 0o644, 0);
    this.bos = Components.classes['@mozilla.org/binaryoutputstream;1']
      .createInstance(Components.interfaces.nsIBinaryOutputStream);
    this.bos.setOutputStream(this.fos);
  }

  write(bytes: Uint8Array): void {
    this.bos.writeByteArray(bytes, bytes.length);
  }

  close(): void {
    try {
      this.bos.flush();
    }
    catch {
      // already closed
    }
    try {
      this.bos.close();
    }
    catch {
      // already closed
    }
    try {
      this.fos.close();
    }
    catch {
      // already closed
    }
  }
}

export class AssetInstaller {
  constructor(
    private readonly rootURI: string,
    private readonly profileDir: string,
    private readonly manifests: InstallManifests,
    private readonly logger: InstallerLogger,
  ) {}

  private join(...parts: string[]): string {
    return PathUtils.join(...parts);
  }

  private get baseDir(): string {
    return this.join(this.profileDir, 'local-translation');
  }

  private get statePath(): string {
    // Keep install-state.json intact so the plugin can locate the legacy model.
    return this.join(this.baseDir, 'runtime-install-state.json');
  }

  private get runtimeDir(): string {
    return this.join(this.baseDir, 'runtimes', this.manifests.runtime.buildId);
  }

  private get helperTargetPath(): string {
    return this.join(this.runtimeDir, 'translator-host.exe');
  }

  async readState(): Promise<InstallState | null> {
    try {
      if (!(await IOUtils.exists(this.statePath))) return null;
      const text = await IOUtils.readUTF8(this.statePath);
      return JSON.parse(text) as InstallState;
    }
    catch {
      return null;
    }
  }

  /** Verify every executable/library, including on a later plugin startup. */
  async isInstalled(): Promise<boolean> {
    this.validateManifest();
    try {
      const state = await this.readState();
      if (!state || state.runtimeBuildId !== this.manifests.runtime.buildId) return false;
      if (state.baseDir !== this.baseDir || state.helperPath !== this.helperTargetPath) return false;
      for (const file of this.manifests.runtime.files) {
        const target = this.join(this.runtimeDir, file.name);
        if (!(await IOUtils.exists(target))) return false;
        if ((await IOUtils.stat(target)).size !== file.bytes) return false;
        if (await this.fileHash(target) !== file.sha256) return false;
      }
      return true;
    }
    catch {
      return false;
    }
  }

  async ensureInstalled(progress?: (p: InstallProgress) => void): Promise<InstallResult> {
    this.validateManifest();
    const state = await this.readState();
    if (state && (await this.isInstalled())) {
      return state;
    }

    await IOUtils.makeDirectory(this.baseDir, { ignoreExisting: true, createAncestors: true });
    const stagingId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const staging = this.join(this.baseDir, 'staging', stagingId);
    await IOUtils.makeDirectory(staging, { createAncestors: true, ignoreExisting: true });

    let lockOwned = false;
    try {
      await this.installLock();
      lockOwned = true;

      const runtimeFiles = await this.extractRuntime(staging, progress);

      await this.commit(staging, runtimeFiles);
      const helperSha = runtimeFiles.find((f) => f.name.toLowerCase() === 'translator-host.exe')?.sha256 ?? '';

      const result: InstallState = {
        baseDir: this.baseDir,
        helperPath: this.helperTargetPath,
        runtimeBuildId: this.manifests.runtime.buildId,
        installedAt: new Date().toISOString(),
        pluginVersion: this.manifests.pluginVersion,
        helperSha256: helperSha,
      };
      await IOUtils.writeUTF8(this.statePath, JSON.stringify(result, null, 2));
      this.logger.debug(`runtime installed at ${this.runtimeDir}`);
      return result;
    }
    finally {
      await IOUtils.remove(staging, { recursive: true, ignoreAbsent: true }).catch(() => undefined);
      if (lockOwned) await this.releaseLock();
    }
  }

  private get lockPath(): string {
    return this.join(this.baseDir, 'runtime-install.lock');
  }

  private async installLock(): Promise<void> {
    try {
      if (await IOUtils.exists(this.lockPath)) {
        const stat = await IOUtils.stat(this.lockPath);
        const ageMs = Date.now() - stat.lastModified;
        if (ageMs < 10 * 60 * 1000) {
          throw new Error('ASSET_INSTALL_FAILED');
        }
        this.logger.warn('removing stale install lock');
      }
      await IOUtils.writeUTF8(this.lockPath, JSON.stringify({ pid: Services.appinfo.processID, at: Date.now() }));
    }
    catch (e) {
      if (e instanceof Error && e.message === 'ASSET_INSTALL_FAILED') throw e;
      this.logger.warn(`install lock not created: ${String(e)}`);
      throw new Error('ASSET_INSTALL_FAILED');
    }
  }

  private async releaseLock(): Promise<void> {
    await IOUtils.remove(this.lockPath, { ignoreAbsent: true }).catch(() => undefined);
  }

  private payloadUrl(relative: string): string {
    return this.rootURI + 'payload/' + relative;
  }

  private validateManifest(): void {
    const { buildId, files } = this.manifests.runtime;
    if (!/^[a-zA-Z0-9_-]+$/.test(buildId)
      || !files.some((file) => file.name === 'translator-host.exe')
      || new Set(files.map((file) => file.name.toLowerCase())).size !== files.length
      || files.some((file) => !/^[a-zA-Z0-9_.-]+\.(exe|dll)$/i.test(file.name)
        || !/^[a-f0-9]{64}$/.test(file.sha256)
        || !Number.isSafeInteger(file.bytes) || file.bytes <= 0)) {
      throw new Error('ASSET_INSTALL_FAILED');
    }
  }

  private async fileHash(path: string): Promise<string> {
    const bytes = await IOUtils.read(path);
    const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
    return hex(new Uint8Array(digest));
  }

  private async extractRuntime(staging: string, progress?: (p: InstallProgress) => void): Promise<InstallManifests['runtime']['files']> {
    const results: InstallManifests['runtime']['files'] = [];
    for (const file of this.manifests.runtime.files) {
      const target = this.join(staging, file.name);
      const url = this.payloadUrl(`runtime/win-x64/${file.name}`);
      const response = await fetch(url);
      if (!response.ok || !response.body) {
        throw new Error('ASSET_INSTALL_FAILED');
      }
      const sink = new FileSink(target);
      const reader = response.body.getReader();
      let loaded = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          sink.write(value);
          loaded += value.byteLength;
          progress?.({ phase: 'runtime', loadedBytes: loaded, totalBytes: file.bytes });
        }
      }
      finally {
        sink.close();
      }

      if (loaded !== file.bytes || (await IOUtils.stat(target)).size !== file.bytes) {
        throw new Error('ASSET_INSTALL_FAILED');
      }
      progress?.({ phase: 'verify', loadedBytes: 0, totalBytes: file.bytes });
      const sha = await this.fileHash(target);
      if (sha !== file.sha256) {
        throw new Error('ASSET_INSTALL_FAILED');
      }
      progress?.({ phase: 'verify', loadedBytes: file.bytes, totalBytes: file.bytes });
      results.push({ name: file.name, sha256: sha, bytes: file.bytes });
    }
    return results;
  }

  private async commit(staging: string, runtimeFiles: InstallManifests['runtime']['files']): Promise<void> {
    await IOUtils.makeDirectory(this.runtimeDir, { createAncestors: true, ignoreExisting: true });

    for (const file of runtimeFiles) {
      await IOUtils.move(this.join(staging, file.name), this.join(this.runtimeDir, file.name));
    }
  }
}

export function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

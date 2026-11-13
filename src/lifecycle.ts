import type { ReadyInfo, SelectionSnapshot, TranslationTask } from '../shared/types';
import { TranslationController, type HostPort } from './core/controller';
import {
  NativeHostManager,
  type HostConfig,
  type ManagerLogger,
  type ModelStatusKind,
  type ReleaseResult,
  type RestartResult,
  type TranslationHandlers,
} from './native/manager';
import { AssetInstaller, type InstallManifests, type InstallResult } from './native/installer';
import { ZoteroProcessSpawner } from './adapters/zotero/subprocess';
import { ReaderAdapter } from './adapters/zotero/reader';
import {
  IDLE_RELEASE_MAX_MS,
  IDLE_RELEASE_MIN_MS,
  clamp,
  effectiveIdleReleaseMs,
  readSettings,
  writeAutoReleaseModel,
  writeIdleReleaseMs,
  type Settings,
} from './adapters/zotero/prefs';
import { ResultWindowRegistry } from './ui/result-window';
import type { ModelProfile, ModelStore } from '../shared/model-config';
import { applyPreset, createEmptyProfile, createProfile, presets, suggestPresets } from './core/model-config';
import { ModelSelection } from './core/model-selection';
import { MODEL_STORE_PREF, readModelStore, writeModelStore } from './adapters/zotero/model-store';
import { inspectModel, trialModel } from './native/model-probe';

export interface PluginParams {
  id: string;
  version: string;
  rootURI: string;
}
const CONTEXT_TOKENS = 8192;
const SELF_TEST_TEXT = 'The treatment did not improve survival.';

const logger: ManagerLogger = {
  debug: (m: string) => Zotero.debug(`[local-translation] ${m}`),
  warn: (m: string) => Zotero.logError(`[local-translation] ${m}`),
};

function isTerminal(task: TranslationTask): boolean {
  return task.state === 'succeeded' || task.state === 'failed' || task.state === 'cancelled';
}

function idleMsFromMinutes(minutes: number): number {
  const rounded = Math.round(Number(minutes));
  if (!Number.isFinite(rounded)) return IDLE_RELEASE_MIN_MS;
  const maxMinutes = IDLE_RELEASE_MAX_MS / 60_000;
  return clamp(rounded, 1, maxMinutes) * 60_000;
}

function modelStatusText(kind: ModelStatusKind): string {
  switch (kind) {
    case 'loading': return '模型加载中…';
    case 'ready': return '已加载（空闲）';
    case 'busy': return '翻译中（取消尚未完成时也不可释放）';
    case 'releasing': return '正在释放…';
    default: return '未加载';
  }
}

async function waitTask(
  controller: TranslationController,
  requestId: string,
  timeoutMs: number,
): Promise<TranslationTask | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = controller.getTask(requestId);
    if (task && isTerminal(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return controller.getTask(requestId);
}

export class LocalTranslationPlugin {
  private readonly params: PluginParams;
  private settings: Settings;
  private installer: AssetInstaller | null = null;
  private manager: NativeHostManager | null = null;
  private controller: TranslationController | null = null;
  private windows: ResultWindowRegistry | null = null;
  private reader: ReaderAdapter | null = null;
  private notifierID: string | number | null = null;
  private toolsMenuItem: any = null;
  private preferencesWindow: any = null;

  private manifests: InstallManifests | null = null;
  private assets: InstallResult | null = null;
  private assetInstall: Promise<InstallResult> | null = null;
  private taskReader = new Map<string, string>();
  private disposed = false;
  private cachedDevices: Array<{ name: string; description: string; type: string }> = [];
  private devicesProbeAt = 0;
  private modelStore: ModelStore;
  private modelSelection: ModelSelection | null = null;

  constructor(params: PluginParams) {
    this.params = params;
    this.settings = readSettings();
    this.modelStore = readModelStore(undefined, this.settings);
  }

  get pluginID(): string {
    return this.params.id;
  }

  async startup(): Promise<void> {
    this.disposed = false;
    this.manifests = await this.loadManifests();
    this.settings = readSettings();

    await this.migrateModel().catch((error) => logger.warn(`legacy model unavailable: ${String(error)}`));
    this.installer = new AssetInstaller(
      this.params.rootURI,
      Zotero.Profile.dir,
      this.manifests,
      { debug: logger.debug, warn: logger.warn },
    );

    const spawner = new ZoteroProcessSpawner();
    this.manager = new NativeHostManager({
      spawner,
      getConfig: () => this.hostConfig(),
      getParentPid: () => Services.appinfo.processID,
      logger,
    });
    this.modelSelection = new ModelSelection({
      makeAbortController: () => new (Zotero.getMainWindow().AbortController)(),
      getStore: () => this.modelStore,
      saveStore: (store) => { writeModelStore(store); this.modelStore = store; },
      isEngineBusy: () => this.engineInUse(),
      stopEngine: async () => {
        const result = await this.manager!.releaseModel();
        if (result.status === 'busy' || result.status === 'failed') throw new Error('ENGINE_BUSY');
      },
      getDeviceConfig: () => ({ useGpu: this.settings.useGpu, gpuLayers: this.settings.gpuLayers,
        threads: this.settings.threads, runtimeBuildId: this.manifests?.runtime.buildId ?? '' }),
      stat: async (path) => {
        if (!(await IOUtils.exists(path))) throw new Error('MODEL_NOT_FOUND');
        return IOUtils.stat(path);
      },
      inspect: async (path, signal) => {
        const assets = await this.ensureAssets();
        return inspectModel(spawner, assets.helperPath, path, signal);
      },
      trial: async (profile, gpuLayers, signal) => {
        await this.ensureAssets();
        await trialModel({ spawner, config: { ...this.hostConfig(profile), gpuLayers }, profile,
          parentPid: Services.appinfo.processID, logger, signal });
      },
    });

    const host: HostPort = {
      get isReady() {
        return false;
      },
      get info(): ReadyInfo | null {
        return null;
      },
      get busy() {
        return false;
      },
      acquireUsage: (requestId: string) => {
        if (!this.manager) throw new Error('ENGINE_START_FAILED');
        if (this.modelSelection?.locked) throw new Error('ENGINE_BUSY');
        return this.manager.acquireUsage(requestId);
      },
      ensureReady: async () => {
        await this.ensureSelectedModel();
        await this.ensureAssets();
        return this.manager!.ensureReady();
      },
      translate: async (text: string, handlers: TranslationHandlers, requestId?: string) => {
        return this.manager!.translate(text, handlers, requestId);
      },
      cancel: (requestId: string) => this.manager!.cancel(requestId),
    };
    // expose live state without letting the controller poke the manager directly
    Object.defineProperty(host, 'isReady', { get: () => this.manager?.isReady === true });
    Object.defineProperty(host, 'info', { get: () => this.manager?.info ?? null });
    Object.defineProperty(host, 'busy', { get: () => this.manager?.busy === true });

    this.controller = new TranslationController({
      host,
      onUpdate: (task: TranslationTask) => this.onTaskUpdate(task),
      reportError: (task: TranslationTask) => logger.warn(`translation error ${task.errorCode ?? ''}`),
    });

    this.windows = new ResultWindowRegistry(this.params.rootURI, {
      onCancel: (task: TranslationTask) => void this.cancelTask(task),
      onRetry: (task: TranslationTask) => void this.retryTask(task),
      onCopy: (text: string) => this.copyText(text),
      onSettings: () => this.openPreferences(),
    });

    this.reader = new ReaderAdapter({
      pluginID: this.params.id,
      onSelection: (snapshot: SelectionSnapshot) => void this.onSelection(snapshot),
      log: logger.debug,
    });
    this.reader.register();

    this.registerNotifier();
    this.installToolsMenu();

    logger.debug(`plugin started: version=${this.params.version} root=${this.params.rootURI}`);
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    await this.modelSelection?.dispose();
    this.reader?.unregister();
    this.reader = null;

    if (this.notifierID !== null) {
      try {
        Zotero.Notifier.unregisterObserver(this.notifierID);
      }
      catch {
        // ignore
      }
      this.notifierID = null;
    }

    this.removeToolsMenu();
    this.windows?.closeAll();
    this.windows = null;

    this.controller?.dispose();
    this.controller = null;

    if (this.manager) {
      await this.manager.dispose().catch(() => undefined);
      this.manager = null;
    }

    this.taskReader.clear();
    this.assets = null;
    this.assetInstall = null;
    if (this.preferencesWindow && !this.preferencesWindow.closed) {
      try {
        if (this.preferencesWindow.__ztCloseWithoutPrompt) this.preferencesWindow.__ztCloseWithoutPrompt();
        else this.preferencesWindow.close();
      }
      catch {
        // ignore
      }
    }
    this.preferencesWindow = null;
    logger.debug('plugin stopped');
  }

  // --- selection flow -------------------------------------------------------

  private async onSelection(snapshot: SelectionSnapshot): Promise<void> {
    if (this.disposed || !this.controller || !this.windows) return;
    await this.controller.translateSelection(snapshot, {
      onTaskAccepted: (task) => this.presentTask(task),
    });
  }

  private presentTask(task: TranslationTask): void {
    if (this.disposed || !this.windows) return;
    if (!isTerminal(task)) this.taskReader.set(task.requestId, task.readerKey);
    this.windows.openOrFocus(task.readerKey, task);
  }

  private onTaskUpdate(task: TranslationTask): void {
    const readerKey = this.taskReader.get(task.requestId) ?? task.readerKey;
    this.windows?.render(readerKey, task);
    // A terminal task is the last update: keeping requestId→readerKey entries
    // for every selection would grow without bound in a long-lived session.
    if (isTerminal(task)) this.taskReader.delete(task.requestId);
  }

  private async retryTask(task: TranslationTask): Promise<void> {
    if (!this.controller || !this.windows) return;
    await this.controller.translateSelection(
      {
        readerKey: task.readerKey,
        attachmentId: null,
        rawText: task.rawText,
      },
      { onTaskAccepted: (retried) => this.presentTask(retried) },
    );
  }

  private async cancelTask(task: TranslationTask): Promise<void> {
    await this.controller?.cancel(task.requestId);
  }

  private closeReader(readerKey: string): void {
    const active = this.controller?.activeTask;
    if (active && active.readerKey === readerKey) {
      void this.controller?.cancel(active.requestId, 'superseded');
    }
    this.windows?.close(readerKey);
  }

  private registerNotifier(): void {
    if (this.notifierID !== null) return;
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event: string, type: string, ids: Array<string | number>) => {
          if (type !== 'tab' || event !== 'close') return;
          for (const id of ids) {
            this.closeReader(`tab:${String(id)}`);
          }
        },
      },
      ['tab'],
      'local-translation',
    );
  }

  private async loadManifests(): Promise<InstallManifests> {
    try {
      const runtimeResponse = await fetch(this.params.rootURI + 'payload/runtime-manifest.json');
      if (!runtimeResponse.ok) {
        throw new Error('ASSET_INSTALL_FAILED');
      }
      const runtime = JSON.parse(await runtimeResponse.text()) as InstallManifests['runtime'];
      return { pluginVersion: this.params.version, runtime };
    }
    catch {
      logger.warn('native runtime manifest is missing or invalid');
      throw new Error('ASSET_INSTALL_FAILED');
    }
  }

  private async ensureAssets(): Promise<InstallResult> {
    if (this.assets) return this.assets;
    if (this.assetInstall) return this.assetInstall;

    if (!this.installer) {
      throw new Error('ASSET_INSTALL_FAILED');
    }
    this.assetInstall = this.installer
      .ensureInstalled()
      .then((result) => {
        this.assets = result;
        return result;
      })
      .finally(() => {
        this.assetInstall = null;
      });
    return this.assetInstall;
  }

  private hostConfig(profile = this.activeModel): HostConfig {
    const helper = this.assets?.helperPath
      ?? PathUtils.join(Zotero.Profile.dir, 'local-translation', 'runtimes', this.manifests?.runtime.buildId ?? 'unknown', 'translator-host.exe');
    return {
      helperPath: helper,
      modelPath: profile?.path ?? '',
      modelParameters: profile?.parameters,
      allowCpuFallback: false,
      contextTokens: profile?.parameters.contextTokens ?? CONTEXT_TOKENS,
      threads: profile?.device.threads ?? this.settings.threads,
      // The manager's disabled value: 0 while the explicit opt-in switch is off.
      idleReleaseMs: effectiveIdleReleaseMs(this.settings),
      gpuLayers: profile ? (profile.device.useGpu ? profile.device.gpuLayers : 0) : 0,
    };
  }

  private get activeModel(): ModelProfile | null {
    return this.modelStore.activeProfile;
  }

  private engineInUse(): boolean {
    const state = this.manager?.status;
    return this.disposed || Boolean(this.controller?.activeTask)
      || Boolean(state && (state.usageCount > 0 || state.state === 'starting' || state.state === 'stopping'));
  }

  private assertModelChangeAllowed(): void {
    if (!this.modelSelection?.canChange) throw new Error('ENGINE_BUSY');
  }

  private async ensureSelectedModel(): Promise<void> {
    const profile = this.activeModel;
    if (!profile) throw new Error('MODEL_NOT_CONFIGURED');
    if (!(await IOUtils.exists(profile.path))) throw new Error('MODEL_NOT_FOUND');
    const stat = await IOUtils.stat(profile.path);
    if (stat.size !== profile.fileSize || stat.lastModified !== profile.lastModified) throw new Error('MODEL_CHANGED');
  }

  /** Reuse the old extracted file without copying, hashing, or deleting it. */
  private async migrateModel(): Promise<void> {
    if (this.modelStore.profiles.length > 0) return;
    const stored = Zotero.Prefs.get(MODEL_STORE_PREF, true);
    if (typeof stored === 'string' && stored.trim()) return;
    let path: string | null = null;
    try {
      const old = JSON.parse(await IOUtils.readUTF8(PathUtils.join(Zotero.Profile.dir, 'local-translation', 'install-state.json')));
      if (typeof old.modelPath === 'string') path = old.modelPath;
    }
    catch { /* Fresh installation. */ }
    if (!path || !/\.gguf$/i.test(path) || !(await IOUtils.exists(path))) return;
    const stat = await IOUtils.stat(path);
    const profile = createProfile({ path, fileSize: stat.size, lastModified: stat.lastModified, device: this.settings,
      presetId: 'hy-mt-translation', metadata: { name: '', architecture: '', contextLength: 0, chatTemplate: '', splitCount: 1, fileType: 0 } });
    delete profile.metadata;
    profile.revision = 1;
    const store: ModelStore = { version: 2, activeId: profile.id, activeProfile: JSON.parse(JSON.stringify(profile)), profiles: [profile] };
    writeModelStore(store);
    this.modelStore = store;
  }

  private async chooseModel(draft?: ModelProfile): Promise<ModelProfile | null> {
    this.assertModelChangeAllowed();
    const { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
    const picker = new FilePicker();
    picker.init(this.preferencesWindow ?? Zotero.getMainWindow(), '选择单文件 GGUF 模型', picker.modeOpen);
    picker.appendFilter('GGUF 模型', '*.gguf');
    if (await picker.show() !== picker.returnOK) return null;
    // Recheck after the native dialog; another window may have started a task.
    return this.modelSelection!.select(picker.file, draft);
  }

  // --- ui helpers -----------------------------------------------------------

  private copyText(text: string): void {
    try {
      Zotero.Utilities.Internal.copyTextToClipboard(text);
    }
    catch (e) {
      logger.warn(`clipboard failed: ${String(e)}`);
    }
  }

  private installToolsMenu(): void {
    const win = Zotero.getMainWindow();
    if (!win) return;
    try {
      const popup = win.document.getElementById('menu_ToolsPopup');
      if (!popup) return;
      const item = win.document.createXULElement('menuitem');
      item.id = 'local-translation-tools-menuitem';
      item.setAttribute('label', '本地翻译设置…');
      item.addEventListener('command', () => this.openPreferences());
      popup.appendChild(item);
      this.toolsMenuItem = item;
    }
    catch (e) {
      logger.warn(`tools menu not installed: ${String(e)}`);
    }
  }

  private removeToolsMenu(): void {
    try {
      this.toolsMenuItem?.remove();
    }
    catch {
      // ignore
    }
    this.toolsMenuItem = null;
  }

  openPreferences(): void {
    if (this.preferencesWindow && !this.preferencesWindow.closed) {
      this.preferencesWindow.focus();
      return;
    }
    const win = Zotero.getMainWindow();
    if (!win) return;
    const api = {
      getState: async () => this.preferencesState(),
      getModels: () => JSON.parse(JSON.stringify({ profiles: this.modelStore.profiles, activeId: this.modelStore.activeId, activeProfile: this.activeModel, presets })),
      createModel: () => {
        this.assertModelChangeAllowed();
        return createEmptyProfile(this.settings);
      },
      chooseModel: (draft?: ModelProfile) => this.chooseModel(draft),
      saveModel: (profile: ModelProfile) => this.modelSelection!.save(profile),
      deleteModel: (id: string) => this.modelSelection!.remove(id),
      readModel: (id: string) => {
        const profile = this.modelStore.profiles.find((p) => p.id === id);
        if (!profile) throw new Error('MODEL_NOT_FOUND');
        return JSON.parse(JSON.stringify(profile)) as ModelProfile;
      },
      suggestPresets: (profile: ModelProfile) => profile.metadata ? suggestPresets(profile.metadata) : [],
      applyPreset: (profile: ModelProfile, id: string | null) => applyPreset(profile, id),
      testModel: (profile: ModelProfile) => this.modelSelection!.test(profile),
      applyModel: (profile: ModelProfile, useCpu: boolean) => this.modelSelection!.apply(profile, useCpu),
      cancelModelTest: () => this.modelSelection?.cancel(),
      setAutoReleaseModel: async (value: boolean) => {
        this.applyAutoReleaseModel(value);
      },
      setIdleMinutes: async (value: number) => {
        this.applyIdleMinutes(value);
      },
      releaseModel: async (): Promise<ReleaseResult> => {
        if (this.modelSelection?.locked) throw new Error('ENGINE_BUSY');
        if (!this.manager) {
          return {
            status: 'disposed',
            closed: false,
            graceful: null,
            durationMs: 0,
            state: 'stopped',
            usageCount: 0,
            activeRequestId: null,
            detail: 'engine not available',
          };
        }
        // Manual release never calls ensureReady(): the next request loads again.
        return this.manager.releaseModel();
      },
      restartEngine: async (): Promise<RestartResult> => {
        if (this.modelSelection?.locked) return { status: 'busy', detail: '正在检测模型' };
        if (!this.manager) return { status: 'failed', detail: 'engine not available' };
        try {
          await this.ensureSelectedModel();
          await this.ensureAssets();
        }
        catch (e) {
          return { status: 'failed', detail: String(e) };
        }
        return this.manager.restart();
      },
      selfTest: async () => this.selfTest(),
    };
    this.preferencesWindow = win.open(
      'chrome://localtranslation/content/preferences.xhtml',
      'zotero-local-translation-preferences',
      'chrome,centerscreen,resizable,width=760,height=840',
    );
    if (this.preferencesWindow) {
      const target = this.preferencesWindow;
      const init = () => {
        try {
          (target as any).__ztInit?.({ api });
        }
        catch {
          // window closed while loading
        }
      };
      target.addEventListener('load', () => {
        if (target.document?.URL?.includes('preferences.xhtml') && target.__ztInit) init();
      });
      init();
    }
  }

  // --- settings mutations ---------------------------------------------------

  private applyAutoReleaseModel(value: boolean): void {
    this.settings = { ...this.settings, autoReleaseModel: value === true };
    writeAutoReleaseModel(this.settings.autoReleaseModel);
    // Re-evaluates the timer only: no load, no restart.
    this.manager?.refreshPolicy();
  }

  private applyIdleMinutes(value: number): void {
    const ms = idleMsFromMinutes(value);
    this.settings = { ...this.settings, idleReleaseMs: ms };
    writeIdleReleaseMs(ms);
    // An already scheduled timer is replaced from now; no load, no restart.
    this.manager?.refreshPolicy();
  }

  private async preferencesState(): Promise<{
    threads: number;
    idleReleaseMs: number;
    autoReleaseModel: boolean;
    useGpu: boolean;
    gpuLayers: number;
    canChangeModel: boolean;
    selectionPhase: string;
    activeModelPath: string;
    activeModelName: string;
    engineStatusText: string;
    statusText: string;
    modelStatus: { state: ModelStatusKind; text: string; canRelease: boolean };
  }> {
    const info = this.manager?.isReady ? this.manager.info : null;
    const managerStatus = this.manager?.status ?? null;
    // Status only reads cached process state and the already probed device
    // list; it never calls ensureReady() and therefore never loads weights.
    const devices = await this.devices();
    const gpu = devices.filter((d) => d.type !== 'cpu').map((d) => d.name).join(', ') || '无';
    const layers = info?.gpuLayers;
    const backend = layers === undefined
      ? '未启动'
      : info?.gpuOffloaded === true
        ? 'GPU（Vulkan，已确认卸载）'
        : 'CPU';

    let kind: ModelStatusKind = 'not-loaded';
    if (managerStatus) {
      if (managerStatus.releasing) kind = 'releasing';
      else if (managerStatus.state === 'starting') kind = 'loading';
      else if (managerStatus.state === 'ready' && managerStatus.usageCount > 0) kind = 'busy';
      else if (managerStatus.state === 'ready') kind = 'ready';
    }
    const canRelease = kind === 'ready' && managerStatus !== null
      && managerStatus.usageCount === 0 && !managerStatus.pendingConfigChange;

    const statusText = [
      `模型状态：${modelStatusText(kind)}`,
      `当前模型：${this.activeModel?.path ?? '尚未选择，请选择模型并检测'}`,
      `引擎：${info?.engineCommit ? info.engineCommit.slice(0, 10) : (this.manifests?.runtime.buildId ?? '未启动')}${info?.engineVersion ? `（b${info.engineVersion}）` : ''}`,
      `单次翻译容量：${info?.contextTokens ?? this.activeModel?.parameters.contextTokens ?? CONTEXT_TOKENS} tokens，线程：${info?.threads ?? this.activeModel?.device.threads ?? this.settings.threads}`,
      `GPU 设备：${gpu}`,
      `执行后端：${backend}`,
    ].join('\n');
    const engineStatusText = this.modelSelection?.locked
      ? (this.modelSelection.phase || '正在处理配置…')
      : info
        ? `${kind === 'busy' ? '推理中' : '就绪'} · ${backend} · ${info.threads} 线程 · ${info.contextTokens} tokens`
        : managerStatus?.state === 'starting' ? '正在启动…'
          : managerStatus?.state === 'stopping' ? '正在停止…'
            : this.activeModel ? '已停止；下次翻译时加载当前配置' : '未启动；请保存并启用一个配置';
    return {

      threads: this.activeModel?.device.threads ?? this.settings.threads,
      idleReleaseMs: this.settings.idleReleaseMs,
      autoReleaseModel: this.settings.autoReleaseModel,
      useGpu: this.activeModel?.device.useGpu ?? this.settings.useGpu,
      gpuLayers: this.activeModel?.device.gpuLayers ?? this.settings.gpuLayers,
      canChangeModel: this.modelSelection?.canChange ?? false,
      selectionPhase: this.modelSelection?.phase ?? '',
      activeModelPath: this.activeModel?.path ?? '',
      activeModelName: this.activeModel?.name ?? '',
      engineStatusText,
      statusText,
      modelStatus: {
        state: kind,
        text: modelStatusText(kind),
        canRelease,
      },
    };
  }

  private async devices(): Promise<Array<{ name: string; description: string; type: string }>> {
    if (this.cachedDevices.length > 0) return this.cachedDevices;
    // Status polling must not spawn a helper every couple of seconds when the
    // weight-free probe fails; retry at most every 30 s.
    if (Date.now() - this.devicesProbeAt < 30_000) return this.cachedDevices;
    this.devicesProbeAt = Date.now();
    try {
      await this.ensureAssets();
      this.cachedDevices = await this.manager!.probeDevices();
    }
    catch {
      this.cachedDevices = [];
    }
    return this.cachedDevices;
  }

  private async selfTest(): Promise<string> {
    if (!this.controller) throw new Error('ENGINE_START_FAILED');
    const started = Date.now();
    const submitted = await this.controller.translateSelection(
      {
        readerKey: 'selftest',
        attachmentId: null,
        rawText: SELF_TEST_TEXT,
      },
    );
    const task = isTerminal(submitted) ? submitted : await waitTask(this.controller, submitted.requestId, 125_000);
    const elapsed = Date.now() - started;
    if (!task || task.state !== 'succeeded') {
      throw new Error(task?.errorCode ?? 'ENGINE_TIMEOUT');
    }
    return `自检通过（${elapsed} ms）：${task.resultText}`;
  }
}

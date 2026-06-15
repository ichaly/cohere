import { App, Notice, Platform, Plugin, PluginSettingTab, requestUrl, type TAbstractFile, TFile } from "obsidian";
import { createApp, reactive, type App as VueApp } from "vue";
import { createRandomId, createVaultId, normalizeKey } from "./core/ids";
import SettingsApp from "./settings/SettingsApp.vue";
import "./styles.scss";
import { releaseDeletedContent, syncOnce, type LocalSyncState } from "./sync/engine";
import { S3ObjectStore, type S3AddressingStyle } from "./store/s3";
import { ObsidianVaultIO } from "./vault-io";

interface ObsyncSettings {
  endpoint: string;
  bucket: string;
  addressingStyle: S3AddressingStyle;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  rootPrefix: string;
  accountKey: string;
  vaultKey: string;
  vaultId: string;
  deviceId: string;
  deviceName: string;
  syncIntervalMinutes: number;
  autoSync: boolean;
  syncEmptyDirectories: boolean;
  syncState: LocalSyncState;
}

interface ConnectionConfig {
  schemaVersion: 1;
  endpoint: string;
  bucket: string;
  addressingStyle?: S3AddressingStyle;
  region: string;
  rootPrefix: string;
  accountKey: string;
  vaultKey: string;
  vaultId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

const DEFAULT_SETTINGS: ObsyncSettings = {
  endpoint: "",
  bucket: "",
  addressingStyle: "auto",
  region: "",
  accessKeyId: "",
  secretAccessKey: "",
  rootPrefix: "obsync/v2",
  accountKey: "default",
  vaultKey: "",
  vaultId: "",
  deviceId: "",
  deviceName: "",
  syncIntervalMinutes: 5,
  autoSync: true,
  syncEmptyDirectories: false,
  syncState: {
    files: {},
  },
};

const AUTO_SYNC_DEBOUNCE_MS = 2_000;
const FILE_EVENT_SUPPRESSION_MS = 1_000;

type SyncTrigger = "manual" | "auto";

export default class ObsyncPlugin extends Plugin {
  settings: ObsyncSettings = DEFAULT_SETTINGS;
  private autoSyncTimer: number | null = null;
  private autoSyncRunning = false;
  private autoSyncQueued = false;
  private syncRunning = false;
  private suppressFileSyncEvents = false;
  private suppressFileSyncTimer: number | null = null;
  private activeNotice: Notice | null = null;
  private statusBarItem: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.classList.add("obsync-status-bar-item");
    this.clearOperationStatus();

    this.addCommand({
      id: "manual-sync",
      name: "立即同步",
      callback: async () => {
        await this.syncNow("manual");
      },
    });

    const syncRibbonIcon = this.addRibbonIcon("refresh-cw", "Obsync 立即同步", async () => {
      await this.syncNow("manual");
    });
    syncRibbonIcon.classList.add("obsync-ribbon-sync");
    this.app.workspace.onLayoutReady(() => {
      this.moveRibbonIconToBottom(syncRibbonIcon);
    });

    this.addCommand({
      id: "copy-connection-config",
      name: "复制连接配置",
      callback: async () => {
        await navigator.clipboard.writeText(JSON.stringify(this.getConnectionConfig(), null, 2));
        new Notice("Obsync 连接配置已复制。");
      },
    });

    this.addCommand({
      id: "release-deleted-content",
      name: "释放已删除内容",
      callback: async () => {
        await this.releaseDeletedContentNow();
      },
    });

    this.addSettingTab(new ObsyncSettingTab(this.app, this));
    this.registerAutoSyncTriggers();
  }

  async syncNow(trigger: SyncTrigger = "manual"): Promise<void> {
    if (this.syncRunning) {
      this.autoSyncQueued = true;

      if (trigger === "manual") {
        this.showNotice("Obsync 正在同步，稍后会再同步一次。");
      }

      return;
    }

    this.syncRunning = true;
    this.startFileEventSuppression();

    try {
      await this.runConfiguredOperation("同步中...", "Obsync 同步失败", async () => {
        const store = this.createObjectStore();
        const result = await syncOnce({
          vault: new ObsidianVaultIO(this.app),
          store,
          state: this.settings.syncState,
          deviceName: this.settings.deviceName || this.settings.deviceId,
          deviceId: this.settings.deviceId,
          syncEmptyDirectories: this.settings.syncEmptyDirectories,
          now: () => Date.now(),
        });

        await this.saveSettings();

        if (result.locked) {
          if (trigger === "manual") {
            this.showNotice("另一台设备正在同步，本次已跳过。");
          }
          return;
        }

        if (trigger === "manual") {
          this.showNotice("Obsync 同步完成。");
        }
      }, {
        notifyMissingConfig: trigger === "manual",
      });
    } finally {
      this.syncRunning = false;
      this.finishFileEventSuppression();
    }
  }

  private moveRibbonIconToBottom(iconEl: HTMLElement): void {
    const leftRibbonActions = activeDocument.querySelector(".workspace-ribbon.mod-left .side-dock-actions");
    (leftRibbonActions ?? iconEl.parentElement)?.append(iconEl);
  }

  private registerAutoSyncTriggers(): void {
    this.app.workspace.onLayoutReady(() => {
      this.queueAutoSync(0);
    });

    this.registerDomEvent(window, "focus", () => {
      this.queueAutoSync();
    });

    this.registerDomEvent(activeDocument, "visibilitychange", () => {
      if (!activeDocument.hidden) {
        this.queueAutoSync();
      }
    });

    const queueFileSync = (file: TAbstractFile) => {
      if (file instanceof TFile) {
        if (this.suppressFileSyncEvents) {
          return;
        }

        this.queueAutoSync();
      }
    };

    this.registerEvent(this.app.vault.on("create", queueFileSync));
    this.registerEvent(this.app.vault.on("modify", queueFileSync));
    this.registerEvent(this.app.vault.on("delete", queueFileSync));
    this.registerEvent(this.app.vault.on("rename", queueFileSync));
  }

  private queueAutoSync(delayMs = AUTO_SYNC_DEBOUNCE_MS): void {
    if (!this.settings.autoSync) {
      return;
    }

    if (this.autoSyncTimer !== null) {
      window.clearTimeout(this.autoSyncTimer);
    }

    this.autoSyncTimer = window.setTimeout(() => {
      this.autoSyncTimer = null;
      void this.runAutoSync();
    }, delayMs);
  }

  private async runAutoSync(): Promise<void> {
    if (!this.settings.autoSync || !this.hasConnectionSettings()) {
      return;
    }

    if (this.autoSyncRunning) {
      this.autoSyncQueued = true;
      return;
    }

    this.autoSyncRunning = true;

    try {
      await this.syncNow("auto");
    } finally {
      this.autoSyncRunning = false;

      if (this.autoSyncQueued) {
        this.autoSyncQueued = false;
        this.queueAutoSync();
      }
    }
  }

  private hasConnectionSettings(): boolean {
    return Boolean(this.settings.endpoint && this.settings.bucket && this.settings.accessKeyId && this.settings.secretAccessKey);
  }

  async releaseDeletedContentNow(): Promise<void> {
    await this.runConfiguredOperation("清理中...", "释放已删除内容失败", async () => {
      const result = await releaseDeletedContent({ store: this.createObjectStore(), now: () => Date.now() });

      if (result.locked) {
        this.showNotice("另一台设备正在同步，本次释放空间已跳过。");
        return;
      }

      this.pruneLocalDeletedState();
      await this.saveSettings();
      this.showNotice(`Obsync 已释放：清理文件删除记录 ${result.deletedTombstones}，目录删除记录 ${result.deletedDirectoryTombstones}，删除 Blob ${result.deletedBlobs}。`);
    });
  }

  private async runConfiguredOperation(
    progressText: string,
    failurePrefix: string,
    operation: () => Promise<void>,
    options: { notifyMissingConfig?: boolean } = {},
  ): Promise<void> {
    if (!this.hasConnectionSettings()) {
      if (options.notifyMissingConfig ?? true) {
        this.showNotice("请先填写端点、Bucket、Access Key ID 和 Secret Access Key。");
      }
      return;
    }

    this.setOperationStatus(progressText);

    try {
      await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.showNotice(`${failurePrefix}：${message}`);
    } finally {
      this.clearOperationStatus();
    }
  }

  private startFileEventSuppression(): void {
    if (this.suppressFileSyncTimer !== null) {
      window.clearTimeout(this.suppressFileSyncTimer);
      this.suppressFileSyncTimer = null;
    }

    this.suppressFileSyncEvents = true;
  }

  private finishFileEventSuppression(): void {
    if (this.suppressFileSyncTimer !== null) {
      window.clearTimeout(this.suppressFileSyncTimer);
    }

    this.suppressFileSyncTimer = window.setTimeout(() => {
      this.suppressFileSyncTimer = null;
      this.suppressFileSyncEvents = false;
    }, FILE_EVENT_SUPPRESSION_MS);
  }

  private showNotice(message: string): void {
    this.activeNotice?.hide();
    this.activeNotice = new Notice(message);
  }

  private setOperationStatus(text: string): void {
    this.statusBarItem?.classList.remove("is-hidden");
    this.statusBarItem?.setText(text);
    this.statusBarItem?.setAttribute("title", text);
  }

  private clearOperationStatus(): void {
    this.statusBarItem?.classList.add("is-hidden");
    this.statusBarItem?.setText("");
    this.statusBarItem?.removeAttribute("title");
  }

  private createObjectStore(): S3ObjectStore {
    return new S3ObjectStore({
      endpoint: this.settings.endpoint,
      bucket: this.settings.bucket,
      addressingStyle: this.settings.addressingStyle,
      region: this.settings.region || "auto",
      accessKeyId: this.settings.accessKeyId,
      secretAccessKey: this.settings.secretAccessKey,
      rootPrefix: this.settings.rootPrefix,
      vaultId: this.settings.vaultId,
      deviceId: this.settings.deviceId,
      now: () => Date.now(),
      request: async (request) => {
        const headers = { ...request.headers };
        delete headers.host;
        const response = await requestUrl({
          url: request.url,
          method: request.method,
          headers,
          body: request.body,
          throw: false,
        });

        return {
          status: response.status,
          text: response.text,
          arrayBuffer: response.arrayBuffer,
        };
      },
    });
  }

  private pruneLocalDeletedState(): void {
    for (const [path, fileState] of Object.entries(this.settings.syncState.files)) {
      if (fileState.deleted) {
        delete this.settings.syncState.files[path];
      }
    }

    for (const [path, directoryState] of Object.entries(this.settings.syncState.directories ?? {})) {
      if (directoryState.deleted) {
        delete this.settings.syncState.directories?.[path];
      }
    }
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData() as Partial<ObsyncSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

    if (!this.settings.vaultKey) {
      this.settings.vaultKey = normalizeKey(this.app.vault.getName());
    }

    if (!loaded?.rootPrefix || loaded.rootPrefix === "obsync/v1") {
      this.settings.rootPrefix = "obsync/v2";
    }

    if (!this.settings.deviceId) {
      this.settings.deviceId = createRandomId("dev");
    }

    if (!this.settings.deviceName || this.settings.deviceName === "This device") {
      this.settings.deviceName = getCurrentDeviceName(this.settings.deviceId);
    }

    if (!this.settings.syncState) {
      this.settings.syncState = { files: {} };
    }

    this.settings.vaultId = await createVaultId(this.settings.accountKey, this.settings.vaultKey);
    await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async updateSettings(update: Partial<ObsyncSettings>): Promise<void> {
    Object.assign(this.settings, update);
    this.settings.accountKey = normalizeKey(this.settings.accountKey || "default");
    this.settings.vaultKey = normalizeKey(this.settings.vaultKey || this.app.vault.getName());
    if (!this.settings.deviceName || this.settings.deviceName === "This device") {
      this.settings.deviceName = getCurrentDeviceName(this.settings.deviceId);
    }
    this.settings.vaultId = await createVaultId(this.settings.accountKey, this.settings.vaultKey);
    await this.saveSettings();
  }

  getConnectionConfig(includeSecrets = false): Record<string, string | number> {
    const config: Record<string, string | number> = {
      schemaVersion: 1,
      endpoint: this.settings.endpoint,
      bucket: this.settings.bucket,
      addressingStyle: this.settings.addressingStyle,
      region: this.settings.region,
      rootPrefix: this.settings.rootPrefix,
      accountKey: this.settings.accountKey,
      vaultKey: this.settings.vaultKey,
      vaultId: this.settings.vaultId,
    };

    if (includeSecrets) {
      config.accessKeyId = this.settings.accessKeyId;
      config.secretAccessKey = this.settings.secretAccessKey;
    }

    return config;
  }

  async importConnectionConfig(configText: string): Promise<void> {
    const config = parseConnectionConfig(configText);

    await this.updateSettings({
      endpoint: config.endpoint,
      bucket: config.bucket,
      addressingStyle: config.addressingStyle || "auto",
      region: config.region,
      rootPrefix: config.rootPrefix,
      accountKey: config.accountKey,
      vaultKey: config.vaultKey,
      accessKeyId: config.accessKeyId || this.settings.accessKeyId,
      secretAccessKey: config.secretAccessKey || this.settings.secretAccessKey,
    });
  }
}

function getCurrentDeviceName(deviceId: string): string {
  const suffix = getDeviceNameSuffix(deviceId);

  if (Platform.isIosApp) {
    return `${Platform.isTablet ? "iPad" : "iPhone"} ${suffix}`;
  }

  if (Platform.isAndroidApp) {
    return `${Platform.isTablet ? "Android Tablet" : "Android Phone"} ${suffix}`;
  }

  if (Platform.isMacOS) {
    return `Mac Desktop ${suffix}`;
  }

  if (Platform.isWin) {
    return `Windows Desktop ${suffix}`;
  }

  if (Platform.isLinux) {
    return `Linux Desktop ${suffix}`;
  }

  return `Desktop ${suffix}`;
}

function getDeviceNameSuffix(deviceId: string): string {
  const compactId = deviceId.replace(/^dev_/, "");
  return compactId.slice(-4) || "0000";
}

function parseConnectionConfig(configText: string): ConnectionConfig {
  let parsed: unknown;

  try {
    parsed = JSON.parse(configText);
  } catch {
    throw new Error("连接配置不是有效 JSON。");
  }

  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error("连接配置版本不支持。");
  }

  const config = {
    schemaVersion: 1 as const,
    endpoint: readRequiredString(parsed, "endpoint"),
    bucket: readRequiredString(parsed, "bucket"),
    addressingStyle: readAddressingStyle(parsed, "addressingStyle", "auto"),
    region: readOptionalString(parsed, "region", "auto"),
    rootPrefix: readOptionalString(parsed, "rootPrefix", "obsync/v1"),
    accountKey: readOptionalString(parsed, "accountKey", "default"),
    vaultKey: readRequiredString(parsed, "vaultKey"),
    vaultId: readOptionalString(parsed, "vaultId", ""),
    accessKeyId: readOptionalString(parsed, "accessKeyId", ""),
    secretAccessKey: readOptionalString(parsed, "secretAccessKey", ""),
  };

  if (config.vaultId) {
    void config.vaultId;
  }

  return config;
}

function readAddressingStyle(record: Record<string, unknown>, key: string, fallback: S3AddressingStyle): S3AddressingStyle {
  const value = record[key];

  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (value === "auto" || value === "path" || value === "virtual-hosted") {
    return value;
  }

  throw new Error(`连接配置字段 ${key} 格式不正确。`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`连接配置缺少 ${key}。`);
  }

  return value.trim();
}

function readOptionalString(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];

  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value !== "string") {
    throw new Error(`连接配置字段 ${key} 格式不正确。`);
  }

  return value.trim() || fallback;
}

class ObsyncSettingTab extends PluginSettingTab {
  plugin: ObsyncPlugin;
  vueApp: VueApp<Element> | null = null;

  constructor(app: App, plugin: ObsyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    this.vueApp?.unmount();
    containerEl.empty();

    const mountEl = containerEl.createDiv({ cls: "obsync-settings-root" });
    const settings = reactive(this.plugin.settings) as ObsyncSettings;
    const connectionConfig = reactive(this.plugin.getConnectionConfig());
    this.plugin.settings = settings;

    this.vueApp = createApp(SettingsApp, {
      settings,
      connectionConfig,
      onUpdate: async (update: Partial<ObsyncSettings>) => {
        await this.plugin.updateSettings(update);
        Object.assign(connectionConfig, this.plugin.getConnectionConfig());
      },
      onCopyDeviceId: async () => {
        await navigator.clipboard.writeText(this.plugin.settings.deviceId);
        new Notice("设备 ID 已复制。");
      },
      onCopyConnectionConfig: async (includeSecrets: boolean) => {
        await navigator.clipboard.writeText(JSON.stringify(this.plugin.getConnectionConfig(includeSecrets), null, 2));
        new Notice(includeSecrets ? "完整连接配置已复制。" : "连接配置已复制。");
      },
      onPasteConnectionConfig: async () => {
        try {
          const configText = await navigator.clipboard.readText();
          await this.plugin.importConnectionConfig(configText);
          Object.assign(settings, this.plugin.settings);
          Object.assign(connectionConfig, this.plugin.getConnectionConfig());
          const hasSecrets = Boolean(this.plugin.settings.accessKeyId && this.plugin.settings.secretAccessKey);
          new Notice(hasSecrets ? "连接配置已导入。" : "连接配置已导入。请继续填写 Access Key ID 和 Secret Access Key。");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          new Notice(`导入连接配置失败：${message}`);
        }
      },
      onReleaseDeletedContent: async () => {
        await this.plugin.releaseDeletedContentNow();
      },
    });
    this.vueApp.mount(mountEl);
  }

  hide(): void {
    this.vueApp?.unmount();
    this.vueApp = null;
    super.hide();
  }
}

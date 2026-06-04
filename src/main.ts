import { App, Notice, Platform, Plugin, PluginSettingTab, requestUrl, type TAbstractFile, TFile, TFolder } from "obsidian";
import { createApp, reactive, type App as VueApp } from "vue";
import { createRandomId, createVaultId, normalizeKey } from "./core/ids";
import SettingsApp from "./settings/SettingsApp.vue";
import "./styles.scss";
import { releaseDeletedContent, syncOnce, type LocalSyncState, type VaultIO } from "./sync/engine";
import { S3ObjectStore } from "./store/s3";

declare const require: ((id: string) => unknown) | undefined;

interface ObsyncSettings {
  endpoint: string;
  bucket: string;
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
  syncState: LocalSyncState;
}

interface ConnectionConfig {
  schemaVersion: 1;
  endpoint: string;
  bucket: string;
  region: string;
  rootPrefix: string;
  accountKey: string;
  vaultKey: string;
  vaultId?: string;
}

const DEFAULT_SETTINGS: ObsyncSettings = {
  endpoint: "",
  bucket: "",
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
  syncState: {
    files: {},
  },
};

const AUTO_SYNC_DEBOUNCE_MS = 2_000;

export default class ObsyncPlugin extends Plugin {
  settings: ObsyncSettings = DEFAULT_SETTINGS;
  private autoSyncTimer: number | null = null;
  private autoSyncRunning = false;
  private autoSyncQueued = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addCommand({
      id: "manual-sync",
      name: "立即同步",
      callback: async () => {
        await this.syncNow();
      },
    });

    const syncRibbonIcon = this.addRibbonIcon("refresh-cw", "Obsync 立即同步", async () => {
      await this.syncNow();
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

  async syncNow(): Promise<void> {
    if (!this.settings.endpoint || !this.settings.bucket || !this.settings.accessKeyId || !this.settings.secretAccessKey) {
      new Notice("请先填写端点、Bucket、Access Key ID 和 Secret Access Key。");
      return;
    }

    const syncingNotice = new Notice("Obsync 正在同步...", 0);

    try {
      const store = this.createObjectStore();
      const result = await syncOnce({
        vault: new ObsidianVaultIO(this.app),
        store,
        state: this.settings.syncState,
        deviceName: this.settings.deviceName || this.settings.deviceId,
        deviceId: this.settings.deviceId,
        now: () => Date.now(),
      });

      await this.saveSettings();
      syncingNotice.hide();

      if (result.locked) {
        new Notice("另一台设备正在同步，本次已跳过。");
        return;
      }

      new Notice(`Obsync 同步完成：上传 ${result.uploaded}，下载 ${result.downloaded}，冲突 ${result.conflicts}。`);
    } catch (error) {
      syncingNotice.hide();
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Obsync 同步失败：${message}`);
    }
  }

  private moveRibbonIconToBottom(iconEl: HTMLElement): void {
    const leftRibbonActions = document.querySelector(".workspace-ribbon.mod-left .side-dock-actions");
    (leftRibbonActions ?? iconEl.parentElement)?.append(iconEl);
  }

  private registerAutoSyncTriggers(): void {
    this.app.workspace.onLayoutReady(() => {
      this.queueAutoSync(0);
    });

    this.registerDomEvent(window, "focus", () => {
      this.queueAutoSync();
    });

    this.registerDomEvent(document, "visibilitychange", () => {
      if (!document.hidden) {
        this.queueAutoSync();
      }
    });

    const queueFileSync = (file: TAbstractFile) => {
      if (file instanceof TFile) {
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
      await this.syncNow();
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
    if (!this.hasConnectionSettings()) {
      new Notice("请先填写端点、Bucket、Access Key ID 和 Secret Access Key。");
      return;
    }

    const notice = new Notice("Obsync 正在释放已删除内容...", 0);

    try {
      const store = this.createObjectStore();
      const result = await releaseDeletedContent({ store, now: () => Date.now() });
      notice.hide();

      if (result.locked) {
        new Notice("另一台设备正在同步，本次释放空间已跳过。");
        return;
      }

      this.pruneLocalDeletedState();
      await this.saveSettings();
      new Notice(`Obsync 已释放：清理删除记录 ${result.deletedTombstones}，删除 Blob ${result.deletedBlobs}。`);
    } catch (error) {
      notice.hide();
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`释放已删除内容失败：${message}`);
    }
  }

  private createObjectStore(): S3ObjectStore {
    return new S3ObjectStore({
      endpoint: this.settings.endpoint,
      bucket: this.settings.bucket,
      region: this.settings.region || "auto",
      accessKeyId: this.settings.accessKeyId,
      secretAccessKey: this.settings.secretAccessKey,
      rootPrefix: this.settings.rootPrefix,
      vaultId: this.settings.vaultId,
      deviceId: this.settings.deviceId,
      now: () => Date.now(),
      request: async (request) => {
        const { host: _host, ...headers } = request.headers;
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
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData();
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
    this.settings.vaultId = await createVaultId(this.settings.accountKey, this.settings.vaultKey);
    await this.saveSettings();
  }

  getConnectionConfig(): Record<string, string | number> {
    return {
      schemaVersion: 1,
      endpoint: this.settings.endpoint,
      bucket: this.settings.bucket,
      region: this.settings.region,
      rootPrefix: this.settings.rootPrefix,
      accountKey: this.settings.accountKey,
      vaultKey: this.settings.vaultKey,
      vaultId: this.settings.vaultId,
    };
  }

  async importConnectionConfig(configText: string): Promise<void> {
    const config = parseConnectionConfig(configText);

    await this.updateSettings({
      endpoint: config.endpoint,
      bucket: config.bucket,
      region: config.region,
      rootPrefix: config.rootPrefix,
      accountKey: config.accountKey,
      vaultKey: config.vaultKey,
    });
  }
}

function getCurrentDeviceName(deviceId: string): string {
  try {
    if (typeof require !== "function") {
      return getPlatformDeviceName(deviceId);
    }

    const os = require("node:os") as { hostname?: () => string };
    return os.hostname?.().trim() || getPlatformDeviceName(deviceId);
  } catch {
    return getPlatformDeviceName(deviceId);
  }
}

function getPlatformDeviceName(deviceId: string): string {
  const suffix = getDeviceNameSuffix(deviceId);

  if (Platform.isIosApp) {
    return `${Platform.isTablet ? "iPad" : "iPhone"} ${suffix}`;
  }

  if (Platform.isAndroidApp) {
    return `${Platform.isTablet ? "Android Tablet" : "Android Phone"} ${suffix}`;
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
    region: readOptionalString(parsed, "region", "auto"),
    rootPrefix: readOptionalString(parsed, "rootPrefix", "obsync/v1"),
    accountKey: readOptionalString(parsed, "accountKey", "default"),
    vaultKey: readRequiredString(parsed, "vaultKey"),
    vaultId: readOptionalString(parsed, "vaultId", ""),
  };

  if (config.vaultId) {
    void config.vaultId;
  }

  return config;
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

class ObsidianVaultIO implements VaultIO {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  async scan(): Promise<Array<{ path: string; mtime: number; size: number }>> {
    const files = this.app.vault.getFiles();
    const result: Array<{ path: string; mtime: number; size: number }> = [];

    for (const file of files) {
      result.push({
        path: file.path,
        mtime: file.stat.mtime,
        size: file.stat.size,
      });
    }

    return result;
  }

  async read(path: string): Promise<Uint8Array> {
    const file = this.app.vault.getFileByPath(path);

    if (!file) {
      return new Uint8Array();
    }

    return new Uint8Array(await this.app.vault.readBinary(file));
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    await this.ensureParentFolder(path);
    const file = this.app.vault.getFileByPath(path);
    const data = toArrayBuffer(bytes);

    if (file instanceof TFile) {
      await this.app.vault.modifyBinary(file, data);
      return;
    }

    await this.app.vault.createBinary(path, data);
  }

  async delete(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);

    if (file) {
      await this.app.vault.trash(file, false);
    }
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const folder = this.app.vault.getFolderByPath(current);

      if (!(folder instanceof TFolder)) {
        await this.app.vault.createFolder(current);
      }
    }
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
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
      onCopyConnectionConfig: async () => {
        await navigator.clipboard.writeText(JSON.stringify(this.plugin.getConnectionConfig(), null, 2));
        new Notice("连接配置已复制。");
      },
      onPasteConnectionConfig: async () => {
        try {
          const configText = await navigator.clipboard.readText();
          await this.plugin.importConnectionConfig(configText);
          Object.assign(settings, this.plugin.settings);
          Object.assign(connectionConfig, this.plugin.getConnectionConfig());
          new Notice("连接配置已导入。请继续填写 Access Key ID 和 Secret Access Key。");
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

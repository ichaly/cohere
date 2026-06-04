import { App, Notice, Plugin, PluginSettingTab, requestUrl, TFile, TFolder } from "obsidian";
import { createApp, reactive, type App as VueApp } from "vue";
import { createRandomId, createVaultId, normalizeKey } from "./core/ids";
import SettingsApp from "./settings/SettingsApp.vue";
import "./styles.scss";
import { syncOnce, type LocalSyncState, type VaultIO } from "./sync/engine";
import { S3ObjectStore } from "./store/s3";

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
  rootPrefix: "obsync/v1",
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

export default class ObsyncPlugin extends Plugin {
  settings: ObsyncSettings = DEFAULT_SETTINGS;

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

    this.addSettingTab(new ObsyncSettingTab(this.app, this));
  }

  async syncNow(): Promise<void> {
    if (!this.settings.endpoint || !this.settings.bucket || !this.settings.accessKeyId || !this.settings.secretAccessKey) {
      new Notice("请先填写端点、Bucket、Access Key ID 和 Secret Access Key。");
      return;
    }

    const syncingNotice = new Notice("Obsync 正在同步...", 0);

    try {
      const store = new S3ObjectStore({
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
      const result = await syncOnce({
        vault: new ObsidianVaultIO(this.app),
        store,
        state: this.settings.syncState,
        deviceName: this.settings.deviceName || this.settings.deviceId,
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

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

    if (!this.settings.vaultKey) {
      this.settings.vaultKey = normalizeKey(this.app.vault.getName());
    }

    if (!this.settings.deviceName) {
      this.settings.deviceName = "This device";
    }

    if (!this.settings.deviceId) {
      this.settings.deviceId = createRandomId("dev");
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
      onCopyVaultId: async () => {
        await navigator.clipboard.writeText(this.plugin.settings.vaultId);
        new Notice("Vault ID 已复制。");
      },
      onCopyConnectionConfig: async () => {
        await navigator.clipboard.writeText(JSON.stringify(this.plugin.getConnectionConfig(), null, 2));
        new Notice("连接配置已复制。");
      },
      onImportConnectionConfig: async (configText: string) => {
        try {
          await this.plugin.importConnectionConfig(configText);
          Object.assign(settings, this.plugin.settings);
          Object.assign(connectionConfig, this.plugin.getConnectionConfig());
          new Notice("连接配置已导入。请继续填写 Access Key ID 和 Secret Access Key。");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          new Notice(`导入连接配置失败：${message}`);
        }
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

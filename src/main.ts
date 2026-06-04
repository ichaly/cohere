import { App, Notice, Plugin, PluginSettingTab, requestUrl, TFile, TFolder } from "obsidian";
import { createApp, type App as VueApp } from "vue";
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
      name: "Sync now",
      callback: async () => {
        await this.syncNow();
      },
    });

    this.addCommand({
      id: "copy-connection-config",
      name: "Copy connection config",
      callback: async () => {
        await navigator.clipboard.writeText(JSON.stringify(this.getConnectionConfig(), null, 2));
        new Notice("Obsync connection config copied.");
      },
    });

    this.addSettingTab(new ObsyncSettingTab(this.app, this));
  }

  async syncNow(): Promise<void> {
    if (!this.settings.endpoint || !this.settings.bucket || !this.settings.accessKeyId || !this.settings.secretAccessKey) {
      new Notice("Obsync needs endpoint, bucket, access key, and secret key before syncing.");
      return;
    }

    new Notice("Obsync syncing...");

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
          const response = await requestUrl({
            url: request.url,
            method: request.method,
            headers: request.headers,
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

      if (result.locked) {
        new Notice("Obsync skipped because another device is syncing.");
        return;
      }

      new Notice(`Obsync done: ${result.uploaded} uploaded, ${result.downloaded} downloaded, ${result.conflicts} conflicts.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Obsync failed: ${message}`);
    }
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
    this.settings = Object.assign({}, this.settings, update);
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
}

class ObsidianVaultIO implements VaultIO {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  async scan(): Promise<Array<{ path: string; bytes: Uint8Array }>> {
    const files = this.app.vault.getFiles();
    const result: Array<{ path: string; bytes: Uint8Array }> = [];

    for (const file of files) {
      result.push({
        path: file.path,
        bytes: new Uint8Array(await this.app.vault.readBinary(file)),
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
    this.vueApp = createApp(SettingsApp, {
      settings: this.plugin.settings,
      connectionConfig: this.plugin.getConnectionConfig(),
      onUpdate: async (update: Partial<ObsyncSettings>) => {
        await this.plugin.updateSettings(update);
        this.display();
      },
      onCopyVaultId: async () => {
        await navigator.clipboard.writeText(this.plugin.settings.vaultId);
        new Notice("Vault ID copied.");
      },
      onCopyConnectionConfig: async () => {
        await navigator.clipboard.writeText(JSON.stringify(this.plugin.getConnectionConfig(), null, 2));
        new Notice("Connection config copied.");
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

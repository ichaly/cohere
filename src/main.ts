import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";

interface ObsyncSettings {
  endpoint: string;
  bucket: string;
  region: string;
  rootPrefix: string;
  accountKey: string;
  vaultKey: string;
  vaultId: string;
  deviceId: string;
  deviceName: string;
  syncIntervalMinutes: number;
  autoSync: boolean;
}

const DEFAULT_SETTINGS: ObsyncSettings = {
  endpoint: "",
  bucket: "",
  region: "",
  rootPrefix: "obsync/v1",
  accountKey: "default",
  vaultKey: "",
  vaultId: "",
  deviceId: "",
  deviceName: "",
  syncIntervalMinutes: 5,
  autoSync: true,
};

export default class ObsyncPlugin extends Plugin {
  settings: ObsyncSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addCommand({
      id: "manual-sync",
      name: "Sync now",
      callback: () => {
        new Notice("Obsync sync is not implemented yet.");
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
      rootPrefix: this.settings.rootPrefix,
      accountKey: this.settings.accountKey,
      vaultKey: this.settings.vaultKey,
      vaultId: this.settings.vaultId,
    };
  }
}

class ObsyncSettingTab extends PluginSettingTab {
  plugin: ObsyncPlugin;

  constructor(app: App, plugin: ObsyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsync" });

    new Setting(containerEl)
      .setName("Endpoint")
      .setDesc("OSS / S3-compatible endpoint.")
      .addText((text) =>
        text
          .setPlaceholder("https://oss-cn-example.aliyuncs.com")
          .setValue(this.plugin.settings.endpoint)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ endpoint: value.trim() });
          }),
      );

    new Setting(containerEl)
      .setName("Bucket")
      .setDesc("Bucket used to store synced vault data.")
      .addText((text) =>
        text.setValue(this.plugin.settings.bucket).onChange(async (value) => {
          await this.plugin.updateSettings({ bucket: value.trim() });
        }),
      );

    new Setting(containerEl)
      .setName("Root prefix")
      .setDesc("Prefix inside the bucket.")
      .addText((text) =>
        text.setValue(this.plugin.settings.rootPrefix).onChange(async (value) => {
          await this.plugin.updateSettings({ rootPrefix: value.trim() || "obsync/v1" });
        }),
      );

    new Setting(containerEl)
      .setName("Account key")
      .setDesc("Shared across devices for the same user or team.")
      .addText((text) =>
        text.setValue(this.plugin.settings.accountKey).onChange(async (value) => {
          await this.plugin.updateSettings({ accountKey: value });
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Vault key")
      .setDesc("Shared across devices for the same Obsidian vault.")
      .addText((text) =>
        text.setValue(this.plugin.settings.vaultKey).onChange(async (value) => {
          await this.plugin.updateSettings({ vaultKey: value });
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Vault ID")
      .setDesc(this.plugin.settings.vaultId)
      .addButton((button) =>
        button.setButtonText("Copy").onClick(async () => {
          await navigator.clipboard.writeText(this.plugin.settings.vaultId);
          new Notice("Vault ID copied.");
        }),
      );

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Used only for UI and conflict file names.")
      .addText((text) =>
        text.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
          await this.plugin.updateSettings({ deviceName: value.trim() || "This device" });
        }),
      );

    new Setting(containerEl)
      .setName("Device ID")
      .setDesc(this.plugin.settings.deviceId);

    new Setting(containerEl)
      .setName("Auto sync")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          await this.plugin.updateSettings({ autoSync: value });
        }),
      );

    new Setting(containerEl)
      .setName("Copy connection config")
      .setDesc("Copies connection settings without OSS credentials.")
      .addButton((button) =>
        button.setButtonText("Copy JSON").onClick(async () => {
          await navigator.clipboard.writeText(JSON.stringify(this.plugin.getConnectionConfig(), null, 2));
          new Notice("Connection config copied.");
        }),
      );
  }
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
}

async function createVaultId(accountKey: string, vaultKey: string): Promise<string> {
  const input = `obsync-vault-v1:${normalizeKey(accountKey)}:${normalizeKey(vaultKey)}`;
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `vlt_${base32Url(new Uint8Array(hash)).slice(0, 26)}`;
}

function createRandomId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${base32Url(bytes).slice(0, 26)}`;
}

function base32Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }

  return output;
}


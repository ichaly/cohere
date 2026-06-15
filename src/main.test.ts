import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import CoherePlugin from "./main";
import { ObsidianVaultIO } from "./vault-io";

vi.mock("obsidian", () => ({
  App: class {},
  Notice: class {
    hide(): void {}
  },
  Platform: {
    isAndroidApp: false,
    isIosApp: false,
    isLinux: false,
    isMacOS: true,
    isTablet: false,
    isWin: false,
  },
  Plugin: class {},
  PluginSettingTab: class {},
  requestUrl: vi.fn(),
  TFile: class {},
  TFolder: class {},
}));

describe("auto sync scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("does not schedule when auto sync is disabled", async () => {
    const plugin = createPlugin({ autoSync: false });

    plugin.queueAutoSync(0);
    await vi.runAllTimersAsync();

    expect(plugin.syncNow).not.toHaveBeenCalled();
  });

  test("skips scheduled sync when auto sync is disabled before the timer fires", async () => {
    const plugin = createPlugin();

    plugin.queueAutoSync();
    plugin.settings.autoSync = false;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(plugin.syncNow).not.toHaveBeenCalled();
  });

  test("skips when connection settings are incomplete", async () => {
    const plugin = createPlugin({ secretAccessKey: "" });

    plugin.queueAutoSync(0);
    await vi.runAllTimersAsync();

    expect(plugin.syncNow).not.toHaveBeenCalled();
  });

  test("debounces repeated file-change triggers into one sync", async () => {
    const plugin = createPlugin();

    plugin.queueAutoSync();
    await vi.advanceTimersByTimeAsync(1_000);
    plugin.queueAutoSync();
    await vi.advanceTimersByTimeAsync(1_000);
    plugin.queueAutoSync();
    await vi.advanceTimersByTimeAsync(1_999);

    expect(plugin.syncNow).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(plugin.syncNow).toHaveBeenCalledTimes(1);
  });

  test("keeps file-event suppression active briefly after sync finishes", async () => {
    const plugin = createPlugin();

    plugin.startFileEventSuppression();
    expect(plugin.suppressFileSyncEvents).toBe(true);

    plugin.finishFileEventSuppression();
    expect(plugin.suppressFileSyncEvents).toBe(true);

    await vi.advanceTimersByTimeAsync(999);
    expect(plugin.suppressFileSyncEvents).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(plugin.suppressFileSyncEvents).toBe(false);
  });

  test("runs one follow-up sync when triggered during an active sync", async () => {
    const plugin = createPlugin();
    let finishSync: (() => void) | undefined;
    plugin.syncNow.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishSync = resolve;
    }));

    const firstRun = plugin.runAutoSync();
    await Promise.resolve();

    void plugin.runAutoSync();
    expect(plugin.syncNow).toHaveBeenCalledTimes(1);

    finishSync?.();
    await firstRun;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(plugin.syncNow).toHaveBeenCalledTimes(2);
  });

  test("does not run queued follow-up if auto sync is disabled while syncing", async () => {
    const plugin = createPlugin();
    let finishSync: (() => void) | undefined;
    plugin.syncNow.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishSync = resolve;
    }));

    const firstRun = plugin.runAutoSync();
    await Promise.resolve();

    void plugin.runAutoSync();
    plugin.settings.autoSync = false;
    finishSync?.();
    await firstRun;
    await vi.runAllTimersAsync();

    expect(plugin.syncNow).toHaveBeenCalledTimes(1);
  });
});

describe("connection config import and export", () => {
  test("exports shareable fields without access credentials", () => {
    const plugin = createPlugin({
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "SECRET_TEST",
      rootPrefix: "cohere/v2",
      accountKey: "team",
      vaultKey: "notes",
      vaultId: "vlt_notes",
    });

    expect(plugin.getConnectionConfig()).toEqual({
      schemaVersion: 1,
      endpoint: "https://example.com",
      bucket: "vault",
      addressingStyle: "auto",
      region: "auto",
      rootPrefix: "cohere/v2",
      accountKey: "team",
      vaultKey: "notes",
      vaultId: "vlt_notes",
    });
    expect(JSON.stringify(plugin.getConnectionConfig())).not.toContain("AKIA_TEST");
    expect(JSON.stringify(plugin.getConnectionConfig())).not.toContain("SECRET_TEST");
  });

  test("imports connection config without replacing access credentials", async () => {
    const plugin = createPlugin({
      accessKeyId: "existing-key",
      secretAccessKey: "existing-secret",
      vaultId: "old-vault",
    });

    await plugin.importConnectionConfig(JSON.stringify({
      schemaVersion: 1,
      endpoint: "https://r2.example.com",
      bucket: "shared-vault",
      addressingStyle: "virtual-hosted",
      region: "auto",
      rootPrefix: "cohere/v2",
      accountKey: "team",
      vaultKey: "product",
      vaultId: "ignored-remote-id",
    }));

    expect(plugin.settings).toMatchObject({
      endpoint: "https://r2.example.com",
      bucket: "shared-vault",
      addressingStyle: "virtual-hosted",
      region: "auto",
      rootPrefix: "cohere/v2",
      accountKey: "team",
      vaultKey: "product",
      accessKeyId: "existing-key",
      secretAccessKey: "existing-secret",
    });
    expect(plugin.settings.vaultId).not.toBe("old-vault");
    expect(plugin.settings.vaultId).not.toBe("ignored-remote-id");
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  test("exports and imports encoded connection config", async () => {
    const source = createPlugin({
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "SECRET_TEST",
      rootPrefix: "cohere/v2",
      accountKey: "team",
      vaultKey: "notes",
    });
    const target = createPlugin({
      accessKeyId: "existing-key",
      secretAccessKey: "existing-secret",
    });

    const encodedConfig = source.getEncodedConnectionConfig(true);
    expect(encodedConfig).toMatch(/^cohere:\/\/config\/v1\//);

    await target.importConnectionConfig(encodedConfig);

    expect(target.settings).toMatchObject({
      endpoint: "https://example.com",
      bucket: "vault",
      addressingStyle: "auto",
      region: "auto",
      rootPrefix: "cohere/v2",
      accountKey: "team",
      vaultKey: "notes",
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "SECRET_TEST",
    });
    expect(target.saveSettings).toHaveBeenCalledTimes(1);
  });

  test("imports encoded connection config without replacing credentials when secrets are excluded", async () => {
    const source = createPlugin({
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "SECRET_TEST",
      rootPrefix: "cohere/v2",
      accountKey: "team",
      vaultKey: "notes",
    });
    const target = createPlugin({
      accessKeyId: "existing-key",
      secretAccessKey: "existing-secret",
    });

    await target.importConnectionConfig(source.getEncodedConnectionConfig());

    expect(target.settings).toMatchObject({
      rootPrefix: "cohere/v2",
      accountKey: "team",
      vaultKey: "notes",
      accessKeyId: "existing-key",
      secretAccessKey: "existing-secret",
    });
    expect(target.saveSettings).toHaveBeenCalledTimes(1);
  });

  test("rejects invalid connection config text", async () => {
    const plugin = createPlugin();

    await expect(plugin.importConnectionConfig("not json")).rejects.toThrow("连接配置不是有效 JSON。");
    await expect(plugin.importConnectionConfig("cohere://config/v1/%")).rejects.toThrow("连接配置编码串无效。");
    await expect(plugin.importConnectionConfig(JSON.stringify({ schemaVersion: 2 }))).rejects.toThrow("连接配置版本不支持。");
    await expect(plugin.importConnectionConfig(JSON.stringify({ schemaVersion: 1, endpoint: "x" }))).rejects.toThrow("连接配置缺少 bucket。");
  });
});

describe("device identity settings", () => {
  test("recomputes the default device name when the name is cleared", async () => {
    const plugin = createPlugin({
      deviceId: "dev_ABCDEFGHIJKLMNOPQRSTUVKS5A",
      deviceName: "Custom name",
    });

    await plugin.updateSettings({ deviceName: "" });

    expect(plugin.settings.deviceName).toBe("Mac Desktop KS5A");
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });
});

describe("vault IO compatibility", () => {
  test("skips internal vault paths during file scans", async () => {
    const note = Object.assign(new TFile(), { path: "note.md", stat: { mtime: 1, size: 4 } });
    const gitObject = Object.assign(new TFile(), { path: ".git/objects/aa/hash", stat: { mtime: 1, size: 4 } });
    const pluginData = Object.assign(new TFile(), { path: ".obsidian/plugins/cohere/data.json", stat: { mtime: 1, size: 4 } });
    const trashed = Object.assign(new TFile(), { path: ".trash/deleted.md", stat: { mtime: 1, size: 4 } });
    const io = new ObsidianVaultIO({
      vault: {
        configDir: ".obsidian",
        getFiles: vi.fn(() => [note, gitObject, pluginData, trashed]),
      },
    } as never);

    await expect(io.scan()).resolves.toEqual([{ path: "note.md", mtime: 1, size: 4 }]);
  });

  test("uses stable vault APIs to find and delete files and folders", async () => {
    const file = Object.assign(new TFile(), { path: "note.md" });
    const folder = Object.assign(new TFolder(), { path: "empty", children: [] });
    const getAbstractFileByPath = vi.fn((path: string) => {
      if (path === "note.md") return file;
      if (path === "empty") return folder;
      return null;
    });
    const app = {
      fileManager: {
        trashFile: vi.fn(async () => {}),
      },
      vault: {
        adapter: { exists: vi.fn(async () => false) },
        createBinary: vi.fn(),
        createFolder: vi.fn(),
        getAbstractFileByPath,
        getAllLoadedFiles: vi.fn(() => [file, folder]),
        getFiles: vi.fn(() => [file]),
        modifyBinary: vi.fn(),
        readBinary: vi.fn(async () => new ArrayBuffer(0)),
      },
    };
    const io = new ObsidianVaultIO(app as never);

    await io.read("note.md");
    await io.delete("note.md");
    await io.deleteDirectory("empty");

    expect(getAbstractFileByPath).toHaveBeenCalledWith("note.md");
    expect(getAbstractFileByPath).toHaveBeenCalledWith("empty");
    expect(app.fileManager.trashFile).toHaveBeenCalledWith(file);
    expect(app.fileManager.trashFile).toHaveBeenCalledWith(folder);
  });
});

function createPlugin(settings: Partial<TestSettings> = {}): TestPlugin {
  const plugin = Object.create(CoherePlugin.prototype) as TestPlugin;
  plugin.app = { vault: { getName: () => "ichaly" } };
  plugin.settings = {
    endpoint: "https://example.com",
    bucket: "vault",
    addressingStyle: "auto",
    region: "auto",
    accessKeyId: "key",
    secretAccessKey: "secret",
    rootPrefix: "cohere/v1",
    accountKey: "default",
    vaultKey: "vault",
    vaultId: "vlt_test",
    deviceId: "dev_test",
    deviceName: "Mac",
    syncIntervalMinutes: 5,
    autoSync: true,
    syncEmptyDirectories: false,
    syncState: { files: {} },
    ...settings,
  };
  plugin.saveSettings = vi.fn(async () => {});
  plugin.syncNow = vi.fn(async () => {});
  return plugin;
}

type TestPlugin = {
  app: { vault: { getName: () => string } };
  settings: TestSettings;
  getConnectionConfig: (includeSecrets?: boolean) => Record<string, string | number>;
  getEncodedConnectionConfig: (includeSecrets?: boolean) => string;
  importConnectionConfig: (text: string) => Promise<void>;
  updateSettings: (update: Partial<TestSettings>) => Promise<void>;
  saveSettings: ReturnType<typeof vi.fn<() => Promise<void>>>;
  queueAutoSync: (delayMs?: number) => void;
  runAutoSync: () => Promise<void>;
  startFileEventSuppression: () => void;
  finishFileEventSuppression: () => void;
  suppressFileSyncEvents: boolean;
  syncNow: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

interface TestSettings {
  endpoint: string;
  bucket: string;
  addressingStyle: "auto" | "path" | "virtual-hosted";
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
  syncState: { files: Record<string, unknown> };
}

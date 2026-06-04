import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ObsyncPlugin from "./main";

vi.mock("obsidian", () => ({
  App: class {},
  Notice: class {
    hide(): void {}
  },
  Platform: {
    isAndroidApp: false,
    isIosApp: false,
    isTablet: false,
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

function createPlugin(settings: Partial<TestSettings> = {}): TestPlugin {
  const plugin = Object.create(ObsyncPlugin.prototype) as TestPlugin;
  plugin.settings = {
    endpoint: "https://example.com",
    bucket: "vault",
    region: "auto",
    accessKeyId: "key",
    secretAccessKey: "secret",
    rootPrefix: "obsync/v1",
    accountKey: "default",
    vaultKey: "vault",
    vaultId: "vlt_test",
    deviceId: "dev_test",
    deviceName: "Mac",
    syncIntervalMinutes: 5,
    autoSync: true,
    syncState: { files: {} },
    ...settings,
  };
  plugin.syncNow = vi.fn(async () => {});
  return plugin;
}

type TestPlugin = {
  settings: TestSettings;
  queueAutoSync: (delayMs?: number) => void;
  runAutoSync: () => Promise<void>;
  syncNow: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

interface TestSettings {
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
  syncState: { files: Record<string, unknown> };
}

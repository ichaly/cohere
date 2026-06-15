import { describe, expect, test } from "vitest";
import { blobObjectKey, createEmptyManifest, releaseDeletedContent, syncOnce, type LocalSyncState, type ObjectStore, type VaultIO } from "./engine";

describe("sync engine", () => {
  test("uploads a local file when remote has no version", async () => {
    const vault = new FakeVault({ "notes/today.md": "hello" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = { files: {} };

    const result = await sync(vault, store, state, 1000);
    const hash = await hashText("hello");

    expect(result.uploaded).toBe(1);
    expect(await store.getText(blobObjectKey(hash))).toBe("hello");
    expect(store.manifest.paths["notes/today.md"]?.contentHash).toBe(hash);
    expect(state.files["notes/today.md"]?.lastSyncedHash).toBe(hash);
  });

  test("reports progress for changed files", async () => {
    const vault = new FakeVault({
      "notes/a.md": "a",
      "notes/b.md": "b",
    });
    const store = new FakeObjectStore();
    const state: LocalSyncState = { files: {} };
    const events: Array<{ completed: number; total: number }> = [];

    await syncOnce({
      vault,
      store,
      state,
      deviceName: "Mac",
      deviceId: "dev_a",
      now: () => 1000,
      onProgress: (progress) => {
        events.push({ completed: progress.completed, total: progress.total });
      },
    });

    expect(events[0]).toEqual({ completed: 0, total: 2 });
    expect(events[events.length - 1]).toEqual({ completed: 2, total: 2 });
  });

  test("does not read unchanged local files after metadata is cached", async () => {
    const vault = new FakeVault({ "notes/today.md": "hello" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = { files: {} };

    await sync(vault, store, state, 1000);
    vault.readCount = 0;
    const result = await sync(vault, store, state, 2000);

    expect(result.uploaded).toBe(0);
    expect(result.downloaded).toBe(0);
    expect(vault.readCount).toBe(0);
  });

  test("uploads real bytes when remote state was cleared but local metadata is cached", async () => {
    const vault = new FakeVault({ "notes/today.md": "hello" });
    const state: LocalSyncState = { files: {} };

    await sync(vault, new FakeObjectStore(), state, 1000);

    const resetStore = new FakeObjectStore();
    vault.readCount = 0;
    const result = await sync(vault, resetStore, state, 2000);
    const hash = await hashText("hello");

    expect(result.uploaded).toBe(1);
    expect(vault.readCount).toBe(1);
    expect(await resetStore.getText(blobObjectKey(hash))).toBe("hello");
    expect(resetStore.manifest.paths["notes/today.md"]?.contentHash).toBe(hash);
  });

  test("skips lock and manifest write when nothing changed", async () => {
    const vault = new FakeVault({ "notes/today.md": "hello" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = { files: {} };

    await sync(vault, store, state, 1000);
    store.acquireLockCount = 0;
    store.writeManifestCount = 0;

    const result = await sync(vault, store, state, 2000);

    expect(result.locked).toBe(false);
    expect(store.acquireLockCount).toBe(0);
    expect(store.writeManifestCount).toBe(0);
  });

  test("downloads a remote file when local is unchanged", async () => {
    const vault = new FakeVault({ "notes/today.md": "base" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = {
      files: {
        "notes/today.md": {
          lastSyncedHash: await hashText("base"),
          remoteHash: await hashText("base"),
          deleted: false,
          version: "ver_base",
        },
      },
    };
    await store.putText(blobObjectKey(await hashText("remote")), "remote");
    store.manifest.paths["notes/today.md"] = {
      contentHash: await hashText("remote"),
      size: 6,
      updatedAt: 1000,
      updatedBy: "dev_other",
      revision: 1,
      version: "ver_remote",
    };

    const result = await sync(vault, store, state, 2000);

    expect(result.downloaded).toBe(1);
    expect(await vault.readText("notes/today.md")).toBe("remote");
    expect(state.files["notes/today.md"]?.lastSyncedHash).toBe(await hashText("remote"));
  });

  test("syncs a new file from one device to another device", async () => {
    const deviceA = new FakeVault({ "notes/shared.md": "from A" });
    const deviceB = new FakeVault({});
    const store = new FakeObjectStore();
    const stateA: LocalSyncState = { files: {} };
    const stateB: LocalSyncState = { files: {} };

    await syncOnce({ vault: deviceA, store, state: stateA, deviceName: "Mac", deviceId: "dev_a", now: () => 1000 });
    const result = await syncOnce({ vault: deviceB, store, state: stateB, deviceName: "Phone", deviceId: "dev_b", now: () => 2000 });

    expect(result.downloaded).toBe(1);
    expect(await deviceB.readText("notes/shared.md")).toBe("from A");
    expect(stateB.files["notes/shared.md"]?.version).toBe(stateA.files["notes/shared.md"]?.version);
  });

  test("syncs a deletion from one device to another device", async () => {
    const deviceA = new FakeVault({ "notes/shared.md": "base" });
    const deviceB = new FakeVault({});
    const store = new FakeObjectStore();
    const stateA: LocalSyncState = { files: {} };
    const stateB: LocalSyncState = { files: {} };

    await syncOnce({ vault: deviceA, store, state: stateA, deviceName: "Mac", deviceId: "dev_a", now: () => 1000 });
    await syncOnce({ vault: deviceB, store, state: stateB, deviceName: "Phone", deviceId: "dev_b", now: () => 2000 });
    await deviceA.delete("notes/shared.md");
    await syncOnce({ vault: deviceA, store, state: stateA, deviceName: "Mac", deviceId: "dev_a", now: () => 3000 });
    const result = await syncOnce({ vault: deviceB, store, state: stateB, deviceName: "Phone", deviceId: "dev_b", now: () => 4000 });

    expect(result.deletedLocal).toBe(1);
    expect(await deviceB.readText("notes/shared.md")).toBe("");
    expect(stateB.files["notes/shared.md"]?.deleted).toBe(true);
    expect(store.manifest.deleted["notes/shared.md"]).toBeDefined();
  });

  test("does not sync empty directories when the option is disabled", async () => {
    const vault = new FakeVault({}, ["projects/empty"]);
    const store = new FakeObjectStore();
    const state: LocalSyncState = { files: {} };

    await sync(vault, store, state, 1000);

    expect(store.manifest.directories["projects/empty"]).toBeUndefined();
    expect(state.directories?.["projects/empty"]).toBeUndefined();
  });

  test("syncs an empty directory when the option is enabled", async () => {
    const deviceA = new FakeVault({}, ["projects/empty"]);
    const deviceB = new FakeVault({});
    const store = new FakeObjectStore();
    const stateA: LocalSyncState = { files: {} };
    const stateB: LocalSyncState = { files: {} };

    await syncOnce({ vault: deviceA, store, state: stateA, deviceName: "Mac", deviceId: "dev_a", syncEmptyDirectories: true, now: () => 1000 });
    await syncOnce({ vault: deviceB, store, state: stateB, deviceName: "Phone", deviceId: "dev_b", syncEmptyDirectories: true, now: () => 2000 });

    expect(store.manifest.directories["projects/empty"]).toBeDefined();
    expect(deviceB.hasDirectory("projects/empty")).toBe(true);
    expect(stateB.directories?.["projects/empty"]?.deleted).toBe(false);
  });

  test("syncs an empty directory deletion when the option is enabled", async () => {
    const deviceA = new FakeVault({}, ["projects/empty"]);
    const deviceB = new FakeVault({});
    const store = new FakeObjectStore();
    const stateA: LocalSyncState = { files: {} };
    const stateB: LocalSyncState = { files: {} };

    await syncOnce({ vault: deviceA, store, state: stateA, deviceName: "Mac", deviceId: "dev_a", syncEmptyDirectories: true, now: () => 1000 });
    await syncOnce({ vault: deviceB, store, state: stateB, deviceName: "Phone", deviceId: "dev_b", syncEmptyDirectories: true, now: () => 2000 });
    await deviceA.deleteDirectory("projects/empty");
    await syncOnce({ vault: deviceA, store, state: stateA, deviceName: "Mac", deviceId: "dev_a", syncEmptyDirectories: true, now: () => 3000 });
    await syncOnce({ vault: deviceB, store, state: stateB, deviceName: "Phone", deviceId: "dev_b", syncEmptyDirectories: true, now: () => 4000 });

    expect(store.manifest.directories["projects/empty"]).toBeUndefined();
    expect(store.manifest.deletedDirectories["projects/empty"]).toBeDefined();
    expect(deviceB.hasDirectory("projects/empty")).toBe(false);
    expect(stateB.directories?.["projects/empty"]?.deleted).toBe(true);
  });

  test("does not delete local empty directories when the option is disabled", async () => {
    const vault = new FakeVault({}, ["projects/empty"]);
    const store = new FakeObjectStore();
    const state: LocalSyncState = {
      files: {},
      directories: {
        "projects/empty": { deleted: false, version: "ver_dir" },
      },
    };
    store.manifest.deletedDirectories["projects/empty"] = {
      deletedAt: 1000,
      deletedRevision: 1,
      previousVersion: "ver_dir",
      deletedBy: "dev_other",
    };

    await syncOnce({ vault, store, state, deviceName: "Mac", deviceId: "dev_mac", now: () => 2000 });

    expect(vault.hasDirectory("projects/empty")).toBe(true);
  });

  test("syncs delete then same-name recreate as a new version to another device", async () => {
    const deviceA = new FakeVault({ "notes/shared.md": "old" });
    const deviceB = new FakeVault({});
    const store = new FakeObjectStore();
    const stateA: LocalSyncState = { files: {} };
    const stateB: LocalSyncState = { files: {} };

    await syncOnce({ vault: deviceA, store, state: stateA, deviceName: "Mac", deviceId: "dev_a", now: () => 1000 });
    await syncOnce({ vault: deviceB, store, state: stateB, deviceName: "Phone", deviceId: "dev_b", now: () => 2000 });
    const oldVersion = stateB.files["notes/shared.md"]?.version;
    await deviceA.delete("notes/shared.md");
    await syncOnce({ vault: deviceA, store, state: stateA, deviceName: "Mac", deviceId: "dev_a", now: () => 3000 });
    await syncOnce({ vault: deviceB, store, state: stateB, deviceName: "Phone", deviceId: "dev_b", now: () => 4000 });
    await deviceA.write("notes/shared.md", new TextEncoder().encode("new"));
    await syncOnce({ vault: deviceA, store, state: stateA, deviceName: "Mac", deviceId: "dev_a", now: () => 5000 });
    const result = await syncOnce({ vault: deviceB, store, state: stateB, deviceName: "Phone", deviceId: "dev_b", now: () => 6000 });

    expect(result.downloaded).toBe(1);
    expect(await deviceB.readText("notes/shared.md")).toBe("new");
    expect(stateB.files["notes/shared.md"]?.version).not.toBe(oldVersion);
    expect(store.manifest.deleted["notes/shared.md"]?.previousVersion).toBe(oldVersion);
  });

  test("keeps stale device content as a conflict instead of resurrecting a deleted file", async () => {
    const deviceA = new FakeVault({ "notes/shared.md": "base" });
    const staleDevice = new FakeVault({ "notes/shared.md": "stale local" });
    const store = new FakeObjectStore();
    const stateA: LocalSyncState = { files: {} };
    const staleState: LocalSyncState = { files: {} };

    await syncOnce({ vault: deviceA, store, state: stateA, deviceName: "Mac", deviceId: "dev_a", now: () => 1000 });
    await deviceA.delete("notes/shared.md");
    await syncOnce({ vault: deviceA, store, state: stateA, deviceName: "Mac", deviceId: "dev_a", now: () => 2000 });
    const result = await syncOnce({ vault: staleDevice, store, state: staleState, deviceName: "Phone", deviceId: "dev_b", now: () => 3000 });

    expect(result.conflicts).toBe(1);
    expect(result.uploaded).toBe(0);
    expect(store.manifest.paths["notes/shared.md"]).toBeUndefined();
    expect(await staleDevice.readText("notes/shared.md")).toBe("");
    expect(await staleDevice.readText("notes/shared.conflict.Phone.19700101-000003.md")).toBe("stale local");
  });

  test("stores uploaded content under a hash blob instead of the original path", async () => {
    const vault = new FakeVault({ "notes/today.md": "hello" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = { files: {} };

    await sync(vault, store, state, 1000);

    const hash = await hashText("hello");
    expect(await store.getText(`blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`)).toBe("hello");
    expect(store.objects["files/notes/today.md"]).toBeUndefined();
    expect(store.manifest.paths["notes/today.md"]?.contentHash).toBe(hash);
  });

  test("rewrites a hash blob when manifest has a stale blob record but the object is missing", async () => {
    const vault = new FakeVault({ "notes/today.md": "hello" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = { files: {} };
    const hash = await hashText("hello");
    store.manifest.blobs[hash] = {
      key: blobObjectKey(hash),
      size: 5,
      createdAt: 1000,
    };

    await sync(vault, store, state, 2000);

    expect(await store.getText(blobObjectKey(hash))).toBe("hello");
  });

  test("marks a path deleted without immediately deleting the old blob", async () => {
    const vault = new FakeVault({ "notes/today.md": "hello" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = { files: {} };

    await sync(vault, store, state, 1000);
    const hash = await hashText("hello");
    await vault.delete("notes/today.md");
    const result = await sync(vault, store, state, 2000);

    expect(result.deletedRemote).toBe(1);
    expect(result.conflicts).toBe(0);
    expect(await store.getText(`blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`)).toBe("hello");
    expect(store.manifest.paths["notes/today.md"]).toBeUndefined();
    expect(store.manifest.deleted["notes/today.md"]?.previousContentHash).toBe(hash);
  });

  test("local deletion wins instead of creating a conflict", async () => {
    const baseHash = await hashText("base");
    const vault = new FakeVault({});
    const store = new FakeObjectStore();
    const state: LocalSyncState = {
      files: {
        "notes/today.md": {
          lastSyncedHash: baseHash,
          remoteHash: baseHash,
          deleted: false,
          version: "ver_base",
        },
      },
    };
    await store.putText(blobObjectKey(await hashText("remote")), "remote");
    store.manifest.paths["notes/today.md"] = {
      contentHash: await hashText("remote"),
      size: 6,
      updatedAt: 1000,
      updatedBy: "dev_other",
      revision: 1,
      version: "ver_remote",
    };

    const result = await sync(vault, store, state, 2000);

    expect(result.deletedRemote).toBe(1);
    expect(result.conflicts).toBe(0);
    expect(store.manifest.paths["notes/today.md"]).toBeUndefined();
    expect(store.manifest.deleted["notes/today.md"]?.previousContentHash).toBe(baseHash);
  });

  test("deletes local file when another device deleted the path", async () => {
    const hash = await hashText("base");
    const vault = new FakeVault({ "notes/today.md": "base" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = {
      files: {
        "notes/today.md": {
          lastSyncedHash: hash,
          remoteHash: hash,
          deleted: false,
          version: "ver_base",
        },
      },
    };
    store.manifest.deleted["notes/today.md"] = {
      deletedAt: 2000,
      deletedRevision: 2,
      previousContentHash: hash,
      previousVersion: "ver_base",
      deletedBy: "dev_other",
    };

    const result = await sync(vault, store, state, 3000);

    expect(result.deletedLocal).toBe(1);
    await expect(vault.readText("notes/today.md")).resolves.toBe("");
    expect(state.files["notes/today.md"]?.deleted).toBe(true);
  });

  test("keeps a conflict copy when remote deleted a path that changed locally", async () => {
    const hash = await hashText("base");
    const vault = new FakeVault({ "notes/today.md": "local changed" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = {
      files: {
        "notes/today.md": {
          lastSyncedHash: hash,
          remoteHash: hash,
          deleted: false,
          version: "ver_base",
        },
      },
    };
    store.manifest.deleted["notes/today.md"] = {
      deletedAt: 2000,
      deletedRevision: 2,
      previousContentHash: hash,
      previousVersion: "ver_base",
      deletedBy: "dev_other",
    };

    const result = await sync(vault, store, state, 3000);

    expect(result.conflicts).toBe(1);
    expect(result.deletedLocal).toBe(1);
    expect(await vault.readText("notes/today.md")).toBe("");
    expect(await vault.readText("notes/today.conflict.Mac.19700101-000003.md")).toBe("local changed");
    expect(state.files["notes/today.md"]?.deleted).toBe(true);
  });

  test("does not resurrect a tombstoned path when local state is missing", async () => {
    const hash = await hashText("deleted");
    const vault = new FakeVault({ "notes/today.md": "stale local" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = { files: {} };
    store.manifest.deleted["notes/today.md"] = {
      deletedAt: 2000,
      deletedRevision: 2,
      previousContentHash: hash,
      previousVersion: "ver_deleted",
      deletedBy: "dev_other",
    };

    const result = await sync(vault, store, state, 3000);

    expect(result.conflicts).toBe(1);
    expect(result.uploaded).toBe(0);
    expect(store.manifest.paths["notes/today.md"]).toBeUndefined();
    expect(await vault.readText("notes/today.md")).toBe("");
    expect(await vault.readText("notes/today.conflict.Mac.19700101-000003.md")).toBe("stale local");
  });

  test("keeps recent tombstones in the manifest", async () => {
    const vault = new FakeVault({});
    const store = new FakeObjectStore();
    const state: LocalSyncState = {
      files: {
        "notes/today.md": {
          lastSyncedHash: "old",
          remoteHash: "old",
          deleted: true,
          version: "ver_old",
        },
      },
    };
    store.manifest.deleted["notes/today.md"] = {
      deletedAt: 1000,
      deletedRevision: 1,
      previousContentHash: "old",
      previousVersion: "ver_old",
      deletedBy: "dev_other",
    };
    store.writeManifestCount = 0;

    await sync(vault, store, state, 1000 + 29 * 24 * 60 * 60 * 1000);

    expect(store.manifest.deleted["notes/today.md"]).toBeDefined();
    expect(state.files["notes/today.md"]?.deleted).toBe(true);
    expect(store.writeManifestCount).toBe(0);
  });

  test("prunes expired tombstones from the manifest and local state", async () => {
    const vault = new FakeVault({});
    const store = new FakeObjectStore();
    const state: LocalSyncState = {
      files: {
        "notes/today.md": {
          lastSyncedHash: "old",
          remoteHash: "old",
          deleted: true,
          version: "ver_old",
        },
      },
    };
    store.manifest.deleted["notes/today.md"] = {
      deletedAt: 1000,
      deletedRevision: 1,
      previousContentHash: "old",
      previousVersion: "ver_old",
      deletedBy: "dev_other",
    };

    await sync(vault, store, state, 1000 + 30 * 24 * 60 * 60 * 1000);

    expect(store.manifest.deleted["notes/today.md"]).toBeUndefined();
    expect(state.files["notes/today.md"]).toBeUndefined();
    expect(store.writeManifestCount).toBe(1);
  });

  test("pruning an old tombstone does not remove current state for a same-name recreated file", async () => {
    const activeHash = await hashText("new");
    const vault = new FakeVault({ "notes/today.md": "new" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = {
      files: {
        "notes/today.md": {
          lastSyncedHash: activeHash,
          remoteHash: activeHash,
          deleted: false,
          version: "ver_new",
          localMtime: 1,
          localSize: 3,
        },
      },
    };
    await store.putText(blobObjectKey(activeHash), "new");
    store.manifest.paths["notes/today.md"] = {
      contentHash: activeHash,
      size: 3,
      updatedAt: 2000,
      updatedBy: "dev_mac",
      revision: 2,
      version: "ver_new",
    };
    store.manifest.deleted["notes/today.md"] = {
      deletedAt: 1000,
      deletedRevision: 1,
      previousContentHash: await hashText("old"),
      previousVersion: "ver_old",
      deletedBy: "dev_mac",
    };

    const result = await sync(vault, store, state, 1000 + 30 * 24 * 60 * 60 * 1000);

    expect(result.uploaded).toBe(0);
    expect(store.manifest.deleted["notes/today.md"]).toBeUndefined();
    expect(store.manifest.paths["notes/today.md"]?.version).toBe("ver_new");
    expect(state.files["notes/today.md"]?.version).toBe("ver_new");
    expect(state.files["notes/today.md"]?.deleted).toBe(false);
  });

  test("treats delete then same-name create as a new version", async () => {
    const vault = new FakeVault({ "notes/today.md": "old" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = { files: {} };

    await sync(vault, store, state, 1000);
    const oldVersion = store.manifest.paths["notes/today.md"]?.version;
    await vault.delete("notes/today.md");
    await sync(vault, store, state, 2000);
    await vault.write("notes/today.md", new TextEncoder().encode("new"));

    const result = await sync(vault, store, state, 3000);

    expect(result.uploaded).toBe(1);
    expect(store.manifest.paths["notes/today.md"]?.contentHash).toBe(await hashText("new"));
    expect(store.manifest.paths["notes/today.md"]?.version).not.toBe(oldVersion);
    expect(store.manifest.deleted["notes/today.md"]?.previousVersion).toBe(oldVersion);
    expect(state.files["notes/today.md"]?.deleted).toBe(false);
  });

  test("same-name create gets a new version even when content matches the deleted file", async () => {
    const vault = new FakeVault({ "notes/today.md": "same" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = { files: {} };

    await sync(vault, store, state, 1000);
    const oldVersion = store.manifest.paths["notes/today.md"]?.version;
    await vault.delete("notes/today.md");
    await sync(vault, store, state, 2000);
    await vault.write("notes/today.md", new TextEncoder().encode("same"));

    await sync(vault, store, state, 3000);

    expect(store.manifest.paths["notes/today.md"]?.contentHash).toBe(await hashText("same"));
    expect(store.manifest.paths["notes/today.md"]?.version).not.toBe(oldVersion);
  });

  test("writes a conflict copy when a deleted path was recreated remotely and local also changed", async () => {
    const baseHash = await hashText("base");
    const remoteHash = await hashText("remote-new");
    const vault = new FakeVault({ "notes/today.md": "local-new" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = {
      files: {
        "notes/today.md": {
          lastSyncedHash: baseHash,
          remoteHash: baseHash,
          deleted: false,
          version: "ver_base",
        },
      },
    };
    await store.putText(blobObjectKey(remoteHash), "remote-new");
    store.manifest.paths["notes/today.md"] = {
      contentHash: remoteHash,
      size: 10,
      updatedAt: 3000,
      updatedBy: "dev_other",
      revision: 3,
      version: "ver_remote_recreated",
    };
    store.manifest.deleted["notes/today.md"] = {
      deletedAt: 2000,
      deletedRevision: 2,
      previousContentHash: baseHash,
      previousVersion: "ver_base",
      deletedBy: "dev_other",
    };

    const result = await sync(vault, store, state, 4000);

    expect(result.conflicts).toBe(1);
    expect(await vault.readText("notes/today.md")).toBe("local-new");
    expect(await vault.readText("notes/today.conflict.Mac.19700101-000004.md")).toBe("remote-new");
  });

  test("does not create duplicate conflict copies after the same remote conflict was already recorded", async () => {
    const baseHash = await hashText("base");
    const remoteHash = await hashText("remote");
    const vault = new FakeVault({ "notes/today.md": "local" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = {
      files: {
        "notes/today.md": {
          lastSyncedHash: baseHash,
          remoteHash: baseHash,
          deleted: false,
          version: "ver_base",
        },
      },
    };
    await store.putText(blobObjectKey(remoteHash), "remote");
    store.manifest.paths["notes/today.md"] = {
      contentHash: remoteHash,
      size: 6,
      updatedAt: 2000,
      updatedBy: "dev_other",
      revision: 2,
      version: "ver_remote",
    };

    const firstResult = await sync(vault, store, state, 3000);
    const secondResult = await sync(vault, store, state, 4000);

    expect(firstResult.conflicts).toBe(1);
    expect(secondResult.conflicts).toBe(0);
    expect(secondResult.uploaded).toBe(2);
    expect(await vault.readText("notes/today.conflict.Mac.19700101-000003.md")).toBe("remote");
    expect(await vault.readText("notes/today.conflict.Mac.19700101-000004.md")).toBe("");
    expect(store.manifest.paths["notes/today.md"]?.contentHash).toBe(await hashText("local"));
  });

  test("does not create a conflict when local and remote content match", async () => {
    const baseHash = await hashText("base");
    const sameHash = await hashText("same");
    const vault = new FakeVault({ "notes/today.md": "same" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = {
      files: {
        "notes/today.md": {
          lastSyncedHash: baseHash,
          remoteHash: baseHash,
          deleted: false,
          version: "ver_base",
        },
      },
    };
    await store.putText(blobObjectKey(sameHash), "same");
    store.manifest.paths["notes/today.md"] = {
      contentHash: sameHash,
      size: 4,
      updatedAt: 2000,
      updatedBy: "dev_other",
      revision: 2,
      version: "ver_remote",
    };

    const result = await sync(vault, store, state, 3000);

    expect(result.conflicts).toBe(0);
    expect(result.downloaded).toBe(1);
    expect(await vault.readText("notes/today.md")).toBe("same");
    expect(await vault.readText("notes/today.conflict.Mac.19700101-000003.md")).toBe("");
    expect(state.files["notes/today.md"]?.lastSyncedHash).toBe(sameHash);
    expect(state.files["notes/today.md"]?.version).toBe("ver_remote");
  });

  test("releaseDeletedContent removes deleted tombstones and unreferenced blobs", async () => {
    const keptHash = await hashText("kept");
    const deletedHash = await hashText("deleted");
    const orphanHash = await hashText("orphan");
    const store = new FakeObjectStore();
    store.manifest.paths["notes/kept.md"] = {
      contentHash: keptHash,
      size: 4,
      updatedAt: 1000,
      updatedBy: "dev_mac",
      revision: 1,
      version: "ver_kept",
    };
    store.manifest.deleted["notes/deleted.md"] = {
      deletedAt: 1000,
      deletedRevision: 2,
      previousContentHash: deletedHash,
      previousVersion: "ver_deleted",
      deletedBy: "dev_mac",
    };
    store.manifest.deletedDirectories["notes/empty"] = {
      deletedAt: 1000,
      deletedRevision: 3,
      previousVersion: "ver_empty",
      deletedBy: "dev_mac",
    };
    await store.putText(blobObjectKey(keptHash), "kept");
    await store.putText(blobObjectKey(deletedHash), "deleted");
    await store.putText(blobObjectKey(orphanHash), "orphan");

    const result = await releaseDeletedContent({ store, now: () => 5000 });

    expect(result.deletedTombstones).toBe(1);
    expect(result.deletedDirectoryTombstones).toBe(1);
    expect(result.deletedBlobs).toBe(2);
    expect(store.manifest.deleted["notes/deleted.md"]).toBeUndefined();
    expect(store.manifest.deletedDirectories["notes/empty"]).toBeUndefined();
    expect(store.objects[blobObjectKey(keptHash)]).toBeDefined();
    expect(store.objects[blobObjectKey(deletedHash)]).toBeUndefined();
    expect(store.objects[blobObjectKey(orphanHash)]).toBeUndefined();
  });

  test("releaseDeletedContent skips cleanup when the remote lock is held", async () => {
    const deletedHash = await hashText("deleted");
    const store = new FakeObjectStore();
    store.lockAvailable = false;
    store.manifest.deleted["notes/deleted.md"] = {
      deletedAt: 1000,
      deletedRevision: 2,
      previousContentHash: deletedHash,
      previousVersion: "ver_deleted",
      deletedBy: "dev_mac",
    };
    store.manifest.deletedDirectories["notes/empty"] = {
      deletedAt: 1000,
      deletedRevision: 3,
      previousVersion: "ver_empty",
      deletedBy: "dev_mac",
    };
    await store.putText(blobObjectKey(deletedHash), "deleted");

    const result = await releaseDeletedContent({ store, now: () => 5000 });

    expect(result.locked).toBe(true);
    expect(result.deletedTombstones).toBe(0);
    expect(result.deletedDirectoryTombstones).toBe(0);
    expect(result.deletedBlobs).toBe(0);
    expect(store.manifest.deleted["notes/deleted.md"]).toBeDefined();
    expect(store.manifest.deletedDirectories["notes/empty"]).toBeDefined();
    expect(store.objects[blobObjectKey(deletedHash)]).toBeDefined();
  });

  test("writes a conflict copy when local and remote both changed", async () => {
    const baseHash = await hashText("base");
    const vault = new FakeVault({ "notes/today.md": "local" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = {
      files: {
        "notes/today.md": {
          lastSyncedHash: baseHash,
          remoteHash: baseHash,
          deleted: false,
          version: "ver_base",
        },
      },
    };
    await store.putText(blobObjectKey(await hashText("remote")), "remote");
    store.manifest.paths["notes/today.md"] = {
      contentHash: await hashText("remote"),
      size: 6,
      updatedAt: 1000,
      updatedBy: "dev_other",
      revision: 1,
      version: "ver_remote",
    };

    const result = await sync(vault, store, state, 2000);

    expect(result.conflicts).toBe(1);
    expect(await vault.readText("notes/today.md")).toBe("local");
    expect(await vault.readText("notes/today.conflict.Mac.19700101-000002.md")).toBe("remote");
  });
});

class FakeVault implements VaultIO {
  private files: Record<string, Uint8Array>;
  private directories: Set<string>;
  private stats: Record<string, { mtime: number; size: number }>;
  readCount = 0;

  constructor(files: Record<string, string>, directories: string[] = []) {
    this.files = {};
    this.directories = new Set(directories);
    this.stats = {};
    for (const [path, content] of Object.entries(files)) {
      this.setFile(path, new TextEncoder().encode(content));
    }
  }

  async scan(): Promise<Array<{ path: string; mtime: number; size: number }>> {
    return Object.keys(this.files).map((path) => ({ path, ...this.stats[path] }));
  }

  async scanEmptyDirectories(): Promise<string[]> {
    return Array.from(this.directories).filter((directory) => {
      const prefix = `${directory}/`;
      return !Object.keys(this.files).some((path) => path.startsWith(prefix)) && !Array.from(this.directories).some((path) => path !== directory && path.startsWith(prefix));
    });
  }

  async read(path: string): Promise<Uint8Array> {
    this.readCount += 1;
    return this.files[path] ?? new Uint8Array();
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.setFile(path, bytes);
  }

  async delete(path: string): Promise<void> {
    delete this.files[path];
  }

  async createDirectory(path: string): Promise<void> {
    this.directories.add(path);
  }

  async deleteDirectory(path: string): Promise<void> {
    this.directories.delete(path);
  }

  hasDirectory(path: string): boolean {
    return this.directories.has(path);
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.read(path));
  }

  private setFile(path: string, bytes: Uint8Array): void {
    this.files[path] = bytes;
    this.stats[path] = {
      mtime: (this.stats[path]?.mtime ?? 0) + 1,
      size: bytes.byteLength,
    };
  }
}

class FakeObjectStore implements ObjectStore {
  manifest = createEmptyManifest();
  objects: Record<string, Uint8Array> = {};
  acquireLockCount = 0;
  lockAvailable = true;
  writeManifestCount = 0;

  async acquireLock(): Promise<boolean> {
    this.acquireLockCount += 1;
    return this.lockAvailable;
  }

  async releaseLock(): Promise<void> {
    return;
  }

  async readManifest() {
    return this.manifest;
  }

  async writeManifest(manifest: ReturnType<typeof createEmptyManifest>): Promise<void> {
    this.writeManifestCount += 1;
    this.manifest = manifest;
  }

  async readObject(key: string): Promise<Uint8Array> {
    return this.objects[key] ?? new Uint8Array();
  }

  async writeObject(key: string, bytes: Uint8Array): Promise<void> {
    this.objects[key] = bytes;
  }

  async deleteObject(key: string): Promise<void> {
    delete this.objects[key];
  }

  async listObjectKeys(prefix: string): Promise<string[]> {
    return Object.keys(this.objects).filter((key) => key.startsWith(prefix));
  }

  async putText(key: string, value: string): Promise<void> {
    await this.writeObject(key, new TextEncoder().encode(value));
  }

  async getText(key: string): Promise<string> {
    return new TextDecoder().decode(await this.readObject(key));
  }
}

function sync(vault: VaultIO, store: ObjectStore, state: LocalSyncState, timestamp: number) {
  return syncOnce({ vault, store, state, deviceName: "Mac", deviceId: "dev_mac", now: () => timestamp });
}

async function hashText(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

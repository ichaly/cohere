import { describe, expect, test } from "vitest";
import { createEmptyManifest, syncOnce, type LocalSyncState, type ObjectStore, type VaultIO } from "./engine";

describe("sync engine", () => {
  test("uploads a local file when remote has no version", async () => {
    const vault = new FakeVault({ "notes/today.md": "hello" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = { files: {} };

    const result = await syncOnce({ vault, store, state, deviceName: "Mac", now: () => 1000 });

    expect(result.uploaded).toBe(1);
    expect(await store.getText("files/notes/today.md")).toBe("hello");
    expect(store.manifest.files["notes/today.md"]?.deleted).toBe(false);
    expect(state.files["notes/today.md"]?.lastSyncedHash).toBe(store.manifest.files["notes/today.md"]?.hash);
  });

  test("does not read unchanged local files after metadata is cached", async () => {
    const vault = new FakeVault({ "notes/today.md": "hello" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = { files: {} };

    await syncOnce({ vault, store, state, deviceName: "Mac", now: () => 1000 });
    vault.readCount = 0;
    const result = await syncOnce({ vault, store, state, deviceName: "Mac", now: () => 2000 });

    expect(result.uploaded).toBe(0);
    expect(result.downloaded).toBe(0);
    expect(vault.readCount).toBe(0);
  });

  test("skips lock and manifest write when nothing changed", async () => {
    const vault = new FakeVault({ "notes/today.md": "hello" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = { files: {} };

    await syncOnce({ vault, store, state, deviceName: "Mac", now: () => 1000 });
    store.acquireLockCount = 0;
    store.writeManifestCount = 0;

    const result = await syncOnce({ vault, store, state, deviceName: "Mac", now: () => 2000 });

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
        },
      },
    };
    await store.putText("files/notes/today.md", "remote");
    store.manifest.files["notes/today.md"] = {
      hash: await hashText("remote"),
      size: 6,
      updatedAt: 1000,
      deleted: false,
    };

    const result = await syncOnce({ vault, store, state, deviceName: "Mac", now: () => 2000 });

    expect(result.downloaded).toBe(1);
    expect(await vault.readText("notes/today.md")).toBe("remote");
    expect(state.files["notes/today.md"]?.lastSyncedHash).toBe(await hashText("remote"));
  });

  test("deletes the remote object when a synced local file is deleted", async () => {
    const vault = new FakeVault({ "notes/today.md": "hello" });
    const store = new FakeObjectStore();
    const state: LocalSyncState = { files: {} };

    await syncOnce({ vault, store, state, deviceName: "Mac", now: () => 1000 });
    await vault.delete("notes/today.md");
    const result = await syncOnce({ vault, store, state, deviceName: "Mac", now: () => 2000 });

    expect(result.deletedRemote).toBe(1);
    expect(result.conflicts).toBe(0);
    expect(store.objects["files/notes/today.md"]).toBeUndefined();
    expect(store.manifest.files["notes/today.md"]?.deleted).toBe(true);
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
        },
      },
    };
    await store.putText("files/notes/today.md", "remote");
    store.manifest.files["notes/today.md"] = {
      hash: await hashText("remote"),
      size: 6,
      updatedAt: 1000,
      deleted: false,
    };

    const result = await syncOnce({ vault, store, state, deviceName: "Mac", now: () => 2000 });

    expect(result.deletedRemote).toBe(1);
    expect(result.conflicts).toBe(0);
    expect(store.objects["files/notes/today.md"]).toBeUndefined();
    expect(store.manifest.files["notes/today.md"]?.deleted).toBe(true);
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
        },
      },
    };
    store.manifest.files["notes/today.md"] = {
      hash: "old",
      size: 0,
      updatedAt: 1000,
      deleted: true,
    };
    store.writeManifestCount = 0;

    await syncOnce({ vault, store, state, deviceName: "Mac", now: () => 1000 + 29 * 24 * 60 * 60 * 1000 });

    expect(store.manifest.files["notes/today.md"]?.deleted).toBe(true);
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
        },
      },
    };
    store.manifest.files["notes/today.md"] = {
      hash: "old",
      size: 0,
      updatedAt: 1000,
      deleted: true,
    };

    await syncOnce({ vault, store, state, deviceName: "Mac", now: () => 1000 + 30 * 24 * 60 * 60 * 1000 });

    expect(store.manifest.files["notes/today.md"]).toBeUndefined();
    expect(state.files["notes/today.md"]).toBeUndefined();
    expect(store.writeManifestCount).toBe(1);
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
        },
      },
    };
    await store.putText("files/notes/today.md", "remote");
    store.manifest.files["notes/today.md"] = {
      hash: await hashText("remote"),
      size: 6,
      updatedAt: 1000,
      deleted: false,
    };

    const result = await syncOnce({ vault, store, state, deviceName: "Mac", now: () => 2000 });

    expect(result.conflicts).toBe(1);
    expect(await vault.readText("notes/today.md")).toBe("local");
    expect(await vault.readText("notes/today.conflict.Mac.19700101-080002.md")).toBe("remote");
  });
});

class FakeVault implements VaultIO {
  private files: Record<string, Uint8Array>;
  private stats: Record<string, { mtime: number; size: number }>;
  readCount = 0;

  constructor(files: Record<string, string>) {
    this.files = {};
    this.stats = {};
    for (const [path, content] of Object.entries(files)) {
      this.setFile(path, new TextEncoder().encode(content));
    }
  }

  async scan(): Promise<Array<{ path: string; mtime: number; size: number }>> {
    return Object.keys(this.files).map((path) => ({ path, ...this.stats[path] }));
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
  writeManifestCount = 0;

  async acquireLock(): Promise<boolean> {
    this.acquireLockCount += 1;
    return true;
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

  async putText(key: string, value: string): Promise<void> {
    await this.writeObject(key, new TextEncoder().encode(value));
  }

  async getText(key: string): Promise<string> {
    return new TextDecoder().decode(await this.readObject(key));
  }
}

async function hashText(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

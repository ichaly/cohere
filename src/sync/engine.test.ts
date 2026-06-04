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

  constructor(files: Record<string, string>) {
    this.files = {};
    for (const [path, content] of Object.entries(files)) {
      this.files[path] = new TextEncoder().encode(content);
    }
  }

  async scan(): Promise<Array<{ path: string; bytes: Uint8Array }>> {
    return Object.entries(this.files).map(([path, bytes]) => ({ path, bytes }));
  }

  async read(path: string): Promise<Uint8Array> {
    return this.files[path] ?? new Uint8Array();
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files[path] = bytes;
  }

  async delete(path: string): Promise<void> {
    delete this.files[path];
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.read(path));
  }
}

class FakeObjectStore implements ObjectStore {
  manifest = createEmptyManifest();
  objects: Record<string, Uint8Array> = {};

  async acquireLock(): Promise<boolean> {
    return true;
  }

  async releaseLock(): Promise<void> {
    return;
  }

  async readManifest() {
    return this.manifest;
  }

  async writeManifest(manifest: ReturnType<typeof createEmptyManifest>): Promise<void> {
    this.manifest = manifest;
  }

  async readObject(key: string): Promise<Uint8Array> {
    return this.objects[key] ?? new Uint8Array();
  }

  async writeObject(key: string, bytes: Uint8Array): Promise<void> {
    this.objects[key] = bytes;
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

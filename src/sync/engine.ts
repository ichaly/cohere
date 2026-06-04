import { planFileAction } from "./planner";

export interface ManifestFileEntry {
  hash: string;
  size: number;
  updatedAt: number;
  deleted: boolean;
}

export interface RemoteManifest {
  schemaVersion: 1;
  updatedAt: number;
  files: Record<string, ManifestFileEntry>;
}

export interface LocalFileState {
  lastSyncedHash: string | null;
  remoteHash: string | null;
  deleted: boolean;
}

export interface LocalSyncState {
  files: Record<string, LocalFileState>;
  lastSyncAt?: number;
}

export interface VaultIO {
  scan(): Promise<Array<{ path: string; bytes: Uint8Array }>>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
}

export interface ObjectStore {
  acquireLock(): Promise<boolean>;
  releaseLock(): Promise<void>;
  readManifest(): Promise<RemoteManifest>;
  writeManifest(manifest: RemoteManifest): Promise<void>;
  readObject(key: string): Promise<Uint8Array>;
  writeObject(key: string, bytes: Uint8Array): Promise<void>;
}

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  conflicts: number;
  deletedLocal: number;
  deletedRemote: number;
  locked: boolean;
}

interface SyncOnceInput {
  vault: VaultIO;
  store: ObjectStore;
  state: LocalSyncState;
  deviceName: string;
  now(): number;
}

export function createEmptyManifest(): RemoteManifest {
  return {
    schemaVersion: 1,
    updatedAt: 0,
    files: {},
  };
}

export async function syncOnce(input: SyncOnceInput): Promise<SyncResult> {
  const locked = await input.store.acquireLock();
  const result: SyncResult = {
    uploaded: 0,
    downloaded: 0,
    conflicts: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    locked: !locked,
  };

  if (!locked) {
    return result;
  }

  try {
    const manifest = await input.store.readManifest();
    const localFiles = await scanLocalFiles(input.vault);
    const paths = new Set([...Object.keys(localFiles), ...Object.keys(manifest.files), ...Object.keys(input.state.files)]);

    for (const path of paths) {
      const local = localFiles[path];
      const remote = manifest.files[path];
      const previous = input.state.files[path];
      const lastSyncedHash = previous?.lastSyncedHash ?? null;
      const localDeleted = Boolean(previous) && !local;
      const remoteDeleted = remote?.deleted ?? false;
      const remoteHash = remote?.hash ?? null;
      const localHash = local?.hash ?? null;

      const action = planFileAction({
        localHash,
        lastSyncedHash,
        remoteHash,
        localDeleted,
        remoteDeleted,
      });

      if (action === "upload" && local) {
        await input.store.writeObject(fileObjectKey(path), local.bytes);
        manifest.files[path] = {
          hash: local.hash,
          size: local.bytes.byteLength,
          updatedAt: input.now(),
          deleted: false,
        };
        input.state.files[path] = syncedState(local.hash);
        result.uploaded += 1;
      }

      if (action === "download" && remote) {
        const bytes = await input.store.readObject(fileObjectKey(path));
        await input.vault.write(path, bytes);
        input.state.files[path] = syncedState(remote.hash);
        result.downloaded += 1;
      }

      if (action === "conflict" && remote) {
        const bytes = await input.store.readObject(fileObjectKey(path));
        await input.vault.write(createConflictPath(path, input.deviceName, input.now()), bytes);
        input.state.files[path] = {
          lastSyncedHash,
          remoteHash: remote.hash,
          deleted: false,
        };
        result.conflicts += 1;
      }

      if (action === "mark-remote-deleted") {
        manifest.files[path] = {
          hash: lastSyncedHash ?? "",
          size: 0,
          updatedAt: input.now(),
          deleted: true,
        };
        input.state.files[path] = {
          lastSyncedHash,
          remoteHash: lastSyncedHash,
          deleted: true,
        };
        result.deletedRemote += 1;
      }

      if (action === "delete-local" && remote) {
        await input.vault.delete(path);
        input.state.files[path] = {
          lastSyncedHash: remote.hash,
          remoteHash: remote.hash,
          deleted: true,
        };
        result.deletedLocal += 1;
      }
    }

    manifest.updatedAt = input.now();
    input.state.lastSyncAt = input.now();
    await input.store.writeManifest(manifest);
    return result;
  } finally {
    await input.store.releaseLock();
  }
}

function fileObjectKey(path: string): string {
  return `files/${path}`;
}

function syncedState(hash: string): LocalFileState {
  return {
    lastSyncedHash: hash,
    remoteHash: hash,
    deleted: false,
  };
}

async function scanLocalFiles(vault: VaultIO): Promise<Record<string, { bytes: Uint8Array; hash: string }>> {
  const files = await vault.scan();
  const result: Record<string, { bytes: Uint8Array; hash: string }> = {};

  for (const file of files) {
    result[file.path] = {
      bytes: file.bytes,
      hash: await sha256Hex(file.bytes),
    };
  }

  return result;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function createConflictPath(path: string, deviceName: string, timestamp: number): string {
  const suffix = `conflict.${sanitizePathPart(deviceName)}.${formatTimestamp(timestamp)}`;
  const dotIndex = path.lastIndexOf(".");

  if (dotIndex <= path.lastIndexOf("/")) {
    return `${path}.${suffix}`;
  }

  return `${path.slice(0, dotIndex)}.${suffix}${path.slice(dotIndex)}`;
}

function sanitizePathPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || "device";
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  const second = pad2(date.getSeconds());
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

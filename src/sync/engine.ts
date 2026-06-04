import { planFileAction } from "./planner";
import type { SyncAction } from "./planner";

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
  localMtime?: number | null;
  localSize?: number | null;
}

export interface LocalSyncState {
  files: Record<string, LocalFileState>;
  lastSyncAt?: number;
}

export interface VaultIO {
  scan(): Promise<Array<{ path: string; mtime: number; size: number; bytes?: Uint8Array }>>;
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
  deleteObject(key: string): Promise<void>;
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

interface PlannedFile {
  path: string;
  action: SyncAction;
  local?: { bytes: Uint8Array; hash: string; mtime: number; size: number };
  remote?: ManifestFileEntry;
  lastSyncedHash: string | null;
}

const SYNC_CONCURRENCY = 4;
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function createEmptyManifest(): RemoteManifest {
  return {
    schemaVersion: 1,
    updatedAt: 0,
    files: {},
  };
}

export async function syncOnce(input: SyncOnceInput): Promise<SyncResult> {
  const result: SyncResult = {
    uploaded: 0,
    downloaded: 0,
    conflicts: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    locked: false,
  };
  const manifest = await input.store.readManifest();
  const localFiles = await scanLocalFiles(input.vault, input.state);
  const plan = createPlan(localFiles, manifest, input.state);
  const actions = plan.filter((item) => item.action !== "noop");
  const expiredTombstones = findExpiredTombstones(manifest, input.now());
  const writesRemote =
    actions.some((item) => item.action === "upload" || item.action === "mark-remote-deleted") || expiredTombstones.length > 0;

  if (actions.length === 0 && expiredTombstones.length === 0) {
    input.state.lastSyncAt = input.now();
    return result;
  }

  let locked = false;

  if (writesRemote) {
    locked = await input.store.acquireLock();
    result.locked = !locked;

    if (!locked) {
      return result;
    }
  }

  try {
    await mapLimit(actions, SYNC_CONCURRENCY, async (item) => {
      if (item.action === "upload" && item.local) {
        await input.store.writeObject(fileObjectKey(item.path), item.local.bytes);
        manifest.files[item.path] = {
          hash: item.local.hash,
          size: item.local.size,
          updatedAt: input.now(),
          deleted: false,
        };
        input.state.files[item.path] = syncedState(item.local.hash, item.local);
        result.uploaded += 1;
      }

      if (item.action === "download" && item.remote) {
        const bytes = await input.store.readObject(fileObjectKey(item.path));
        await input.vault.write(item.path, bytes);
        input.state.files[item.path] = syncedState(item.remote.hash, { size: bytes.byteLength, mtime: null });
        result.downloaded += 1;
      }

      if (item.action === "conflict" && item.remote) {
        const bytes = await input.store.readObject(fileObjectKey(item.path));
        await input.vault.write(createConflictPath(item.path, input.deviceName, input.now()), bytes);
        input.state.files[item.path] = {
          lastSyncedHash: item.lastSyncedHash,
          remoteHash: item.remote.hash,
          deleted: false,
          localMtime: item.local?.mtime ?? null,
          localSize: item.local?.size ?? null,
        };
        result.conflicts += 1;
      }

      if (item.action === "mark-remote-deleted") {
        await input.store.deleteObject(fileObjectKey(item.path));
        manifest.files[item.path] = {
          hash: item.lastSyncedHash ?? "",
          size: 0,
          updatedAt: input.now(),
          deleted: true,
        };
        input.state.files[item.path] = {
          lastSyncedHash: item.lastSyncedHash,
          remoteHash: item.lastSyncedHash,
          deleted: true,
          localMtime: null,
          localSize: null,
        };
        result.deletedRemote += 1;
      }

      if (item.action === "delete-local" && item.remote) {
        await input.vault.delete(item.path);
        input.state.files[item.path] = {
          lastSyncedHash: item.remote.hash,
          remoteHash: item.remote.hash,
          deleted: true,
          localMtime: null,
          localSize: null,
        };
        result.deletedLocal += 1;
      }
    });

    pruneTombstones(manifest, input.state, expiredTombstones);
    input.state.lastSyncAt = input.now();

    if (writesRemote) {
      manifest.updatedAt = input.now();
      await input.store.writeManifest(manifest);
    }

    return result;
  } finally {
    if (locked) {
      await input.store.releaseLock();
    }
  }
}

function findExpiredTombstones(manifest: RemoteManifest, now: number): string[] {
  return Object.entries(manifest.files)
    .filter(([, entry]) => entry.deleted && now - entry.updatedAt >= TOMBSTONE_RETENTION_MS)
    .map(([path]) => path);
}

function pruneTombstones(manifest: RemoteManifest, state: LocalSyncState, paths: string[]): void {
  for (const path of paths) {
    delete manifest.files[path];
    delete state.files[path];
  }
}

function createPlan(
  localFiles: Record<string, { bytes: Uint8Array; hash: string; mtime: number; size: number }>,
  manifest: RemoteManifest,
  state: LocalSyncState,
): PlannedFile[] {
  const paths = new Set([...Object.keys(localFiles), ...Object.keys(manifest.files), ...Object.keys(state.files)]);
  const plan: PlannedFile[] = [];

  for (const path of paths) {
    const local = localFiles[path];
    const remote = manifest.files[path];
    const previous = state.files[path];
    const lastSyncedHash = previous?.lastSyncedHash ?? null;

    plan.push({
      path,
      local,
      remote,
      lastSyncedHash,
      action: planFileAction({
        localHash: local?.hash ?? null,
        lastSyncedHash,
        remoteHash: remote?.hash ?? null,
        localDeleted: Boolean(previous) && !local,
        remoteDeleted: remote?.deleted ?? false,
      }),
    });
  }

  return plan;
}

function fileObjectKey(path: string): string {
  return `files/${path}`;
}

function syncedState(hash: string, local: { mtime: number | null; size: number | null }): LocalFileState {
  return {
    lastSyncedHash: hash,
    remoteHash: hash,
    deleted: false,
    localMtime: local.mtime,
    localSize: local.size,
  };
}

async function scanLocalFiles(
  vault: VaultIO,
  state: LocalSyncState,
): Promise<Record<string, { bytes: Uint8Array; hash: string; mtime: number; size: number }>> {
  const files = await vault.scan();
  const result: Record<string, { bytes: Uint8Array; hash: string; mtime: number; size: number }> = {};

  for (const file of files) {
    const previous = state.files[file.path];
    const canReuseHash = Boolean(
      previous?.lastSyncedHash &&
        previous.localMtime === file.mtime &&
        previous.localSize === file.size &&
        !previous.deleted,
    );
    const bytes = canReuseHash ? new Uint8Array() : file.bytes ?? (await vault.read(file.path));

    result[file.path] = {
      bytes,
      hash: canReuseHash ? previous!.lastSyncedHash! : await sha256Hex(bytes),
      mtime: file.mtime,
      size: file.size,
    };
  }

  return result;
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  });

  await Promise.all(workers);
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

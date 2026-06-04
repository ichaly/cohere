export interface ManifestFileEntry {
  contentHash: string;
  size: number;
  updatedAt: number;
  updatedBy: string;
  revision: number;
  version: string;
}

export interface DeletedPathEntry {
  deletedAt: number;
  deletedRevision: number;
  previousContentHash: string | null;
  previousVersion: string | null;
  deletedBy: string;
}

export interface BlobEntry {
  key: string;
  size: number;
  createdAt: number;
}

export interface RemoteManifest {
  schemaVersion: 2;
  revision: number;
  updatedAt: number;
  paths: Record<string, ManifestFileEntry>;
  deleted: Record<string, DeletedPathEntry>;
  blobs: Record<string, BlobEntry>;
  devices: Record<string, { name: string; lastSeenAt: number; lastSeenRevision: number }>;
}

export interface LocalFileState {
  lastSyncedHash: string | null;
  remoteHash: string | null;
  deleted: boolean;
  version?: string | null;
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
  listObjectKeys?(prefix: string): Promise<string[]>;
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
  deviceId: string;
  now(): number;
}

interface PlannedFile {
  path: string;
  action: SyncAction;
  local?: { bytes: Uint8Array; hash: string; mtime: number; size: number };
  remote?: ManifestFileEntry;
  deleted?: DeletedPathEntry;
  lastSyncedHash: string | null;
  lastVersion: string | null;
}

type SyncAction = "noop" | "upload" | "download" | "conflict" | "mark-remote-deleted" | "delete-local";

const SYNC_CONCURRENCY = 4;
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function createEmptyManifest(): RemoteManifest {
  return {
    schemaVersion: 2,
    revision: 0,
    updatedAt: 0,
    paths: {},
    deleted: {},
    blobs: {},
    devices: {},
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
  const manifest = normalizeManifest(await input.store.readManifest());
  const localFiles = await scanLocalFiles(input.vault, input.state);
  const plan = createPlan(localFiles, manifest, input.state);
  const actions = plan.filter((item) => item.action !== "noop");
  const expiredTombstones = findExpiredTombstones(manifest, input.now());
  const writesRemote =
    actions.some((item) => item.action === "upload" || item.action === "mark-remote-deleted") || expiredTombstones.length > 0;

  if (actions.length === 0 && expiredTombstones.length === 0) {
    updateDeviceCheckpoint(manifest, input);
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
        await writeBlob(input.store, manifest, item.local.hash, item.local.bytes, item.local.size, input.now());
        manifest.paths[item.path] = {
          contentHash: item.local.hash,
          size: item.local.size,
          updatedAt: input.now(),
          updatedBy: input.deviceId,
          revision: nextRevision(manifest),
          version: createVersion(input.deviceId, input.now(), item.local.hash),
        };
        input.state.files[item.path] = syncedState(item.local.hash, item.local, manifest.paths[item.path].version);
        result.uploaded += 1;
      }

      if (item.action === "download" && item.remote) {
        const bytes = await input.store.readObject(blobObjectKey(item.remote.contentHash));
        await input.vault.write(item.path, bytes);
        input.state.files[item.path] = syncedState(item.remote.contentHash, { size: bytes.byteLength, mtime: null }, item.remote.version);
        result.downloaded += 1;
      }

      if (item.action === "conflict" && item.remote) {
        const bytes = await input.store.readObject(blobObjectKey(item.remote.contentHash));
        await input.vault.write(createConflictPath(item.path, input.deviceName, input.now()), bytes);
        input.state.files[item.path] = {
          lastSyncedHash: item.lastSyncedHash,
          remoteHash: item.remote.contentHash,
          deleted: false,
          version: item.remote.version,
          localMtime: null,
          localSize: null,
        };
        result.conflicts += 1;
      }

      if (item.action === "conflict" && item.deleted && item.local && !item.remote) {
        await input.vault.write(createConflictPath(item.path, input.deviceName, input.now()), item.local.bytes);
        await input.vault.delete(item.path);
        input.state.files[item.path] = {
          lastSyncedHash: item.deleted.previousContentHash,
          remoteHash: item.deleted.previousContentHash,
          deleted: true,
          version: item.deleted.previousVersion,
          localMtime: null,
          localSize: null,
        };
        result.conflicts += 1;
        result.deletedLocal += 1;
      }

      if (item.action === "mark-remote-deleted") {
        const remote = manifest.paths[item.path];
        delete manifest.paths[item.path];
        manifest.deleted[item.path] = {
          deletedAt: input.now(),
          deletedRevision: nextRevision(manifest),
          previousContentHash: item.lastSyncedHash ?? remote?.contentHash ?? null,
          previousVersion: item.lastVersion ?? remote?.version ?? null,
          deletedBy: input.deviceId,
        };
        input.state.files[item.path] = {
          lastSyncedHash: item.lastSyncedHash ?? remote?.contentHash ?? null,
          remoteHash: item.lastSyncedHash ?? remote?.contentHash ?? null,
          deleted: true,
          version: item.lastVersion ?? remote?.version ?? null,
          localMtime: null,
          localSize: null,
        };
        result.deletedRemote += 1;
      }

      if (item.action === "delete-local" && item.remote) {
        await input.vault.delete(item.path);
        input.state.files[item.path] = {
          lastSyncedHash: item.remote.contentHash,
          remoteHash: item.remote.contentHash,
          deleted: true,
          version: item.remote.version,
          localMtime: null,
          localSize: null,
        };
        result.deletedLocal += 1;
      }

      if (item.action === "delete-local" && item.deleted) {
        await input.vault.delete(item.path);
        input.state.files[item.path] = {
          lastSyncedHash: item.deleted.previousContentHash,
          remoteHash: item.deleted.previousContentHash,
          deleted: true,
          version: item.deleted.previousVersion,
          localMtime: null,
          localSize: null,
        };
        result.deletedLocal += 1;
      }
    });

    pruneTombstones(manifest, input.state, expiredTombstones);
    updateDeviceCheckpoint(manifest, input);
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

export interface ReleaseDeletedContentResult {
  deletedTombstones: number;
  deletedBlobs: number;
  locked: boolean;
}

export async function releaseDeletedContent(input: { store: ObjectStore; now(): number }): Promise<ReleaseDeletedContentResult> {
  const locked = await input.store.acquireLock();

  if (!locked) {
    return { deletedTombstones: 0, deletedBlobs: 0, locked: true };
  }

  try {
    const manifest = normalizeManifest(await input.store.readManifest());
    const deletedTombstones = Object.keys(manifest.deleted).length;

    manifest.deleted = {};
    const referencedHashes = new Set(Object.values(manifest.paths).map((entry) => entry.contentHash));
    const knownBlobKeys = new Set(Object.values(manifest.blobs).map((entry) => entry.key));
    const listedBlobKeys = input.store.listObjectKeys ? await input.store.listObjectKeys("blobs/sha256/") : [];
    let deletedBlobs = 0;

    for (const key of new Set([...knownBlobKeys, ...listedBlobKeys])) {
      const hash = hashFromBlobKey(key);

      if (hash && !referencedHashes.has(hash)) {
        await input.store.deleteObject(key);
        delete manifest.blobs[hash];
        deletedBlobs += 1;
      }
    }

    manifest.revision += 1;
    manifest.updatedAt = input.now();
    await input.store.writeManifest(manifest);

    return { deletedTombstones, deletedBlobs, locked: false };
  } finally {
    await input.store.releaseLock();
  }
}

function findExpiredTombstones(manifest: RemoteManifest, now: number): string[] {
  return Object.entries(manifest.deleted)
    .filter(([, entry]) => now - entry.deletedAt >= TOMBSTONE_RETENTION_MS)
    .map(([path]) => path);
}

function pruneTombstones(manifest: RemoteManifest, state: LocalSyncState, paths: string[]): void {
  for (const path of paths) {
    delete manifest.deleted[path];

    if (state.files[path]?.deleted) {
      delete state.files[path];
    }
  }
}

function createPlan(
  localFiles: Record<string, { bytes: Uint8Array; hash: string; mtime: number; size: number }>,
  manifest: RemoteManifest,
  state: LocalSyncState,
): PlannedFile[] {
  const paths = new Set([...Object.keys(localFiles), ...Object.keys(manifest.paths), ...Object.keys(manifest.deleted), ...Object.keys(state.files)]);
  const plan: PlannedFile[] = [];

  for (const path of paths) {
    const local = localFiles[path];
    const remote = manifest.paths[path];
    const deleted = manifest.deleted[path];
    const previous = state.files[path];
    const lastSyncedHash = previous?.lastSyncedHash ?? null;
    const lastVersion = previous?.version ?? null;
    const action = planPathAction({ local, remote, deleted, previous });

    plan.push({
      path,
      local,
      remote,
      deleted,
      lastSyncedHash,
      lastVersion,
      action,
    });
  }

  return plan;
}

function planPathAction(input: {
  local?: { bytes: Uint8Array; hash: string; mtime: number; size: number };
  remote?: ManifestFileEntry;
  deleted?: DeletedPathEntry;
  previous?: LocalFileState;
}): SyncAction {
  if (!input.local) {
    if (input.previous && !input.previous.deleted) {
      return "mark-remote-deleted";
    }

    if (input.remote) {
      return "download";
    }

    return "noop";
  }

  if (input.remote) {
    const localChanged = !input.previous || input.previous.deleted || input.local.hash !== input.previous.lastSyncedHash;
    const remoteChanged = input.remote.version !== input.previous?.version || input.remote.contentHash !== input.previous?.remoteHash;

    if (!localChanged && !remoteChanged) {
      return "noop";
    }

    if (localChanged && !remoteChanged) {
      return "upload";
    }

    if (!localChanged && remoteChanged) {
      return "download";
    }

    return "conflict";
  }

  if (input.deleted) {
    if (input.previous?.deleted) {
      return "upload";
    }

    return input.previous && input.local.hash === input.previous.lastSyncedHash ? "delete-local" : "conflict";
  }

  return "upload";
}

export function blobObjectKey(hash: string): string {
  return `blobs/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}

function syncedState(hash: string, local: { mtime: number | null; size: number | null }, version: string): LocalFileState {
  return {
    lastSyncedHash: hash,
    remoteHash: hash,
    deleted: false,
    version,
    localMtime: local.mtime,
    localSize: local.size,
  };
}

async function writeBlob(store: ObjectStore, manifest: RemoteManifest, hash: string, bytes: Uint8Array, size: number, now: number): Promise<void> {
  const key = blobObjectKey(hash);

  await store.writeObject(key, bytes);
  manifest.blobs[hash] = {
    key,
    size,
    createdAt: manifest.blobs[hash]?.createdAt ?? now,
  };
}

function nextRevision(manifest: RemoteManifest): number {
  manifest.revision += 1;
  return manifest.revision;
}

function createVersion(deviceId: string, now: number, hash: string): string {
  return `ver_${now}_${deviceId}_${hash.slice(0, 12)}`;
}

function updateDeviceCheckpoint(manifest: RemoteManifest, input: SyncOnceInput): void {
  manifest.devices[input.deviceId] = {
    name: input.deviceName,
    lastSeenAt: input.now(),
    lastSeenRevision: manifest.revision,
  };
}

function normalizeManifest(manifest: RemoteManifest): RemoteManifest {
  if (manifest.schemaVersion === 2) {
    manifest.paths ??= {};
    manifest.deleted ??= {};
    manifest.blobs ??= {};
    manifest.devices ??= {};
    manifest.revision ??= 0;
    return manifest;
  }

  return createEmptyManifest();
}

function hashFromBlobKey(key: string): string | null {
  const match = key.match(/blobs\/sha256\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{64})$/);
  return match?.[1] ?? null;
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

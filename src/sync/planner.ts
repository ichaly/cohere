export type SyncAction = "noop" | "upload" | "download" | "conflict" | "mark-remote-deleted" | "delete-local";

interface PlanFileActionInput {
  localHash: string | null;
  lastSyncedHash: string | null;
  remoteHash: string | null;
  localDeleted: boolean;
  remoteDeleted: boolean;
}

export function planFileAction(input: PlanFileActionInput): SyncAction {
  const localChanged = input.localDeleted || input.localHash !== input.lastSyncedHash;
  const remoteChanged = input.remoteDeleted || input.remoteHash !== input.lastSyncedHash;

  if (!localChanged && !remoteChanged) {
    return "noop";
  }

  if (localChanged && !remoteChanged) {
    return input.localDeleted ? "mark-remote-deleted" : "upload";
  }

  if (!localChanged && remoteChanged) {
    return input.remoteDeleted ? "delete-local" : "download";
  }

  return "conflict";
}


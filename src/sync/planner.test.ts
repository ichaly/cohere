import { describe, expect, test } from "vitest";
import { planFileAction } from "./planner";

describe("sync planner", () => {
  test("uploads when local changed and remote stayed at the last synced hash", () => {
    expect(
      planFileAction({
        localHash: "local-new",
        lastSyncedHash: "base",
        remoteHash: "base",
        localDeleted: false,
        remoteDeleted: false,
      }),
    ).toBe("upload");
  });

  test("downloads when remote changed and local stayed at the last synced hash", () => {
    expect(
      planFileAction({
        localHash: "base",
        lastSyncedHash: "base",
        remoteHash: "remote-new",
        localDeleted: false,
        remoteDeleted: false,
      }),
    ).toBe("download");
  });

  test("creates a conflict when local and remote changed from the last synced hash", () => {
    expect(
      planFileAction({
        localHash: "local-new",
        lastSyncedHash: "base",
        remoteHash: "remote-new",
        localDeleted: false,
        remoteDeleted: false,
      }),
    ).toBe("conflict");
  });

  test("marks remote deleted when local deletion is the only change", () => {
    expect(
      planFileAction({
        localHash: null,
        lastSyncedHash: "base",
        remoteHash: "base",
        localDeleted: true,
        remoteDeleted: false,
      }),
    ).toBe("mark-remote-deleted");
  });
});


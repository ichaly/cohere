import { describe, expect, test } from "vitest";
import { createRemoteLayout } from "./paths";

describe("remote layout", () => {
  test("builds normalized object keys under a vault prefix", () => {
    const layout = createRemoteLayout({
      rootPrefix: "/obsync/v1/",
      vaultId: "vlt_TEST",
    });

    expect(layout.manifestKey).toBe("obsync/v1/vaults/vlt_TEST/manifest.json");
    expect(layout.fileKey("notes/today.md")).toBe("obsync/v1/vaults/vlt_TEST/files/notes/today.md");
    expect(layout.fileKey("/attachments/image.png")).toBe("obsync/v1/vaults/vlt_TEST/files/attachments/image.png");
    expect(layout.lockKey).toBe("obsync/v1/vaults/vlt_TEST/locks/sync.lock");
  });
});


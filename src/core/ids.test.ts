import { describe, expect, test } from "vitest";
import { createVaultId, normalizeKey } from "./ids";

describe("vault identity", () => {
  test("normalizes user-facing keys into stable lowercase slugs", () => {
    expect(normalizeKey(" Personal Notes ")).toBe("personal-notes");
    expect(normalizeKey("默认 仓库")).toBe("default");
  });

  test("creates the same vault id for equivalent account and vault keys", async () => {
    const first = await createVaultId("Default", "Personal Notes");
    const second = await createVaultId("default", "personal-notes");

    expect(first).toBe(second);
    expect(first).toMatch(/^vlt_[A-Z2-7]{26}$/);
  });
});


import { type App, TFile, TFolder } from "obsidian";
import type { VaultIO } from "./sync/engine";

export class ObsidianVaultIO implements VaultIO {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  async scan(): Promise<Array<{ path: string; mtime: number; size: number }>> {
    const files = this.app.vault.getFiles();
    const result: Array<{ path: string; mtime: number; size: number }> = [];

    for (const file of files) {
      result.push({
        path: file.path,
        mtime: file.stat.mtime,
        size: file.stat.size,
      });
    }

    return result;
  }

  async read(path: string): Promise<Uint8Array> {
    const file = this.app.vault.getAbstractFileByPath(path);

    if (!(file instanceof TFile)) {
      return new Uint8Array();
    }

    return new Uint8Array(await this.app.vault.readBinary(file));
  }

  async scanEmptyDirectories(): Promise<string[]> {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .filter((folder) => folder.path && !this.isIgnoredVaultPath(folder.path) && folder.children.length === 0)
      .map((folder) => folder.path);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    await this.ensureParentFolder(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    const data = toArrayBuffer(bytes);

    if (file instanceof TFile) {
      await this.app.vault.modifyBinary(file, data);
      return;
    }

    await this.app.vault.createBinary(path, data);
  }

  async delete(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);

    if (file instanceof TFile) {
      await this.app.fileManager.trashFile(file);
    }
  }

  async createDirectory(path: string): Promise<void> {
    let current = "";

    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      await this.ensureFolderExists(current);
    }
  }

  async deleteDirectory(path: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(path);

    if (folder instanceof TFolder && folder.children.length === 0) {
      await this.app.fileManager.trashFile(folder);
    }
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      await this.ensureFolderExists(current);
    }
  }

  private async ensureFolderExists(path: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);

    if (existing instanceof TFolder) {
      return;
    }

    if (existing instanceof TFile) {
      throw new Error(`Path exists as a file: ${path}`);
    }

    if (await this.app.vault.adapter.exists(path)) {
      return;
    }

    try {
      await this.app.vault.createFolder(path);
    } catch (error) {
      if (await this.app.vault.adapter.exists(path)) {
        return;
      }

      throw error;
    }
  }

  private isIgnoredVaultPath(path: string): boolean {
    const configDir = this.app.vault.configDir;
    return path === configDir || path.startsWith(`${configDir}/`) || path === ".trash" || path.startsWith(".trash/");
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

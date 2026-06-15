import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const vaultPath = process.argv[2];

if (!vaultPath) {
  console.error("Usage: pnpm install-plugin <vault-path>");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pluginDir = join(resolve(vaultPath), ".obsidian", "plugins", manifest.id);
mkdirSync(pluginDir, { recursive: true });

copyFileSync("manifest.json", join(pluginDir, "manifest.json"));
copyFileSync("dist/main.js", join(pluginDir, "main.js"));
copyFileSync("dist/main.css", join(pluginDir, "styles.css"));

console.log(`Installed ${manifest.name} to ${pluginDir}`);

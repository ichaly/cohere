import { existsSync, readFileSync } from "node:fs";

const packageJson = readJson("package.json");
const manifest = readJson("manifest.json");
const versions = readJson("versions.json");
const tag = process.env.GITHUB_REF_NAME ?? "";
const normalizedTag = tag.startsWith("v") ? tag.slice(1) : tag;

if (packageJson.version !== manifest.version) {
  fail(`package.json version ${packageJson.version} does not match manifest.json version ${manifest.version}`);
}

if (!versions[manifest.version]) {
  fail(`versions.json does not contain ${manifest.version}`);
}

if (normalizedTag && normalizedTag !== manifest.version) {
  fail(`Git tag ${tag} does not match manifest.json version ${manifest.version}`);
}

for (const path of ["manifest.json", "dist/main.js", "dist/main.css"]) {
  if (!existsSync(path)) {
    fail(`Missing release file: ${path}`);
  }
}

console.log(`Release files validated for ${manifest.version}`);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}


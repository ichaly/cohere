# Obsync

Obsync is an Obsidian plugin for syncing vault files through OSS / S3-compatible object storage.

The current repository is initialized with the plugin scaffold and MVP design document. The first implementation target is a simple `manifest.json` + `files/<path>` sync model described in [docs/obsidian-oss-sync-mvp.md](docs/obsidian-oss-sync-mvp.md).

## Development

```bash
npm install
npm run build
```

The build uses Vite, Vue, and Tailwind CSS. It writes the Obsidian plugin bundle to `main.js` and settings styles to `styles.css`.

## Plugin ID

```text
obsync
```

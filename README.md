# Obsync

Obsync 是一个 Obsidian 同步插件，目标是通过 OSS / S3 兼容对象存储在多端同步 vault 文件。

当前仓库已经完成插件基础骨架和 MVP 设计文档。第一阶段实现目标是一个简单可靠的同步模型：

```text
manifest.json + files/<path> + locks/sync.lock
```

详细方案见：[docs/obsidian-oss-sync-mvp.md](docs/obsidian-oss-sync-mvp.md)

## 开发

```bash
pnpm install
pnpm run build
```

构建栈：

```text
Vite 8
Vue 3
Tailwind CSS 4
SCSS
TypeScript 6
pnpm
```

构建产物：

```text
main.js
styles.css
```

## 插件 ID

```text
obsync
```


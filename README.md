# Obsync

Obsync 是一个 Obsidian 同步插件，目标是通过 OSS / S3 兼容对象存储在多端同步 vault 文件。

当前仓库已经完成插件基础骨架和 MVP 设计文档。第一阶段实现目标是一个简单可靠的同步模型：

```text
manifest.json + files/<path> + locks/sync.lock
```

当前已实现：

```text
vaultId / deviceId 生成
连接配置复制
本地文件扫描
manifest 冲突判断
S3-compatible SigV4 对象存储 adapter
手动同步命令
```

详细方案见：[docs/obsidian-oss-sync-mvp.md](docs/obsidian-oss-sync-mvp.md)

## 开发

```bash
pnpm install
pnpm test
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
dist/main.js
dist/main.css
```

安装到 Obsidian 时，需要复制：

```text
manifest.json
dist/main.js
dist/main.css
```

到目标 vault 的插件目录，并把 `dist/main.css` 放置为 Obsidian 识别的 `styles.css`：

```text
<vault>/.obsidian/plugins/obsync/
  manifest.json
  main.js
  styles.css
```

也可以使用安装脚本：

```bash
pnpm run build
pnpm install-plugin "/path/to/your-vault"
```

## 插件 ID

```text
obsync
```

## 发布

推送版本 tag 会触发 GitHub Actions 自动发布：

```bash
git tag v0.1.0
git push origin v0.1.0
```

Release 会上传：

```text
manifest.json
main.js
styles.css
```

发布前可以本地检查：

```bash
pnpm run build
pnpm run release:check
```

# Obsidian OSS 同步插件 MVP 设计

## 1. 目标

开发一个 Obsidian 插件，以 OSS / S3 兼容对象存储作为核心后端，在 iOS、Android、macOS、Windows 多端之间同步 Obsidian vault。

MVP 目标是把文件级同步闭环做简单、可靠、可调试。不追求多人字符级实时协作，也不引入 Git、oplog、snapshot 等复杂机制。

## 2. 核心假设

- 后端使用 OSS / S3 兼容对象存储，例如阿里云 OSS、AWS S3、MinIO、Cloudflare R2、Backblaze B2。
- 插件需要支持 Obsidian 桌面端和移动端。
- iOS / Android 不能被当成可靠的后台常驻同步进程。
- 第一阶段以个人或小规模多设备同步为主。
- 同步正确性优先于极限性能。

## 3. MVP 范围

第一阶段支持：

- 创建或加入一个远端 vault 同步空间。
- 一个 bucket 内隔离多个 vault。
- 同步 Markdown 文件和附件。
- 本地修改后自动上传。
- 启动、恢复前台、定时、手动触发时拉取远端变化。
- 多端同时修改同一文件时生成冲突副本，避免静默覆盖。
- 复制或导入连接配置，让多台设备使用同一个 `vaultId`。

第一阶段不做：

- 字符级实时协作。
- 完整 Git 同步。
- 移动端 App 关闭后的后台同步。
- 端到端加密。
- Markdown 三方自动合并。
- 内容寻址 blob。
- per-device oplog。
- snapshot / compaction。
- blob 垃圾回收。
- 团队权限系统。

## 4. ID 设计

### 4.1 vaultId

`vaultId` 标识一个远端同步 vault。它需要在多台设备上相同，并且不同 vault 之间不同。

MVP 使用稳定可计算方案：

```text
accountKey = normalize(user input, default: "default")
vaultKey = normalize(user input, default: normalize(app.vault.getName()))

vaultId = "vlt_" + base32url(
  sha256("cohere-vault-v1:" + accountKey + ":" + vaultKey)
).slice(0, 26)
```

规则：

- `accountKey` 用于区分用户、团队或环境。
- 个人用户可以默认使用 `default`。
- `vaultKey` 用于标识一个 vault，默认可从 Obsidian vault 名称生成。
- `vaultKey` 需要用户确认并保存，保存后不跟随 vault 显示名自动变化。
- 同一个远端 vault 的所有设备必须使用相同的 `accountKey + vaultKey`。
- 不要用设备名、系统版本、本地路径、Obsidian 的本机 Vault ID 生成 `accountKey`。

示例：

```json
{
  "accountKey": "default",
  "vaultKey": "personal-notes",
  "vaultId": "vlt_7K4N9J2Q8X5M3P1A"
}
```

### 4.2 deviceId

`deviceId` 只标识当前客户端安装，用于本地状态、锁 owner 和冲突文件名。它不参与 `vaultId` 计算。

MVP 使用随机生成方案：

```text
deviceId = "dev_" + base32url(randomBytes(16)).slice(0, 26)
```

规则：

- 首次启用插件时生成。
- 保存在本地插件配置中。
- 卸载重装后生成新的 `deviceId` 可以接受。
- 不使用 MAC 地址、IMEI、设备序列号、系统用户名等硬件或系统标识。
- `deviceName` 可以从设备名自动读取，用户可编辑，只用于 UI 展示。

示例：

```json
{
  "deviceId": "dev_A1B2C3D4E5F6",
  "deviceName": "Chaly iPhone"
}
```

## 5. 多设备加入方式

为了让两台设备使用同一个 `vaultId`，第一台设备应提供“复制连接配置”，第二台设备导入这份配置。

连接配置包含：

```json
{
  "schemaVersion": 1,
  "endpoint": "https://oss-cn-example.aliyuncs.com",
  "bucket": "my-obsidian-sync",
  "rootPrefix": "cohere/v1",
  "accountKey": "default",
  "vaultKey": "personal-notes",
  "vaultId": "vlt_7K4N9J2Q8X5M3P1A"
}
```

规则：

- 默认不导出 `accessKeyId` / `accessKeySecret`。
- 第二台设备导入连接配置后，单独填写 OSS 凭证。
- 导入时重新计算 `vaultId`，并校验它与配置中的 `vaultId` 一致。
- 后续可以把连接配置做成二维码；MVP 先支持复制 JSON。

## 6. OSS 存储结构

使用一个 bucket 和可配置的 `rootPrefix`。多个 vault 通过 `vaults/<vaultId>/` 隔离。

```text
oss://<bucket>/<rootPrefix>/vaults/<vaultId>/
```

默认 `rootPrefix`：

```text
cohere/v1
```

完整结构：

```text
cohere/
  v1/
    vaults/
      <vaultId>/
        meta/
          vault.json
        manifest.json
        files/
          notes/today.md
          attachments/image.png
        locks/
          sync.lock
```

说明：

- `manifest.json` 是远端当前文件索引。
- `files/` 按 vault 内相对路径保存文件内容。
- `locks/sync.lock` 是短租约同步锁。
- MVP 不使用 `blobs/`、`devices/`、`snapshots/`。

远端 vault 元信息：

```json
{
  "schemaVersion": 1,
  "vaultId": "vlt_7K4N9J2Q8X5M3P1A",
  "nameHint": "Personal Notes",
  "createdAt": 1780000000000
}
```

## 7. manifest.json

`manifest.json` 记录远端每个文件的当前状态。

MVP 字段：

```json
{
  "schemaVersion": 1,
  "updatedAt": 1780000000000,
  "files": {
    "notes/today.md": {
      "hash": "abc123",
      "size": 2048,
      "updatedAt": 1780000000000,
      "deleted": false
    },
    "notes/old.md": {
      "hash": "def456",
      "size": 1024,
      "updatedAt": 1780000000000,
      "deleted": true
    }
  }
}
```

说明：

- `hash` 是文件内容 hash，用于判断变化和冲突。
- `size` 用于展示和快速检查。
- `updatedAt` 用于展示和排序，不作为唯一冲突依据。
- `deleted` 表示删除标记。
- MVP 不需要 `updatedBy`。

## 8. 本地状态

MVP 可以使用 Obsidian 插件数据文件或 IndexedDB 保存本地状态。

最小状态：

```text
endpoint
bucket
rootPrefix
accountKey
vaultKey
vaultId
deviceId
deviceName
lastSyncAt

每个文件：
  path
  localHash
  lastSyncedHash
  remoteHash
  deleted
```

关键字段：

- `localHash`：当前本地文件 hash。
- `lastSyncedHash`：上次成功同步时本地和远端一致的 hash。
- `remoteHash`：最近一次从 manifest 看到的远端 hash。

冲突判断依赖 `lastSyncedHash` 和远端 `hash`，不要只依赖 mtime。

## 9. 同步锁

MVP 使用一个短租约锁降低并发写 `manifest.json` 的复杂度。

锁路径：

```text
locks/sync.lock
```

锁内容：

```json
{
  "owner": "dev_A1B2C3D4E5F6",
  "expiresAt": 1780000030000
}
```

规则：

- 同步前尝试获取锁。
- 锁过期时间建议 30 秒。
- 拿不到锁时跳过本轮自动同步，或提示用户稍后重试。
- 发现过期锁可以覆盖。
- 客户端崩溃后最多等待锁过期，不会永久阻塞。

## 10. 同步流程

### 10.1 手动或自动同步

```text
1. 获取 sync.lock。
2. 下载 manifest.json；如果不存在则创建空 manifest。
3. 扫描本地文件，计算 hash。
4. 对比本地状态和远端 manifest。
5. 上传本地新增或修改文件到 files/<path>。
6. 下载远端新增或修改文件到本地 vault。
7. 处理删除。
8. 遇到冲突时生成 conflict 副本。
9. 写回 manifest.json。
10. 更新本地状态。
11. 释放 sync.lock。
```

### 10.2 本地上传

当本地文件变化且远端没有从 `lastSyncedHash` 之后发生变化：

```text
上传 files/<path>
更新 manifest.files[path].hash
更新 manifest.files[path].size
更新 manifest.files[path].updatedAt
更新本地 lastSyncedHash
```

### 10.3 远端下载

当本地未变化且远端 hash 变化：

```text
下载 files/<path>
写入本地 vault
更新本地 lastSyncedHash
```

### 10.4 删除

本地删除且远端未变化：

```text
保留 files/<path> 对象
manifest.files[path].deleted = true
```

远端删除且本地未变化：

```text
删除本地文件，或移动到本地回收站
更新本地状态
```

MVP 删除只更新 manifest 中的 `deleted = true`，不物理删除远端对象，减少误删风险。远端对象清理放到后续版本。

## 11. 冲突处理

核心判断：

```text
本地 hash == lastSyncedHash
远端 hash != lastSyncedHash
  本地未改，远端已改，下载远端

本地 hash != lastSyncedHash
远端 hash == lastSyncedHash
  本地已改，远端未改，上传本地

本地 hash != lastSyncedHash
远端 hash != lastSyncedHash
  本地和远端都改，生成冲突副本
```

冲突策略：

```text
保留本地当前文件
把远端版本下载为 conflict 副本
不自动合并
```

冲突文件命名：

```text
notes/today.conflict.Chaly-iPhone.20260604-153000.md
```

如果无法得到设备名，使用 `deviceId`：

```text
notes/today.conflict.dev_A1B2C3D4.20260604-153000.md
```

Markdown 三方合并放到后续阶段。

## 12. 同步触发

MVP 触发时机：

- Obsidian 启动。
- App 恢复前台。
- 文件保存或修改后 debounce 1-5 秒。
- 前台定时同步。
- 用户点击手动同步。

移动端不承诺 App 关闭后的后台同步。

## 13. 插件设置

MVP 设置项：

```text
endpoint
bucket
region
rootPrefix
accessKeyId
accessKeySecret 或 token
accountKey
vaultKey
computed vaultId
deviceName
deviceId
sync interval
enable auto sync
copy connection config
import connection config
manual sync button
last sync status
last sync time
```

状态值：

```text
Idle
Syncing
Uploading
Downloading
Conflict
Locked
Error
```

后续版本应支持临时凭证、STS 或 token broker，减少长期 AK/SK 暴露风险。

## 14. 成功标准

MVP 达成标准：

- macOS 修改 Markdown 文件后，iOS 同步后能看到。
- iOS 修改 Markdown 文件后，Windows 同步后能看到。
- 附件能跨设备同步。
- 两台设备同时修改同一文件时不会丢数据，会生成 conflict 副本。
- 断网编辑后，网络恢复时能继续上传本地变更。
- 两台设备通过导入同一份连接配置使用同一个 `vaultId`。
- 多个 vault 能共用一个 bucket，且数据不会混在一起。

## 15. 推荐实现顺序

```text
1. 设置页和 ID 计算
2. 复制 / 导入连接配置
3. OSS adapter
4. 本地状态存储
5. 文件扫描和 hash 计算
6. manifest.json 读取和写入
7. sync.lock 获取和释放
8. 手动同步
9. 冲突副本
10. 自动同步触发
```

## 16. 后续可演进方向

如果 MVP 跑通后遇到性能或并发瓶颈，再考虑：

- manifest 分片。
- 内容寻址 blob。
- per-device oplog。
- snapshot / compaction。
- Markdown 三方合并。
- 端到端加密。
- Git 备份导出。

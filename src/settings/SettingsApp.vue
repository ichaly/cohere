<script setup lang="ts">
type ObsyncSettings = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  rootPrefix: string;
  accountKey: string;
  vaultKey: string;
  vaultId: string;
  deviceId: string;
  deviceName: string;
  syncIntervalMinutes: number;
  autoSync: boolean;
};

const props = defineProps<{
  settings: ObsyncSettings;
  connectionConfig: Record<string, string | number>;
}>();

const emit = defineEmits<{
  update: [update: Partial<ObsyncSettings>];
  copyVaultId: [];
  copyConnectionConfig: [];
}>();
</script>

<template>
  <main class="obsync-panel">
    <header class="obsync-header">
      <div>
        <p class="obsync-eyebrow">OSS / S3 同步</p>
        <h2 class="obsync-title">Obsync 设置</h2>
        <p class="obsync-subtitle">通过对象存储同步当前 Obsidian 仓库。</p>
      </div>
      <div class="obsync-status">MVP</div>
    </header>

    <section class="obsync-section">
      <div class="obsync-section-copy">
        <h3>对象存储</h3>
        <p>填写 S3 兼容对象存储信息。Cloudflare R2 的 Region 通常填 auto。</p>
      </div>

      <div class="obsync-grid">
        <label class="obsync-field obsync-field-wide">
          <span>服务端点</span>
          <input
            :value="props.settings.endpoint"
            placeholder="https://xxx.r2.cloudflarestorage.com"
            @input="emit('update', { endpoint: ($event.target as HTMLInputElement).value.trim() })"
          />
        </label>

        <label class="obsync-field">
          <span>Bucket</span>
          <input
            :value="props.settings.bucket"
            placeholder="ideabase"
            @input="emit('update', { bucket: ($event.target as HTMLInputElement).value.trim() })"
          />
        </label>

        <label class="obsync-field">
          <span>Region</span>
          <input
            :value="props.settings.region"
            placeholder="auto"
            @input="emit('update', { region: ($event.target as HTMLInputElement).value.trim() })"
          />
        </label>

        <label class="obsync-field">
          <span>根路径</span>
          <input
            :value="props.settings.rootPrefix"
            placeholder="obsync/v1"
            @input="emit('update', { rootPrefix: ($event.target as HTMLInputElement).value.trim() || 'obsync/v1' })"
          />
        </label>

        <label class="obsync-field">
          <span>Access Key ID</span>
          <input
            :value="props.settings.accessKeyId"
            autocomplete="off"
            @input="emit('update', { accessKeyId: ($event.target as HTMLInputElement).value.trim() })"
          />
        </label>

        <label class="obsync-field obsync-field-wide">
          <span>Secret Access Key</span>
          <input
            type="password"
            :value="props.settings.secretAccessKey"
            autocomplete="off"
            @input="emit('update', { secretAccessKey: ($event.target as HTMLInputElement).value })"
          />
        </label>
      </div>
    </section>

    <section class="obsync-section">
      <div class="obsync-section-copy">
        <h3>仓库身份</h3>
        <p>多台设备要使用相同的账号标识和仓库标识，才能同步到同一个远端仓库。</p>
      </div>

      <div class="obsync-grid">
        <label class="obsync-field">
          <span>账号标识</span>
          <input
            :value="props.settings.accountKey"
            @input="emit('update', { accountKey: ($event.target as HTMLInputElement).value })"
          />
        </label>

        <label class="obsync-field">
          <span>仓库标识</span>
          <input
            :value="props.settings.vaultKey"
            @input="emit('update', { vaultKey: ($event.target as HTMLInputElement).value })"
          />
        </label>
      </div>

      <div class="obsync-readonly-row">
        <div>
          <span>Vault ID</span>
          <code>{{ props.settings.vaultId }}</code>
        </div>
        <button type="button" @click="emit('copyVaultId')">复制</button>
      </div>
    </section>

    <section class="obsync-section">
      <div class="obsync-section-copy">
        <h3>当前设备</h3>
        <p>设备 ID 只保存在本地，用于同步锁和冲突文件命名。</p>
      </div>

      <label class="obsync-field">
        <span>设备名称</span>
        <input
          :value="props.settings.deviceName"
          @input="emit('update', { deviceName: ($event.target as HTMLInputElement).value.trim() || 'This device' })"
        />
      </label>

      <div class="obsync-readonly-row">
        <div>
          <span>设备 ID</span>
          <code>{{ props.settings.deviceId }}</code>
        </div>
      </div>

      <label class="obsync-toggle">
        <input
          type="checkbox"
          :checked="props.settings.autoSync"
          @change="emit('update', { autoSync: ($event.target as HTMLInputElement).checked })"
        />
        <span>启用自动同步</span>
      </label>
    </section>

    <section class="obsync-section">
      <div class="obsync-section-copy">
        <h3>连接配置</h3>
        <p>复制这段 JSON 到另一台设备导入。这里不包含 Access Key 和 Secret。</p>
      </div>

      <pre>{{ JSON.stringify(props.connectionConfig, null, 2) }}</pre>

      <button type="button" class="obsync-primary" @click="emit('copyConnectionConfig')">
        复制连接配置
      </button>
    </section>
  </main>
</template>

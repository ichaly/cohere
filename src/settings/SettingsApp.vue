<script setup lang="ts">
type ObsyncSettings = {
  endpoint: string;
  bucket: string;
  region: string;
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
        <p class="obsync-eyebrow">OSS / S3 vault sync</p>
        <h2 class="obsync-title">Obsync</h2>
      </div>
      <div class="obsync-status">MVP scaffold</div>
    </header>

    <section class="obsync-section">
      <div class="obsync-section-copy">
        <h3>Storage</h3>
        <p>Configure the object storage location for this vault.</p>
      </div>

      <label class="obsync-field">
        <span>Endpoint</span>
        <input
          :value="props.settings.endpoint"
          placeholder="https://oss-cn-example.aliyuncs.com"
          @input="emit('update', { endpoint: ($event.target as HTMLInputElement).value.trim() })"
        />
      </label>

      <label class="obsync-field">
        <span>Bucket</span>
        <input
          :value="props.settings.bucket"
          placeholder="my-obsidian-sync"
          @input="emit('update', { bucket: ($event.target as HTMLInputElement).value.trim() })"
        />
      </label>

      <label class="obsync-field">
        <span>Root prefix</span>
        <input
          :value="props.settings.rootPrefix"
          placeholder="obsync/v1"
          @input="emit('update', { rootPrefix: ($event.target as HTMLInputElement).value.trim() || 'obsync/v1' })"
        />
      </label>
    </section>

    <section class="obsync-section">
      <div class="obsync-section-copy">
        <h3>Vault identity</h3>
        <p>Use the same account and vault keys on every device.</p>
      </div>

      <label class="obsync-field">
        <span>Account key</span>
        <input
          :value="props.settings.accountKey"
          @input="emit('update', { accountKey: ($event.target as HTMLInputElement).value })"
        />
      </label>

      <label class="obsync-field">
        <span>Vault key</span>
        <input
          :value="props.settings.vaultKey"
          @input="emit('update', { vaultKey: ($event.target as HTMLInputElement).value })"
        />
      </label>

      <div class="obsync-readonly-row">
        <div>
          <span>Vault ID</span>
          <code>{{ props.settings.vaultId }}</code>
        </div>
        <button type="button" @click="emit('copyVaultId')">Copy</button>
      </div>
    </section>

    <section class="obsync-section">
      <div class="obsync-section-copy">
        <h3>Device</h3>
        <p>Device identity is local and only used for locks and conflict names.</p>
      </div>

      <label class="obsync-field">
        <span>Device name</span>
        <input
          :value="props.settings.deviceName"
          @input="emit('update', { deviceName: ($event.target as HTMLInputElement).value.trim() || 'This device' })"
        />
      </label>

      <div class="obsync-readonly-row">
        <div>
          <span>Device ID</span>
          <code>{{ props.settings.deviceId }}</code>
        </div>
      </div>

      <label class="obsync-toggle">
        <input
          type="checkbox"
          :checked="props.settings.autoSync"
          @change="emit('update', { autoSync: ($event.target as HTMLInputElement).checked })"
        />
        <span>Enable auto sync</span>
      </label>
    </section>

    <section class="obsync-section">
      <div class="obsync-section-copy">
        <h3>Connection config</h3>
        <p>Share this JSON with another device. Credentials are not included.</p>
      </div>

      <pre>{{ JSON.stringify(props.connectionConfig, null, 2) }}</pre>

      <button type="button" class="obsync-primary" @click="emit('copyConnectionConfig')">
        Copy connection JSON
      </button>
    </section>
  </main>
</template>


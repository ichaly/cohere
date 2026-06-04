<script setup lang="ts">
import { setIcon } from "obsidian";
import { ref, watchEffect } from "vue";

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
  copyDeviceId: [];
  copyConnectionConfig: [];
  pasteConnectionConfig: [];
  releaseDeletedContent: [];
}>();

const showSecretAccessKey = ref(false);
const secretAccessKeyButton = ref<HTMLButtonElement | null>(null);

watchEffect(() => {
  const button = secretAccessKeyButton.value;

  if (!button) {
    return;
  }

  button.empty();
  setIcon(button, showSecretAccessKey.value ? "eye-off" : "eye");
});
</script>

<template>
  <main class="obsync-panel">
    <header class="obsync-header">
      <div>
        <h2 class="obsync-title">Obsync 设置</h2>
        <p class="obsync-subtitle">通过对象存储同步当前 Obsidian 仓库。</p>
      </div>
    </header>

    <section class="obsync-card">
      <div class="obsync-row">
        <div class="obsync-row-copy">
          <h3>服务端点</h3>
          <p>S3 兼容对象存储地址，例如 Cloudflare R2 endpoint。</p>
        </div>
        <div class="obsync-control obsync-control-wide">
          <input
            :value="props.settings.endpoint"
            placeholder="https://xxx.r2.cloudflarestorage.com"
            @input="emit('update', { endpoint: ($event.target as HTMLInputElement).value.trim() })"
          />
        </div>
      </div>

      <div class="obsync-row">
        <div class="obsync-row-copy">
          <h3>Bucket</h3>
          <p>用于保存同步文件的对象存储桶。</p>
        </div>
        <div class="obsync-control">
          <input
            :value="props.settings.bucket"
            placeholder="ideabase"
            @input="emit('update', { bucket: ($event.target as HTMLInputElement).value.trim() })"
          />
        </div>
      </div>

      <div class="obsync-row">
        <div class="obsync-row-copy">
          <h3>Region</h3>
          <p>R2 通常填写 auto，其他 S3 服务按实际区域填写。</p>
        </div>
        <div class="obsync-control">
          <input
            :value="props.settings.region"
            placeholder="auto"
            @input="emit('update', { region: ($event.target as HTMLInputElement).value.trim() })"
          />
        </div>
      </div>

      <div class="obsync-row">
        <div class="obsync-row-copy">
          <h3>根路径</h3>
          <p>同一个 bucket 内的插件数据前缀。</p>
        </div>
        <div class="obsync-control">
          <input
            :value="props.settings.rootPrefix"
            placeholder="obsync/v2"
            @input="emit('update', { rootPrefix: ($event.target as HTMLInputElement).value.trim() || 'obsync/v2' })"
          />
        </div>
      </div>

      <div class="obsync-row">
        <div class="obsync-row-copy">
          <h3>Access Key ID</h3>
          <p>对象存储访问密钥 ID，仅保存在本地。</p>
        </div>
        <div class="obsync-control">
          <input
            :value="props.settings.accessKeyId"
            autocomplete="off"
            @input="emit('update', { accessKeyId: ($event.target as HTMLInputElement).value.trim() })"
          />
        </div>
      </div>

      <div class="obsync-row">
        <div class="obsync-row-copy">
          <h3>Secret Access Key</h3>
          <p>不会包含在连接配置中。</p>
        </div>
        <div class="obsync-control obsync-control-wide">
          <div class="obsync-secret-field">
            <input
              :type="showSecretAccessKey ? 'text' : 'password'"
              :value="props.settings.secretAccessKey"
              autocomplete="off"
              @input="emit('update', { secretAccessKey: ($event.target as HTMLInputElement).value })"
            />
            <button
              ref="secretAccessKeyButton"
              class="obsync-icon-button"
              type="button"
              :aria-label="showSecretAccessKey ? '隐藏密钥' : '显示密钥'"
              :title="showSecretAccessKey ? '隐藏密钥' : '显示密钥'"
              @click="showSecretAccessKey = !showSecretAccessKey"
            ></button>
          </div>
        </div>
      </div>
    </section>

    <section class="obsync-card">
      <div class="obsync-row">
        <div class="obsync-row-copy">
          <h3>释放空间</h3>
          <p>清理已删除文件的远端记录和不再引用的 Blob。</p>
        </div>
        <div class="obsync-control">
          <button type="button" class="obsync-secondary" @click="emit('releaseDeletedContent')">
            释放已删除内容
          </button>
        </div>
      </div>
    </section>

    <section class="obsync-card">
      <div class="obsync-row">
        <div class="obsync-row-copy">
          <h3>账号标识</h3>
          <p>同一用户或团队在所有设备上保持一致。</p>
        </div>
        <div class="obsync-control">
          <input
            :value="props.settings.accountKey"
            @input="emit('update', { accountKey: ($event.target as HTMLInputElement).value })"
          />
        </div>
      </div>

      <div class="obsync-row">
        <div class="obsync-row-copy">
          <h3>仓库标识</h3>
          <p>同一个 vault 在所有设备上保持一致。</p>
        </div>
        <div class="obsync-control">
          <input
            :value="props.settings.vaultKey"
            @input="emit('update', { vaultKey: ($event.target as HTMLInputElement).value })"
          />
        </div>
      </div>

      <div class="obsync-row">
        <div class="obsync-row-copy">
          <h3>Vault ID</h3>
          <p>根据账号标识和仓库标识自动计算。</p>
        </div>
        <div class="obsync-readonly">
          <code>{{ props.settings.vaultId }}</code>
        </div>
      </div>
    </section>

    <section class="obsync-card">
      <div class="obsync-row">
        <div class="obsync-row-copy">
          <div class="obsync-row-title">
            <h3>设备名称</h3>
            <button type="button" class="obsync-link-button" @click="emit('copyDeviceId')">
              复制设备 ID
            </button>
          </div>
          <p>用于冲突文件名和界面展示。</p>
        </div>
        <div class="obsync-control">
        <input
          :value="props.settings.deviceName"
          @input="emit('update', { deviceName: ($event.target as HTMLInputElement).value.trim() || 'This device' })"
        />
        </div>
      </div>

      <div class="obsync-row obsync-toggle-row">
        <div class="obsync-row-copy">
          <h3>自动同步</h3>
          <p>启动、恢复前台和文件变化时自动同步。</p>
        </div>
        <label class="obsync-switch">
          <input
            type="checkbox"
            :checked="props.settings.autoSync"
            @change="emit('update', { autoSync: ($event.target as HTMLInputElement).checked })"
          />
          <span></span>
        </label>
      </div>
    </section>

    <section class="obsync-card">
      <div class="obsync-row obsync-row-block">
        <div class="obsync-row-copy">
          <h3>连接配置</h3>
          <p>复制到另一台设备导入。这里不包含 Access Key 和 Secret。</p>
        </div>

        <pre class="obsync-config-display">{{ JSON.stringify(props.connectionConfig, null, 2) }}</pre>

        <div class="obsync-action-row">
          <button type="button" class="obsync-primary" @click="emit('copyConnectionConfig')">
            复制连接配置
          </button>

          <button type="button" class="obsync-secondary" @click="emit('pasteConnectionConfig')">
            粘贴并导入
          </button>
        </div>
      </div>
    </section>
  </main>
</template>

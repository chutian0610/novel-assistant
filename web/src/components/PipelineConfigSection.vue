<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api, errorMessage } from '../api';
import type { InterventionMode, PipelineSettings } from '../types';
import { INTERVENTION_MODE_LABELS, INTERVENTION_MODES } from '../types';

const loading = ref(true);
const saving = ref(false);
const saveError = ref<string | null>(null);
const saved = ref(false);

// 表单初值仅占位（与服务端默认值一致的写法副本），onMounted 加载后被真实配置整体覆盖
const form = reactive<PipelineSettings>({ mode: 'collaborative', autoRunLimit: 5 });

const MODE_HINTS: Record<InterventionMode, string> = {
  collaborative: '逐章审阅：生成一章停一章，审完草稿再继续；适合逐章把控质量。',
  auto: '全自动连跑：一次连生成多章，到达连跑上限自动暂停待审；挂起章会阻塞后续。',
};

async function reload() {
  const config = await api.get<PipelineSettings>('/api/settings/pipeline');
  Object.assign(form, config);
}

async function save() {
  saving.value = true;
  saveError.value = null;
  saved.value = false;
  try {
    const updated = await api.put<PipelineSettings>('/api/settings/pipeline', {
      mode: form.mode,
      autoRunLimit: form.autoRunLimit,
    });
    Object.assign(form, updated);
    saved.value = true;
  } catch (cause) {
    saveError.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    await reload();
  } catch (cause) {
    saveError.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <h2>管线预设</h2>
      <span v-if="saved" class="ok-text small">已保存</span>
    </div>
    <div v-if="loading" class="muted">加载中……</div>
    <template v-else>
      <div class="form-grid">
        <label>
          <span>介入点预设</span>
          <select v-model="form.mode" class="select">
            <option v-for="mode in INTERVENTION_MODES" :key="mode" :value="mode">
              {{ INTERVENTION_MODE_LABELS[mode] }}预设
            </option>
          </select>
        </label>
        <label>
          <span>全自动连跑上限（章）</span>
          <input v-model.number="form.autoRunLimit" class="input" type="number" min="1" max="20" step="1" />
        </label>
      </div>
      <p class="muted small">{{ MODE_HINTS[form.mode] }}连跑上限可配 1~20 章，默认 5。</p>
      <p v-if="saveError" class="error-text">{{ saveError }}</p>
      <div class="form-actions">
        <button class="btn btn-primary" type="button" :disabled="saving" @click="save">
          {{ saving ? '保存中……' : '保存预设' }}
        </button>
      </div>
    </template>
  </section>
</template>

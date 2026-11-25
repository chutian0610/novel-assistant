<script setup lang="ts">
import { reactive, ref } from 'vue';
import { api, errorMessage } from '../api';
import type { Provider } from '../types';

const props = defineProps<{ providers: Provider[] }>();
const emit = defineEmits<{ changed: [] }>();

const formVisible = ref(false);
const editingId = ref<number | null>(null);
const saving = ref(false);
const formError = ref<string | null>(null);
const showKey = ref(false);

const form = reactive({
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  enabled: true,
});

function openCreate() {
  editingId.value = null;
  Object.assign(form, { name: '', baseUrl: '', apiKey: '', model: '', enabled: true });
  formError.value = null;
  formVisible.value = true;
}

function openEdit(provider: Provider) {
  editingId.value = provider.id;
  Object.assign(form, {
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    enabled: provider.enabled,
  });
  formError.value = null;
  formVisible.value = true;
}

function cancelForm() {
  formVisible.value = false;
  editingId.value = null;
  formError.value = null;
}

async function submitForm() {
  saving.value = true;
  formError.value = null;
  const payload = { ...form };
  try {
    if (editingId.value === null) {
      await api.post('/api/settings/providers', payload);
    } else {
      await api.patch(`/api/settings/providers/${editingId.value}`, payload);
    }
    cancelForm();
    emit('changed');
  } catch (cause) {
    formError.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}

async function remove(provider: Provider) {
  if (!window.confirm(`确定删除供应商「${provider.name}」？引用它的任务路由将取消指派。`)) return;
  try {
    await api.delete(`/api/settings/providers/${provider.id}`);
    emit('changed');
  } catch (cause) {
    window.alert(errorMessage(cause));
  }
}
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <div>
        <h2>供应商管理</h2>
        <p class="muted">任意 OpenAI 兼容服务（含本地服务），可添加多个。</p>
      </div>
      <button v-if="!formVisible" class="btn btn-primary" type="button" @click="openCreate">新增供应商</button>
    </div>

    <form v-if="formVisible" class="provider-form" @submit.prevent="submitForm">
      <h3>{{ editingId === null ? '新增供应商' : '编辑供应商' }}</h3>
      <div class="form-grid">
        <label>名称<input v-model="form.name" class="input" type="text" placeholder="如：DeepSeek / 本地 Ollama" /></label>
        <label>Base URL<input v-model="form.baseUrl" class="input" type="text" placeholder="如：https://api.deepseek.com/v1 或 http://localhost:11434/v1（ollama）" /></label>
        <label>API Key
          <div class="key-row">
            <input v-model="form.apiKey" class="input" :type="showKey ? 'text' : 'password'" placeholder="本地服务可为空" />
            <button class="btn btn-ghost" type="button" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button>
          </div>
        </label>
        <label>默认模型<input v-model="form.model" class="input" type="text" placeholder="如：deepseek-chat / bge-m3（ollama 嵌入）" /></label>
        <label class="checkbox-label"><input v-model="form.enabled" type="checkbox" /> 启用该供应商</label>
      </div>
      <p v-if="formError" class="error-text">{{ formError }}</p>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit" :disabled="saving">{{ saving ? '保存中……' : '保存' }}</button>
        <button class="btn btn-ghost" type="button" @click="cancelForm">取消</button>
      </div>
    </form>

    <div v-else-if="providers.length === 0" class="empty muted">
      还没有供应商，点击「新增供应商」开始配置。
    </div>

    <ul v-else class="provider-list">
      <li v-for="provider in providers" :key="provider.id" class="provider-card">
        <div class="provider-info">
          <div class="provider-name">
            {{ provider.name }}
            <span class="badge" :class="provider.enabled ? 'badge-ok' : 'badge-off'">
              {{ provider.enabled ? '启用' : '停用' }}
            </span>
          </div>
          <div class="muted small">{{ provider.baseUrl }}</div>
          <div class="muted small">默认模型：{{ provider.model }}</div>
        </div>
        <div class="provider-actions">
          <button class="btn btn-ghost" type="button" @click="openEdit(provider)">编辑</button>
          <button class="btn btn-danger-ghost" type="button" @click="remove(provider)">删除</button>
        </div>
      </li>
    </ul>
  </section>
</template>

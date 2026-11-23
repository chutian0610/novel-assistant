<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, errorMessage } from '../api';
import type { Provider, TaskRoute } from '../types';
import ProviderSection from '../components/ProviderSection.vue';
import RouteSection from '../components/RouteSection.vue';
import DetectorConfigSection from '../components/DetectorConfigSection.vue';
import AuthorProfileSection from '../components/AuthorProfileSection.vue';
import PipelineConfigSection from '../components/PipelineConfigSection.vue';

const providers = ref<Provider[]>([]);
const routes = ref<TaskRoute[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function reload() {
  const [nextProviders, nextRoutes] = await Promise.all([
    api.get<Provider[]>('/api/settings/providers'),
    api.get<TaskRoute[]>('/api/settings/routes'),
  ]);
  providers.value = nextProviders;
  routes.value = nextRoutes;
}

async function onSettingsChanged() {
  try {
    await reload();
  } catch (cause) {
    loadError.value = errorMessage(cause);
  }
}

onMounted(async () => {
  try {
    await reload();
  } catch (cause) {
    loadError.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1>设置</h1>
      <p class="page-sub">配置 LLM 供应商与任务路由（OpenAI 兼容）、管线介入点预设（协作 / 全自动连跑）与作者偏好档案（对所有书生效）。</p>
    </header>

    <div v-if="loading" class="panel muted">加载中……</div>
    <div v-else-if="loadError" class="panel error-text">{{ loadError }}</div>
    <template v-else>
      <ProviderSection :providers="providers" @changed="onSettingsChanged" />
      <RouteSection :providers="providers" :routes="routes" @changed="onSettingsChanged" />
      <PipelineConfigSection />
      <AuthorProfileSection />
      <DetectorConfigSection />
    </template>
  </div>
</template>

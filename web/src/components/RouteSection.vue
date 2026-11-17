<script setup lang="ts">
import { reactive, watch } from 'vue';
import { api, errorMessage } from '../api';
import { TASK_LABELS, TASK_TYPES, type Provider, type RouteTestResult, type TaskRoute, type TaskType } from '../types';

const props = defineProps<{ providers: Provider[]; routes: TaskRoute[] }>();
const emit = defineEmits<{ changed: [] }>();

interface RowDraft {
  providerId: number | null;
  model: string;
  enabled: boolean;
}

interface RowState {
  draft: RowDraft;
  saving: boolean;
  testing: boolean;
  result: RouteTestResult | null;
  error: string | null;
}

const rows = reactive({} as Record<TaskType, RowState>);
// 上次的服务端快照：仅在本地无未保存改动时才用服务端数据覆盖草稿
let serverSnapshot = new Map<TaskType, RowDraft>();

watch(
  () => props.routes,
  (routes) => {
    const next = new Map<TaskType, RowDraft>();
    for (const route of routes) {
      next.set(route.task, { providerId: route.providerId, model: route.model, enabled: route.enabled });
    }
    for (const [task, server] of next) {
      const local = rows[task]?.draft;
      const prev = serverSnapshot.get(task);
      const untouched = !local || !prev || isSame(local, prev);
      if (!rows[task]) {
        rows[task] = { draft: { ...server }, saving: false, testing: false, result: null, error: null };
      } else if (untouched) {
        rows[task].draft = { ...server };
      }
    }
    serverSnapshot = next;
  },
  { immediate: true, deep: true }
);

function isSame(a: RowDraft, b: RowDraft): boolean {
  return a.providerId === b.providerId && a.model === b.model && a.enabled === b.enabled;
}

async function save(task: TaskType) {
  const row = rows[task];
  row.saving = true;
  row.error = null;
  try {
    await api.put(`/api/settings/routes/${task}`, {
      providerId: row.draft.providerId,
      model: row.draft.model.trim(),
      enabled: row.draft.enabled,
    });
    emit('changed');
  } catch (cause) {
    row.error = errorMessage(cause);
  } finally {
    row.saving = false;
  }
}

async function runTest(task: TaskType) {
  const row = rows[task];
  row.testing = true;
  row.result = null;
  row.error = null;
  try {
    row.result = await api.post<RouteTestResult>(`/api/settings/routes/${task}/test`, {});
  } catch (cause) {
    row.error = errorMessage(cause);
  } finally {
    row.testing = false;
  }
}

function providerLabel(provider: Provider): string {
  return provider.enabled ? provider.name : `${provider.name}（已停用）`;
}

function resultText(task: TaskType): string {
  const row = rows[task];
  if (!row?.result) return '';
  const r = row.result;
  return r.ok ? `连通成功 · ${r.provider?.name ?? ''} · ${r.model ?? ''} · ${r.latencyMs}ms` : `连通失败：${r.error ?? '未知错误'}`;
}
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <div>
        <h2>任务路由</h2>
        <p class="muted">为每类生成任务指定供应商；可覆写模型（留空用供应商默认）。修改后点「保存」。</p>
      </div>
    </div>

    <div class="route-list">
      <div v-for="task in TASK_TYPES" :key="task" class="route-row" :class="{ 'route-disabled': !rows[task]?.draft.enabled }">
        <div class="route-name">
          <span class="route-title">{{ TASK_LABELS[task] }}</span>
          <span class="muted small">{{ task }}</span>
        </div>

        <div class="route-controls">
          <select v-model="rows[task].draft.providerId" class="select" :aria-label="`任务 ${TASK_LABELS[task]} 的供应商`">
            <option :value="null">未配置</option>
            <option v-for="provider in providers" :key="provider.id" :value="provider.id">
              {{ providerLabel(provider) }}
            </option>
          </select>
          <input
            v-model="rows[task].draft.model"
            class="input route-model"
            type="text"
            placeholder="覆写模型（留空用供应商默认）"
          />
          <label class="checkbox-label"><input v-model="rows[task].draft.enabled" type="checkbox" /> 启用</label>
        </div>

        <div class="route-actions">
          <button class="btn btn-ghost" type="button" :disabled="rows[task].saving" @click="save(task)">
            {{ rows[task].saving ? '保存中……' : '保存' }}
          </button>
          <button
            class="btn"
            type="button"
            :disabled="rows[task].testing"
            title="按已保存的路由配置发起最小调用；改动需先点「保存」"
            @click="runTest(task)"
          >
            {{ rows[task].testing ? '测试中……' : '测试连通' }}
          </button>
        </div>

        <div v-if="rows[task].result" class="route-result" :class="rows[task].result.ok ? 'ok-text' : 'error-text'">
          {{ resultText(task) }}
        </div>
        <div v-if="rows[task].error" class="error-text">{{ rows[task].error }}</div>
        <div v-if="rows[task].draft.providerId !== null" class="muted small route-effective">
          生效模型：{{ routes.find((r) => r.task === task)?.effectiveModel ?? '—' }}
        </div>
      </div>
    </div>
  </section>
</template>

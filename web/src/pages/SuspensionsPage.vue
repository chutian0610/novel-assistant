<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api, errorMessage } from '../api';
import type { Suspension, SuspensionActionResult, SuspensionListResponse } from '../types';
import { SUSPENSION_RESOLUTION_LABELS, SUSPENSION_SOURCE_LABELS } from '../types';

const route = useRoute();
const bookId = computed(() => Number(route.params.id));

const items = ref<Suspension[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const actingId = ref<number | null>(null);
/** 最近一次动作的结果提示（如「重写后复检达标，已提交」） */
const lastAction = ref<string | null>(null);

const pending = computed(() => items.value.filter((item) => item.status === 'pending'));
const resolved = computed(() => items.value.filter((item) => item.status === 'resolved'));

function formatTime(raw: string): string {
  return raw.replace('T', ' ').slice(0, 16);
}

function detailSentences(item: Suspension): string[] {
  return item.detail.sentences ?? [];
}

async function load() {
  const id = bookId.value;
  if (!Number.isInteger(id) || id <= 0) {
    loadError.value = `非法的书 id：${route.params.id}`;
    loading.value = false;
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    items.value = (await api.get<SuspensionListResponse>(`/api/books/${id}/suspensions`)).items;
  } catch (cause) {
    loadError.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function act(item: Suspension, action: 'rewrite' | 'ignore' | 'fact') {
  if (actingId.value !== null) return;
  if (action !== 'rewrite' && !window.confirm(`确认${action === 'ignore' ? '忽略放行' : '按修正事实处理'}「${item.title}」？全部挂起项处理完后该章会自动提交。`)) return;
  actingId.value = item.id;
  actionError.value = null;
  lastAction.value = null;
  try {
    const url = `/api/books/${bookId.value}/chapters/${item.idx}/suspensions/${item.id}/${action}`;
    const result = await api.post<SuspensionActionResult>(
      url,
      action === 'rewrite' ? {} : { resolution: action }
    );
    await load();
    if (result.run?.status === 'done') {
      lastAction.value = `第 ${item.idx} 章已过闸并提交（${SUSPENSION_RESOLUTION_LABELS[action === 'rewrite' ? 'rewrite' : action]}）`;
    } else if (action === 'rewrite') {
      lastAction.value = `第 ${item.idx} 章重写后复检仍未过闸，已生成新的挂起项`;
    }
  } catch (cause) {
    actionError.value = errorMessage(cause);
  } finally {
    actingId.value = null;
  }
}

// 同组件路由复用（/books/1/suspensions → /books/2/suspensions）时重载
watch(bookId, load);
onMounted(load);
</script>

<template>
  <div class="page">
    <header class="page-head">
      <RouterLink :to="`/books/${bookId}`" class="muted small">← 返回书详情</RouterLink>
      <h1>挂起队列<template v-if="pending.length">（{{ pending.length }} 项待处理）</template></h1>
      <p class="page-sub">
        fix 定向重写默认 2 轮后仍不达标，或语义核查发现与事实库矛盾时，章节挂起等待人工裁决。
        一键处理：定向重写（改一轮后复检）、忽略放行、修正事实；全部处理完该章自动提交。
      </p>
    </header>

    <div v-if="loading" class="panel muted">加载中……</div>
    <div v-else-if="loadError" class="panel error-text">{{ loadError }}</div>
    <template v-else>
      <p v-if="lastAction" class="panel ok-text">{{ lastAction }}</p>
      <p v-if="actionError" class="panel error-text">{{ actionError }}</p>

      <section class="panel">
        <div class="panel-head">
          <h2>待处理（{{ pending.length }}）</h2>
          <RouterLink :to="`/books/${bookId}/metrics`" class="btn btn-ghost small">检测报告</RouterLink>
        </div>
        <div v-if="pending.length === 0" class="empty muted">队列为空：没有等待裁决的章节。</div>
        <div v-else class="writing-list">
          <div v-for="item in pending" :key="item.id" class="suspension-card">
            <div class="suspension-head">
              <span class="chip chip-static" :class="{ 'writing-chip-failed': item.source === 'detection' }">
                {{ SUSPENSION_SOURCE_LABELS[item.source] }}
              </span>
              <strong>第{{ item.idx }}章 · {{ item.title }}</strong>
              <span class="muted small">第 {{ item.round }} 轮 · {{ formatTime(item.createdAt) }}</span>
            </div>
            <p class="muted small suspension-reason">{{ item.reason }}</p>
            <ul v-if="detailSentences(item).length > 0" class="suspension-evidence">
              <li v-for="(sentence, index) in detailSentences(item)" :key="index">{{ sentence }}</li>
            </ul>
            <p v-if="item.detail.quote" class="suspension-evidence">
              「{{ item.detail.quote }}」<span class="muted small">（{{ item.detail.explanation }}{{ item.detail.factHint ? ` · 相关事实：${item.detail.factHint}` : '' }}）</span>
            </p>
            <div class="suspension-actions">
              <button class="btn btn-primary" type="button" :disabled="actingId !== null" @click="act(item, 'rewrite')">
                {{ actingId === item.id ? '重写复检中……' : '定向重写' }}
              </button>
              <button class="btn" type="button" :disabled="actingId !== null" @click="act(item, 'ignore')">忽略放行</button>
              <button class="btn" type="button" :disabled="actingId !== null" @click="act(item, 'fact')">修正事实</button>
              <RouterLink :to="`/books/${bookId}/facts`" class="btn btn-ghost small">去事实面板</RouterLink>
            </div>
          </div>
        </div>
      </section>

      <section v-if="resolved.length > 0" class="panel">
        <div class="panel-head">
          <h2>已处理（{{ resolved.length }}）</h2>
        </div>
        <div class="writing-list">
          <div v-for="item in resolved" :key="item.id" class="writing-row writing-row-static">
            <span class="chip chip-static">{{ SUSPENSION_SOURCE_LABELS[item.source] }}</span>
            <span>第{{ item.idx }}章 · {{ item.title }}</span>
            <span class="muted small">
              {{ item.resolution ? SUSPENSION_RESOLUTION_LABELS[item.resolution] : '' }} · {{ formatTime(item.updatedAt) }}
            </span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

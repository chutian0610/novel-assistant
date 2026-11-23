<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api, errorMessage } from '../api';
import type { Book, ChapterMetrics, ChapterMetricsResponse, MetricKey } from '../types';
import { METRIC_KEY_LABELS, METRIC_KEYS } from '../types';

const route = useRoute();
const bookId = computed(() => Number(route.params.id));

const book = ref<Book | null>(null);
const items = ref<ChapterMetrics[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

function formatTime(raw: string): string {
  return raw.replace('T', ' ').slice(0, 16);
}

function percent(score: number): string {
  return `${Math.min(100, Math.max(0, score)).toFixed(0)}%`;
}

function formatMetric(item: ChapterMetrics, key: MetricKey): string {
  const metric = metricOf(item, key);
  if (!metric) return '—';
  return String(Math.round(metric.value * 1000) / 1000);
}

function metricOf(item: ChapterMetrics, key: MetricKey) {
  return item.metrics.find((candidate) => candidate.key === key);
}

function isFailing(item: ChapterMetrics, key: MetricKey): boolean {
  return metricOf(item, key)?.pass === false;
}

function isSkipped(item: ChapterMetrics, key: MetricKey): boolean {
  return metricOf(item, key)?.skipped === true;
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
    book.value = await api.get<Book>(`/api/books/${id}`);
    items.value = (await api.get<ChapterMetricsResponse>(`/api/books/${id}/metrics`)).items;
  } catch (cause) {
    loadError.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

// 同组件路由复用（/books/1/metrics → /books/2/metrics）时重载
watch(bookId, load);
onMounted(load);
</script>

<template>
  <div class="page">
    <header class="page-head">
      <RouterLink :to="`/books/${bookId}`" class="muted small">← 返回书详情</RouterLink>
      <h1>检测报告<template v-if="book"> · {{ book.title }}</template></h1>
      <p class="page-sub">
        每章 verify 阶段落库的 8 维检测指标（人工编辑正文后重算）：倾向分越低越好，8 维全部达标才过闸提交。
        <RouterLink :to="`/books/${bookId}/writing`" class="small">去写作台生成</RouterLink>
      </p>
    </header>

    <div v-if="loading" class="panel muted">加载中……</div>
    <div v-else-if="loadError" class="panel error-text">{{ loadError }}</div>
    <template v-else>
      <section class="panel">
        <div class="panel-head">
          <h2>AI 倾向分趋势（降权后，0~100 越低越好）</h2>
          <RouterLink :to="`/books/${bookId}/suspensions`" class="btn btn-ghost small">挂起队列</RouterLink>
        </div>
        <div v-if="items.length === 0" class="empty muted">
          还没有指标记录。生成章节后，verify 阶段的双报告会按章落库到这里。
        </div>
        <div v-else class="metrics-trend">
          <div v-for="item in items" :key="item.idx" class="metrics-row">
            <span class="metrics-row-label">第{{ item.idx }}章{{ item.title ? ` ${item.title}` : '' }}</span>
            <div class="metrics-bar">
              <div class="metrics-bar-fill" :class="{ 'metrics-bar-bad': item.adjustedScore > 20 }" :style="{ width: percent(item.adjustedScore) }"></div>
            </div>
            <span class="metrics-row-value">{{ item.adjustedScore }}</span>
            <span class="muted small">{{ item.wordCount }} 字 · {{ formatTime(item.updatedAt) }}</span>
          </div>
        </div>
      </section>

      <section v-if="items.length > 0" class="panel">
        <div class="panel-head">
          <h2>逐章 8 维明细</h2>
          <span class="muted small">✓ 达标 · ✗ 不达标 · — 样本不足未计入</span>
        </div>
        <div class="metrics-table-wrap">
          <table class="detector-table metrics-table">
            <thead>
              <tr>
                <th>章</th>
                <th>倾向分</th>
                <th v-for="key in METRIC_KEYS" :key="key">{{ METRIC_KEY_LABELS[key] }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in items" :key="item.idx">
                <td>第{{ item.idx }}章</td>
                <td :class="{ 'ok-text': item.adjustedScore <= 20, 'error-text': item.adjustedScore > 20 }">
                  {{ item.adjustedScore }}
                </td>
                <td v-for="key in METRIC_KEYS" :key="key">
                  <template v-if="isSkipped(item, key)">—</template>
                  <template v-else>
                    <span :class="isFailing(item, key) ? 'error-text' : 'ok-text'">
                      {{ isFailing(item, key) ? '✗' : '✓' }}
                    </span>
                    {{ formatMetric(item, key) }}
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>

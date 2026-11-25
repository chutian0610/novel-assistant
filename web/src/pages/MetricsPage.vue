<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api, errorMessage } from '../api';
import type { Book, ChapterMetrics, ChapterMetricsResponse, MetricKey, RadarResponse, ThrillType } from '../types';
import { HOOK_RATING_LABELS, METRIC_KEY_LABELS, METRIC_KEYS, THRILL_TYPE_LABELS } from '../types';

const route = useRoute();
const bookId = computed(() => Number(route.params.id));

const book = ref<Book | null>(null);
const items = ref<ChapterMetrics[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

// 爽点雷达（T18，观测与预警维度）：标注为空 = 未评测或 analyze 路由未配置
const radar = ref<RadarResponse | null>(null);
const radarLoadError = ref<string | null>(null);
const resyncingIdx = ref<number | null>(null);
const resyncError = ref<string | null>(null);

/** 手动重灌单章爽点评测（analyze 路由未配置或失败时错误就地显示） */
async function resyncRadar(idx: number) {
  resyncingIdx.value = idx;
  resyncError.value = null;
  try {
    const res = await api.post<{ error: string | null }>(`/api/books/${bookId.value}/chapters/${idx}/radar`, {});
    resyncError.value = res.error;
    radar.value = await api.get<RadarResponse>(`/api/books/${bookId.value}/radar`);
  } catch (cause) {
    resyncError.value = errorMessage(cause);
  } finally {
    resyncingIdx.value = null;
  }
}

function hookLabel(rating: string): string {
  return HOOK_RATING_LABELS[rating as keyof typeof HOOK_RATING_LABELS] ?? rating;
}

function thrillLabel(type: string): string {
  return THRILL_TYPE_LABELS[type as ThrillType] ?? type;
}

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
    // 雷达独立加载：失败不拖垮检测报告页（如 analyze 路由未配置时依旧可用）
    try {
      radar.value = await api.get<RadarResponse>(`/api/books/${id}/radar`);
      radarLoadError.value = null;
    } catch (cause) {
      radar.value = null;
      radarLoadError.value = errorMessage(cause);
    }
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
      <div v-if="radar?.warning" class="panel error-text">
        ⚠ 连续 {{ radar.warning.streak }} 章无爽点（第 {{ radar.warning.fromIdx }}~{{ radar.warning.toIdx }} 章，预警窗口
        {{ radar.warning.window }} 章）——长程节奏可能崩，读者流失风险高。
        <RouterLink :to="`/books/${bookId}/writing?chapter=${radar.warning.fromIdx}`" class="small">去写作台查看</RouterLink>
      </div>

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

      <section class="panel">
        <div class="panel-head">
          <h2>爽点雷达</h2>
          <span class="muted small">每章落稿后的语义评测（观测与预警维度，不进重写闸门）· 点章号去写作台定位正文</span>
        </div>
        <div v-if="radarLoadError" class="muted small">{{ radarLoadError }}（爽点评测需在设置中配置「爽点评测」任务路由）</div>
        <div v-else-if="resyncError" class="error-text small">{{ resyncError }}</div>
        <div v-else-if="!radar || radar.items.length === 0" class="empty muted">
          还没有爽点标注。配置「爽点评测」任务路由后，落稿章节会在 commit 后自动评测（可在写作台手动重灌）。
        </div>
        <template v-else>
          <div class="metrics-trend">
            <div v-for="chapter in radar.items" :key="chapter.idx" class="metrics-row">
              <span class="metrics-row-label">
                <RouterLink :to="`/books/${bookId}/writing?chapter=${chapter.idx}`" class="small">第{{ chapter.idx }}章</RouterLink>
              </span>
              <div class="metrics-bar">
                <div class="metrics-bar-fill" :style="{ width: `${Math.min(100, chapter.thrillCount * 20)}%` }"></div>
              </div>
              <span class="metrics-row-value">{{ chapter.thrillCount }} 爽点</span>
              <span class="muted small">
                钩子：{{ chapter.hook ? hookLabel(chapter.hook.rating) : '—' }}
                <template v-if="chapter.hook && chapter.hook.quote"> · {{ chapter.hook.quote.slice(0, 24) }}……</template>
                <button class="btn btn-ghost small" type="button" :disabled="resyncingIdx !== null" @click="resyncRadar(chapter.idx)">
                  {{ resyncingIdx === chapter.idx ? '评测中……' : '重灌' }}
                </button>
              </span>
            </div>
          </div>
          <div class="metrics-table-wrap">
            <table class="detector-table metrics-table">
              <thead>
                <tr>
                  <th>章</th>
                  <th>爽点明细</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="chapter in radar.items" :key="chapter.idx">
                  <td>第{{ chapter.idx }}章</td>
                  <td>
                    <template v-if="chapter.thrills.length === 0" class="muted">无爽点标注</template>
                    <ul v-else class="radar-marks">
                      <li v-for="thrill in chapter.thrills" :key="thrill.id">
                        <span class="chip chip-static">{{ thrillLabel(thrill.type) }}</span>
                        <span>强度 {{ thrill.intensity }}</span>
                        <span class="muted">「{{ thrill.quote.slice(0, 32) }}{{ thrill.quote.length > 32 ? '……' : '' }}」</span>
                        <span class="muted small">{{ thrill.reason }}</span>
                      </li>
                    </ul>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>
    </template>
  </div>
</template>

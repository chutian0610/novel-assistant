<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api, errorMessage } from '../api';
import type { ExtractionItem, ExtractionListResponse, ExtractRunResult, ReferenceDetail } from '../types';
import ExtractionCard from '../components/ExtractionCard.vue';

const route = useRoute();
const referenceId = computed(() => Number(route.params.id));

const reference = ref<ReferenceDetail | null>(null);
const pendingItems = ref<ExtractionItem[]>([]);
const archivedItems = ref<ExtractionItem[]>([]);
const showArchived = ref(false);
const loading = ref(true);
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);

const extracting = ref(false);
const extractMessage = ref<string | null>(null);
/** 全书骨骼提取 / 一键仿写共用的忙状态（两者都产出入队条目） */
const skeletonBusy = ref(false);

const progressPercent = computed(() =>
  reference.value && reference.value.chapterCount > 0
    ? Math.round((reference.value.extractedCount / reference.value.chapterCount) * 100)
    : 0
);

/** 加载参考书 + 全部状态的抽取队列（pending 与已处理分开存放） */
async function loadQueue() {
  const id = referenceId.value;
  reference.value = await api.get<ReferenceDetail>(`/api/references/${id}`);
  const [pending, accepted, rejected] = await Promise.all([
    api.get<ExtractionListResponse>(`/api/references/${id}/extractions?status=pending`),
    api.get<ExtractionListResponse>(`/api/references/${id}/extractions?status=accepted`),
    api.get<ExtractionListResponse>(`/api/references/${id}/extractions?status=rejected`),
  ]);
  pendingItems.value = pending.items;
  archivedItems.value = [...accepted.items, ...rejected.items];
}

async function load() {
  const id = referenceId.value;
  if (!Number.isInteger(id) || id <= 0) {
    loadError.value = `非法的参考书 id：${route.params.id}`;
    loading.value = false;
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    await loadQueue();
  } catch (cause) {
    loadError.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

/** 逐批抽取直到抽完或出现失败章；中断后已抽章已落盘，再次点击从剩余章节继续（断点续跑） */
async function extractAll() {
  extracting.value = true;
  extractMessage.value = null;
  actionError.value = null;
  try {
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 500) {
        extractMessage.value = '抽取轮次过多，已中止，请再次点击继续。';
        break;
      }
      const run = await api.post<ExtractRunResult>(`/api/references/${referenceId.value}/extract`, { limit: 5 });
      await loadQueue();
      if (run.failed.length > 0) {
        extractMessage.value = `有 ${run.failed.length} 章抽取失败已暂停：${run.failed[0]!.error}（失败章节可再次点击重试）`;
        break;
      }
      if (run.remaining === 0) {
        extractMessage.value = '全部章节抽取完成，请在下方确认队列逐条处理。';
        break;
      }
    }
  } catch (cause) {
    actionError.value = errorMessage(cause);
  } finally {
    extracting.value = false;
    await reloadQueue();
  }
}

async function reloadQueue() {
  try {
    await loadQueue();
  } catch (cause) {
    actionError.value = errorMessage(cause);
  }
}

/** 全书骨骼提取：全书章节标题 + 开头片段 → 结构完整的骨骼条目进确认队列 */
async function extractSkeleton() {
  skeletonBusy.value = true;
  extractMessage.value = null;
  actionError.value = null;
  try {
    await api.post(`/api/references/${referenceId.value}/extract-skeleton`, {});
    extractMessage.value = '全书骨骼已提取，请在确认队列中处理。';
    await loadQueue();
  } catch (cause) {
    actionError.value = errorMessage(cause);
  } finally {
    skeletonBusy.value = false;
  }
}

/** 一键仿写：基于已入库书骨骼生成全新设定/角色卡（走确认队列入库） */
async function adaptSkeleton(item: ExtractionItem) {
  if (item.materialId === null) return;
  skeletonBusy.value = true;
  extractMessage.value = null;
  actionError.value = null;
  try {
    const res = await api.post<{ created: number }>(`/api/references/${referenceId.value}/adapt-skeleton`, {
      materialId: item.materialId,
    });
    extractMessage.value = `仿写完成：已生成 ${res.created} 条原创设定/角色，请在确认队列中逐条处理。`;
    await loadQueue();
  } catch (cause) {
    actionError.value = errorMessage(cause);
  } finally {
    skeletonBusy.value = false;
  }
}

watch(referenceId, load);
onMounted(load);
</script>

<template>
  <div class="page">
    <header class="page-head">
      <RouterLink to="/references" class="muted small">← 返回拆书</RouterLink>
      <h1 v-if="reference">{{ reference.title }}</h1>
      <h1 v-else>拆书详情</h1>
      <p v-if="reference" class="page-sub">共 {{ reference.chapterCount }} 章 · 已抽取 {{ reference.extractedCount }} 章 · {{ reference.pendingItemCount }} 条待确认</p>
    </header>

    <div v-if="loading" class="panel muted">加载中……</div>
    <div v-else-if="loadError" class="panel error-text">{{ loadError }}</div>
    <template v-else-if="reference">
      <section class="panel">
        <div class="panel-head">
          <h2>章节抽取进度</h2>
          <button class="btn btn-primary" type="button" :disabled="extracting || reference.extractedCount === reference.chapterCount" @click="extractAll">
            {{ extracting ? '抽取中……' : reference.extractedCount === 0 ? '开始逐章抽取' : '继续抽取剩余章节' }}
          </button>
        </div>
        <div class="progress-track">
          <div class="progress-fill" :style="{ width: `${progressPercent}%` }"></div>
        </div>
        <p v-if="extractMessage" class="ok-text small">{{ extractMessage }}</p>
        <p v-if="actionError" class="error-text">{{ actionError }}</p>
        <div class="chapter-list">
          <span
            v-for="chapter in reference.chapters"
            :key="chapter.id"
            class="chapter-chip"
            :class="{ 'chapter-done': chapter.extractStatus === 'done' }"
            :title="`${chapter.title}（${chapter.charCount} 字）`"
          >
            {{ chapter.title }}
          </span>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>确认队列（{{ pendingItems.length }}）</h2>
          <div class="material-actions">
            <button
              class="btn"
              type="button"
              :disabled="skeletonBusy"
              
              @click="extractSkeleton"
            >
              {{ skeletonBusy ? '提取中……' : '提取全书骨骼' }}
            </button>
            <label class="checkbox-label">
              <input v-model="showArchived" type="checkbox" /> 显示已处理（{{ archivedItems.length }}）
            </label>
          </div>
        </div>
        <div v-if="pendingItems.length === 0 && !showArchived" class="empty muted">
          队列为空。点击「开始逐章抽取」抽取素材，或「提取全书骨骼」提炼整本书的结构骨架。
        </div>
        <div class="material-list">
          <ExtractionCard
            v-for="item in pendingItems"
            :key="item.id"
            :item="item"
            @changed="reloadQueue"
            @removed="reloadQueue"
          />
          <template v-if="showArchived">
            <ExtractionCard
              v-for="item in archivedItems"
              :key="`a-${item.id}`"
              :item="item"
              @changed="reloadQueue"
              @adapt="adaptSkeleton(item)"
            />
          </template>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api, errorMessage } from '../api';
import type { Book, Chapter, ChapterDetail, ChapterListItem, ChapterListResponse, GenerateResult, OutlineTree } from '../types';
import { PIPELINE_STAGE_LABELS, PIPELINE_STATUS_LABELS, SNAPSHOT_SOURCE_LABELS } from '../types';

const route = useRoute();
const bookId = computed(() => Number(route.params.id));

const book = ref<Book | null>(null);
const outlineTree = ref<OutlineTree | null>(null);
const chapters = ref<ChapterListItem[]>([]);
const detail = ref<ChapterDetail | null>(null);
const selectedIdx = ref<number | null>(null);
/** 正文编辑缓冲：打开章节时装载，保存后与详情同步 */
const editorContent = ref('');

const loading = ref(true);
const loadError = ref<string | null>(null);
const generateError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const generating = ref(false);
const saving = ref(false);

/** 单章生成入口：只列已批准/锁定的章纲（章号 = 大纲树扁平序，与管线章号映射一致） */
const generatableChapters = computed(() => {
  const options: { value: number; label: string }[] = [];
  let ordinal = 0;
  for (const volume of outlineTree.value?.volumes ?? []) {
    for (const outline of volume.chapters) {
      ordinal += 1;
      if (outline.status === 'approved' || outline.status === 'locked') {
        options.push({
          value: ordinal,
          label: `${ordinal} · ${volume.title} / ${outline.title}${outline.status === 'locked' ? '（已锁定）' : ''}`,
        });
      }
    }
  }
  return options;
});
const newChapterIdx = ref<number | null>(null);

const detailRun = computed(() => detail.value?.run ?? null);
const editorDirty = computed(() => detail.value !== null && editorContent.value !== detail.value.chapter.content);

function formatTime(raw: string): string {
  return raw.replace('T', ' ').slice(0, 16);
}

async function refreshList() {
  chapters.value = (await api.get<ChapterListResponse>(`/api/books/${bookId.value}/chapters`)).items;
}

async function select(idx: number) {
  actionError.value = null;
  try {
    detail.value = await api.get<ChapterDetail>(`/api/books/${bookId.value}/chapters/${idx}`);
    selectedIdx.value = idx;
    editorContent.value = detail.value.chapter.content;
  } catch (cause) {
    detail.value = null;
    selectedIdx.value = null;
    actionError.value = errorMessage(cause);
  }
}

async function generate() {
  if (newChapterIdx.value === null || generating.value) return;
  generating.value = true;
  generateError.value = null;
  try {
    const result = await api.post<GenerateResult>(
      `/api/books/${bookId.value}/chapters/${newChapterIdx.value}/generate`,
      {}
    );
    await refreshList();
    if (result.chapter) {
      await select(result.chapter.idx);
    } else {
      // 闸门未过（重写轮次用尽 / 语义冲突）：管线挂起，去挂起队列裁决
      generateError.value =
        '闸门未过，本章已挂起等待人工裁决（fix 重写轮次用尽或语义核查发现事实矛盾）。到挂起队列处理后可自动提交。';
    }
  } catch (cause) {
    generateError.value = errorMessage(cause);
    // 失败也已落盘（断点续跑的起点），刷新列表呈现运行状态
    await refreshList().catch(() => undefined);
  } finally {
    generating.value = false;
  }
}

async function saveEdit() {
  if (detail.value === null || !editorDirty.value || saving.value) return;
  saving.value = true;
  actionError.value = null;
  try {
    const chapter = await api.patch<Chapter>(
      `/api/books/${bookId.value}/chapters/${detail.value.chapter.idx}`,
      { content: editorContent.value }
    );
    detail.value = { ...detail.value, chapter: { ...detail.value.chapter, ...chapter } };
    await refreshList();
  } catch (cause) {
    actionError.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}

async function revert(snapshotId: number) {
  if (detail.value === null) return;
  const snapshot = detail.value.snapshots.find((item) => item.id === snapshotId);
  if (!window.confirm(`回退到「${snapshot ? SNAPSHOT_SOURCE_LABELS[snapshot.source] : '快照'}」（${formatTime(snapshot?.createdAt ?? '')}）？当前正文会成为一条新快照。`)) return;
  actionError.value = null;
  try {
    await api.post(`/api/books/${bookId.value}/chapters/${detail.value.chapter.idx}/revert`, { snapshotId });
    await select(detail.value.chapter.idx);
    await refreshList();
  } catch (cause) {
    actionError.value = errorMessage(cause);
  }
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
    outlineTree.value = await api.get<OutlineTree>(`/api/books/${id}/outlines`);
    await refreshList();
    // 选中章仍在则保留；否则选第一已生成章
    if (selectedIdx.value !== null && chapters.value.some((item) => item.idx === selectedIdx.value)) {
      await select(selectedIdx.value);
    } else {
      selectedIdx.value = null;
      detail.value = null;
      if (chapters.value.length > 0) await select(chapters.value[0]!.idx);
    }
    if (newChapterIdx.value === null && generatableChapters.value.length > 0) {
      newChapterIdx.value = generatableChapters.value[0]!.value;
    }
  } catch (cause) {
    loadError.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

// 同组件路由复用（/books/1/writing → /books/2/writing）时重载
watch(bookId, load);
onMounted(load);
</script>

<template>
  <div class="page">
    <header class="page-head">
      <RouterLink :to="`/books/${bookId}`" class="muted small">← 返回书详情</RouterLink>
      <h1>写作台<template v-if="book"> · {{ book.title }}</template></h1>
      <p class="page-sub">
        单章生成走 prepare→draft→commit 管线：前置校验须有已批准章纲，每阶段落盘，中断后从断点续跑、不重复调用模型；
        commit 单事务落盘正文、版本快照与滚动摘要。verify/fix 检测闭环在后续工单接入。
      </p>
    </header>

    <div v-if="loading" class="panel muted">加载中……</div>
    <div v-else-if="loadError" class="panel error-text">{{ loadError }}</div>
    <template v-else>
      <!-- 单章生成入口 -->
      <section class="panel">
        <div class="panel-head">
          <h2>生成新章</h2>
          <RouterLink :to="`/books/${bookId}/packing`" class="btn btn-ghost small">注入视图预览</RouterLink>
        </div>
        <div class="writing-generate">
          <select v-model.number="newChapterIdx" class="input select-input" :disabled="generatableChapters.length === 0">
            <option v-if="generatableChapters.length === 0" :value="null">没有可生成的章（需先批准章纲）</option>
            <option v-for="option in generatableChapters" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="generatableChapters.length === 0 || generating || newChapterIdx === null"
            @click="generate"
          >
            {{ generating ? `正在生成第 ${newChapterIdx} 章（prepare→draft→verify→fix→commit）……` : `生成第 ${newChapterIdx ?? '-'} 章` }}
          </button>
          <RouterLink :to="`/books/${bookId}/suspensions`" class="btn btn-ghost small">挂起队列</RouterLink>
          <RouterLink :to="`/books/${bookId}/metrics`" class="btn btn-ghost small">检测报告</RouterLink>
        </div>
        <p v-if="generatableChapters.length === 0" class="empty muted">
          没有已批准的章纲。先到两级大纲页规划并批准章纲，再回来生成。
        </p>
        <p v-if="generateError" class="error-text">{{ generateError }}</p>
      </section>

      <!-- 章节列表 -->
      <section class="panel">
        <div class="panel-head">
          <h2>章节（{{ chapters.length }}）</h2>
        </div>
        <div v-if="chapters.length === 0" class="empty muted">还没有生成过章节。</div>
        <div v-else class="writing-list">
          <button
            v-for="item in chapters"
            :key="item.idx"
            type="button"
            class="writing-row"
            :class="{ 'writing-row-active': item.idx === selectedIdx }"
            @click="select(item.idx)"
          >
            <span class="writing-row-title">第{{ item.idx }}章 {{ item.title }}</span>
            <span class="muted small">{{ item.charCount }} 字 · {{ formatTime(item.updatedAt) }}</span>
            <span v-if="item.run" class="chip chip-static" :class="{ 'writing-chip-failed': item.run.status === 'failed' }">
              {{ PIPELINE_STATUS_LABELS[item.run.status] }} · {{ PIPELINE_STAGE_LABELS[item.run.stage] }}
            </span>
          </button>
        </div>
      </section>

      <template v-if="detail">
        <!-- 正文阅读 / 编辑 -->
        <section class="panel">
          <div class="panel-head">
            <h2>第{{ detail.chapter.idx }}章 {{ detail.chapter.title }}</h2>
            <span class="muted small">{{ detail.chapter.charCount }} 字 · 更新于 {{ formatTime(detail.chapter.updatedAt) }}</span>
          </div>
          <p v-if="detailRun && detailRun.status === 'suspended'" class="error-text">
            本章已挂起（fix 重写轮次用尽或语义核查发现事实矛盾），需到
            <RouterLink :to="`/books/${bookId}/suspensions`">挂起队列</RouterLink>
            裁决后才能提交；管线未完成期间正文编辑被冻结。
          </p>
          <p v-else-if="detailRun && detailRun.status !== 'done'" class="error-text">
            生成管线未完成（{{ PIPELINE_STATUS_LABELS[detailRun.status] }}，阶段：{{ PIPELINE_STAGE_LABELS[detailRun.stage] }}）{{ detailRun.error ? `：${detailRun.error}` : '' }}。再次点「生成」会从断点续跑。
          </p>
          <textarea v-model="editorContent" class="input writing-editor" rows="16" spellcheck="false"></textarea>
          <div class="writing-editor-foot">
            <span class="muted small">
              {{ editorDirty ? '有未保存修改' : '与已保存版本一致' }} · 保存会生成「人工编辑」快照，滚动摘要同步重算
            </span>
            <button class="btn btn-primary" type="button" :disabled="!editorDirty || saving" @click="saveEdit">
              {{ saving ? '保存中……' : '保存正文' }}
            </button>
          </div>
          <p v-if="actionError" class="error-text">{{ actionError }}</p>
        </section>

        <!-- 版本快照 -->
        <section class="panel">
          <div class="panel-head">
            <h2>版本快照（{{ detail.snapshots.length }}）</h2>
            <span class="muted small">最新在前 · 回退会把当前正文存为新快照</span>
          </div>
          <div v-if="detail.snapshots.length === 0" class="empty muted">还没有快照。</div>
          <div v-else class="writing-list">
            <div v-for="snapshot in detail.snapshots" :key="snapshot.id" class="writing-row writing-row-static">
              <span class="chip chip-static">{{ SNAPSHOT_SOURCE_LABELS[snapshot.source] }}</span>
              <span class="muted small">{{ formatTime(snapshot.createdAt) }} · {{ snapshot.content.length }} 字</span>
              <span class="muted small snapshot-summary">{{ snapshot.summary }}</span>
              <button class="btn btn-ghost small" type="button" @click="revert(snapshot.id)">回退到此版</button>
            </div>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api, errorMessage } from '../api';
import type { Book, ChapterOutline, OutlineStatus, OutlineTree, Volume } from '../types';
import { OUTLINE_STATUS_LABELS } from '../types';
import OutlineEditor from '../components/OutlineEditor.vue';
import ExpansionPicker from '../components/ExpansionPicker.vue';

const route = useRoute();
const bookId = computed(() => Number(route.params.id));

const book = ref<Book | null>(null);
const tree = ref<OutlineTree>({ volumes: [] });
const loading = ref(true);
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);

/** 编辑器会话：卷/章的新建或编辑 */
type EditorSession =
  | { kind: 'volume'; mode: 'create' }
  | { kind: 'volume'; mode: 'edit'; volume: Volume }
  | { kind: 'chapter'; mode: 'create'; volume: Volume }
  | { kind: 'chapter'; mode: 'edit'; volume: Volume; chapter: ChapterOutline };

const editor = ref<EditorSession | null>(null);
const editorSaving = ref(false);
const editorError = ref<string | null>(null);
const expanding = ref<ChapterOutline | null>(null);

const transitioning = ref<number | null>(null);

const editorHeading = computed(() => {
  const session = editor.value;
  if (!session) return '';
  if (session.kind === 'volume') return session.mode === 'create' ? '新增卷纲' : `编辑卷纲 · ${session.volume.title}`;
  return session.mode === 'create' ? `新增章纲 · ${session.volume.title}` : `编辑章纲 · ${session.chapter.title}`;
});

const editorInitialTitle = computed(() => {
  const session = editor.value;
  if (!session) return '';
  if (session.kind === 'volume') return session.mode === 'edit' ? session.volume.title : '';
  return session.mode === 'edit' ? session.chapter.title : '';
});

const editorInitialSummary = computed(() => {
  const session = editor.value;
  if (!session) return '';
  if (session.kind === 'volume') return session.mode === 'edit' ? session.volume.summary : '';
  return session.mode === 'edit' ? session.chapter.summary : '';
});

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
    tree.value = await api.get<OutlineTree>(`/api/books/${id}/outlines`);
  } catch (cause) {
    loadError.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

/** 章在书内的全局序号（跨卷累计），便于对照全书章序 */
function globalChapterNo(volumeIndex: number, chapterIndex: number): number {
  let no = chapterIndex + 1;
  for (let i = 0; i < volumeIndex; i++) no += tree.value.volumes[i]!.chapters.length;
  return no;
}

function openVolumeEditor(mode: 'create' | 'edit', volume?: Volume) {
  editorError.value = null;
  editor.value = mode === 'create' ? { kind: 'volume', mode } : { kind: 'volume', mode, volume: volume! };
}

function openChapterEditor(mode: 'create' | 'edit', volume: Volume, chapter?: ChapterOutline) {
  editorError.value = null;
  editor.value =
    mode === 'create' ? { kind: 'chapter', mode, volume } : { kind: 'chapter', mode, volume, chapter: chapter! };
}

async function saveEditor(value: { title: string; summary: string }) {
  const session = editor.value;
  if (!session) return;
  editorSaving.value = true;
  editorError.value = null;
  try {
    if (session.kind === 'volume') {
      if (session.mode === 'create') {
        await api.post(`/api/books/${bookId.value}/outlines/volumes`, value);
      } else {
        await api.patch(`/api/books/${bookId.value}/outlines/volumes/${session.volume.id}`, value);
      }
    } else {
      if (session.mode === 'create') {
        await api.post(`/api/books/${bookId.value}/outlines/volumes/${session.volume.id}/chapters`, value);
      } else {
        await api.patch(`/api/books/${bookId.value}/outlines/chapters/${session.chapter.id}`, value);
      }
    }
    editor.value = null;
    await load();
  } catch (cause) {
    editorError.value = errorMessage(cause);
  } finally {
    editorSaving.value = false;
  }
}

/** 状态流转：草稿→已批准→锁定；锁定后仅可显式解锁。锁定/解锁是显式操作，需确认 */
async function transition(chapter: ChapterOutline, to: OutlineStatus) {
  if (to === 'locked' && !window.confirm(`锁定「${chapter.title}」？锁定的章纲不可再被编辑或删除，解锁需显式操作。`)) return;
  if (to === 'approved' && chapter.status === 'locked' && !window.confirm(`解锁「${chapter.title}」？解锁后回到已批准态，可继续编辑。`)) return;

  actionError.value = null;
  transitioning.value = chapter.id;
  try {
    await api.post(`/api/books/${bookId.value}/outlines/chapters/${chapter.id}/status`, { status: to });
    await load();
  } catch (cause) {
    actionError.value = errorMessage(cause);
  } finally {
    transitioning.value = null;
  }
}

async function removeVolume(volume: Volume) {
  if (!window.confirm(`删除卷纲「${volume.title}」？其下全部章纲将一并删除（含锁定章纲时会被拒绝）。`)) return;
  actionError.value = null;
  try {
    await api.delete(`/api/books/${bookId.value}/outlines/volumes/${volume.id}`);
    await load();
  } catch (cause) {
    actionError.value = errorMessage(cause);
  }
}

async function removeChapter(chapter: ChapterOutline) {
  if (!window.confirm(`删除章纲「${chapter.title}」？`)) return;
  actionError.value = null;
  try {
    await api.delete(`/api/books/${bookId.value}/outlines/chapters/${chapter.id}`);
    await load();
  } catch (cause) {
    actionError.value = errorMessage(cause);
  }
}

// 同组件路由复用（/books/1/outline → /books/2/outline）时重载
watch(bookId, load);
onMounted(load);
</script>

<template>
  <div class="page">
    <header class="page-head">
      <RouterLink :to="`/books/${bookId}`" class="muted small">← 返回书详情</RouterLink>
      <h1>两级大纲<template v-if="book"> · {{ book.title }}</template></h1>
      <p class="page-sub">卷纲承载叙事弧线，章纲挂在卷下；章纲经「草稿→已批准→锁定」流转，锁定后生成管线与编辑均不可改动，解锁需显式操作。</p>
    </header>

    <div v-if="loading" class="panel muted">加载中……</div>
    <div v-else-if="loadError" class="panel error-text">{{ loadError }}</div>
    <template v-else>
      <section class="panel">
        <div class="panel-head">
          <h2>卷纲（{{ tree.volumes.length }}）</h2>
          <button class="btn btn-primary" type="button" @click="openVolumeEditor('create')">新增卷纲</button>
        </div>
        <p v-if="actionError" class="error-text">{{ actionError }}</p>
        <div v-if="tree.volumes.length === 0" class="empty muted">
          还没有卷纲。先建第一卷，再在卷下逐章铺排章纲；章纲可让 AI 给多个展开方案供你挑选。
        </div>
      </section>

      <section v-for="(volume, volumeIndex) in tree.volumes" :key="volume.id" class="panel">
        <div class="panel-head">
          <div>
            <h2>第{{ volumeIndex + 1 }}卷 · {{ volume.title }}</h2>
            <p v-if="volume.summary" class="muted">{{ volume.summary }}</p>
          </div>
          <div class="outline-actions">
            <button class="btn" type="button" @click="openChapterEditor('create', volume)">新增章纲</button>
            <button class="btn" type="button" @click="openVolumeEditor('edit', volume)">编辑卷</button>
            <button class="btn btn-danger-ghost" type="button" @click="removeVolume(volume)">删除卷</button>
          </div>
        </div>

        <div v-if="volume.chapters.length === 0" class="empty muted">本卷还没有章纲。</div>
        <div v-else class="outline-chapter-list">
          <article
            v-for="(chapter, chapterIndex) in volume.chapters"
            :key="chapter.id"
            class="outline-chapter"
            :class="{ 'outline-chapter-locked': chapter.status === 'locked' }"
          >
            <div class="outline-chapter-head">
              <span class="chip chip-static">第{{ globalChapterNo(volumeIndex, chapterIndex) }}章</span>
              <strong class="outline-chapter-title">{{ chapter.title }}</strong>
              <span class="badge" :class="`badge-status-${chapter.status}`">{{ OUTLINE_STATUS_LABELS[chapter.status] }}</span>
              <div class="outline-chapter-actions">
                <button class="btn" type="button" :disabled="chapter.status === 'locked'" @click="expanding = chapter">
                  AI 展开
                </button>
                <button
                  class="btn"
                  type="button"
                  :disabled="chapter.status === 'locked'"
                  @click="openChapterEditor('edit', volume, chapter)"
                >
                  编辑
                </button>
                <button
                  v-if="chapter.status === 'draft'"
                  class="btn"
                  type="button"
                  :disabled="transitioning === chapter.id"
                  @click="transition(chapter, 'approved')"
                >
                  批准
                </button>
                <button
                  v-if="chapter.status === 'approved'"
                  class="btn"
                  type="button"
                  :disabled="transitioning === chapter.id"
                  @click="transition(chapter, 'locked')"
                >
                  锁定
                </button>
                <button
                  v-if="chapter.status === 'locked'"
                  class="btn"
                  type="button"
                  :disabled="transitioning === chapter.id"
                  @click="transition(chapter, 'approved')"
                >
                  解锁
                </button>
                <button
                  class="btn btn-danger-ghost"
                  type="button"
                  :disabled="chapter.status === 'locked'"
                  @click="removeChapter(chapter)"
                >
                  删除
                </button>
              </div>
            </div>
            <p v-if="chapter.summary" class="outline-chapter-summary">{{ chapter.summary }}</p>
            <p v-else class="muted small">暂无章纲内容。</p>
          </article>
        </div>
      </section>
    </template>

    <OutlineEditor
      v-if="editor"
      :heading="editorHeading"
      :initial-title="editorInitialTitle"
      :initial-summary="editorInitialSummary"
      :summary-label="editor.kind === 'volume' ? '卷纲概述（本卷叙事弧线）' : '章纲概要（本章剧情展开）'"
      :saving="editorSaving"
      :error="editorError"
      @saved="saveEditor"
      @cancel="editor = null"
    />
    <ExpansionPicker
      v-if="expanding"
      :book-id="bookId"
      :chapter="expanding"
      @applied="expanding = null; load()"
      @cancel="expanding = null"
    />
  </div>
</template>

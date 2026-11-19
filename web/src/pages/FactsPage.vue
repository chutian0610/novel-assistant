<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api, errorMessage } from '../api';
import type {
  Book,
  CharacterRelation,
  CharacterState,
  FactListResponse,
  ForeshadowStatus,
  ForeshadowView,
  TimelineEvent,
} from '../types';
import { CHARACTER_STATE_CATEGORY_LABELS, FORESHADOW_STATUS_LABELS } from '../types';
import CharacterGraph from '../components/CharacterGraph.vue';
import FactEditor, { type FactFormValue, type FactKind } from '../components/FactEditor.vue';

const route = useRoute();
const bookId = computed(() => Number(route.params.id));

const book = ref<Book | null>(null);
const characters = ref<CharacterState[]>([]);
const relations = ref<CharacterRelation[]>([]);
const timeline = ref<TimelineEvent[]>([]);
const foreshadows = ref<ForeshadowView[]>([]);

const loading = ref(true);
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);

/** 伏笔超期预警的判定基准：作者输入当前写到第几章（number 输入的 v-model 会给 number 或空串） */
const currentChapterInput = ref<string | number>('');

const editor = ref<{ kind: FactKind; mode: 'create' | 'edit'; record?: Record<string, unknown> } | null>(null);
const editorSaving = ref(false);
const editorError = ref<string | null>(null);
const transitioning = ref<number | null>(null);

const FACT_PATHS: Record<FactKind, string> = {
  character: 'facts/characters',
  relation: 'facts/relations',
  timeline: 'facts/timeline',
  foreshadow: 'facts/foreshadows',
};

const editorHeading = computed(() => {
  const session = editor.value;
  if (!session) return '';
  const nouns: Record<FactKind, string> = { character: '角色运行时', relation: '人物关系', timeline: '时间轴事件', foreshadow: '伏笔' };
  return session.mode === 'create' ? `新增${nouns[session.kind]}` : `编辑${nouns[session.kind]}`;
});

const editorInitial = computed<Partial<FactFormValue>>(() => {
  const record = editor.value?.record;
  if (!record) return {};
  const { id, bookId: _b, createdAt: _c, updatedAt: _u, status: _s, overdue: _o, ...rest } = record as Record<string, unknown>;
  return rest as Partial<FactFormValue>;
});

const overdueCount = computed(() => foreshadows.value.filter((item) => item.overdue).length);

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
    await loadFacts(id);
  } catch (cause) {
    loadError.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function loadFacts(id: number) {
  const [chars, rels, tl, fs] = await Promise.all([
    api.get<FactListResponse<CharacterState>>(`/api/books/${id}/facts/characters`),
    api.get<FactListResponse<CharacterRelation>>(`/api/books/${id}/facts/relations`),
    api.get<FactListResponse<TimelineEvent>>(`/api/books/${id}/facts/timeline`),
    api.get<FactListResponse<ForeshadowView>>(`/api/books/${id}/facts/foreshadows${foreshadowQuery()}`),
  ]);
  characters.value = chars.items;
  relations.value = rels.items;
  timeline.value = tl.items;
  foreshadows.value = fs.items;
}

function foreshadowQuery(): string {
  const raw = String(currentChapterInput.value ?? '').trim();
  return raw === '' ? '' : `?currentChapter=${encodeURIComponent(raw)}`;
}

// 当前章变化即时重装伏笔预警
watch(currentChapterInput, async () => {
  if (loading.value || loadError.value) return;
  try {
    const res = await api.get<FactListResponse<ForeshadowView>>(`/api/books/${bookId.value}/facts/foreshadows${foreshadowQuery()}`);
    foreshadows.value = res.items;
  } catch (cause) {
    actionError.value = errorMessage(cause);
  }
});

function openEditor(kind: FactKind, mode: 'create' | 'edit', record?: Record<string, unknown>) {
  editorError.value = null;
  editor.value = { kind, mode, record };
}

async function saveEditor(value: FactFormValue) {
  const session = editor.value;
  if (!session) return;
  editorSaving.value = true;
  editorError.value = null;
  const base = `/api/books/${bookId.value}/${FACT_PATHS[session.kind]}`;
  try {
    if (session.mode === 'create') {
      await api.post(base, value);
    } else {
      await api.patch(`${base}/${session.record!.id}`, value);
    }
    editor.value = null;
    await loadFacts(bookId.value);
  } catch (cause) {
    editorError.value = errorMessage(cause);
  } finally {
    editorSaving.value = false;
  }
}

async function removeFact(kind: FactKind, id: number, label: string) {
  if (!window.confirm(`删除${label}（#${id}）？`)) return;
  actionError.value = null;
  try {
    await api.delete(`/api/books/${bookId.value}/${FACT_PATHS[kind]}/${id}`);
    await loadFacts(bookId.value);
  } catch (cause) {
    actionError.value = errorMessage(cause);
  }
}

/** 伏笔状态流转：回收/放弃为终态，需确认 */
async function transitionForeshadow(item: ForeshadowView, to: ForeshadowStatus) {
  if ((to === 'resolved' || to === 'abandoned') && !window.confirm(`「${item.title}」将进入终态「${FORESHADOW_STATUS_LABELS[to]}」，不可再流转，确认？`)) return;
  actionError.value = null;
  transitioning.value = item.id;
  try {
    await api.post(`/api/books/${bookId.value}/facts/foreshadows/${item.id}/status`, { status: to });
    await loadFacts(bookId.value);
  } catch (cause) {
    actionError.value = errorMessage(cause);
  } finally {
    transitioning.value = null;
  }
}

function categoryLabel(category: string): string {
  return CHARACTER_STATE_CATEGORY_LABELS[category as keyof typeof CHARACTER_STATE_CATEGORY_LABELS] ?? category;
}

// 同组件路由复用（/books/1/facts → /books/2/facts）时重载
watch(bookId, load);
onMounted(load);
</script>

<template>
  <div class="page">
    <header class="page-head">
      <RouterLink :to="`/books/${bookId}`" class="muted small">← 返回书详情</RouterLink>
      <h1>事实面板<template v-if="book"> · {{ book.title }}</template></h1>
      <p class="page-sub">事实是带时序的行：每条都带来源章与原文证据（ADR-0002）。本面板全部手动维护，章节落稿后由管线自动回灌（后续版本）。</p>
    </header>

    <div v-if="loading" class="panel muted">加载中……</div>
    <div v-else-if="loadError" class="panel error-text">{{ loadError }}</div>
    <template v-else>
      <p v-if="actionError" class="panel error-text">{{ actionError }}</p>

      <!-- 人物关系图 -->
      <section class="panel">
        <div class="panel-head">
          <h2>人物关系图（{{ relations.length }}）</h2>
          <button class="btn btn-primary" type="button" @click="openEditor('relation', 'create')">新增关系</button>
        </div>
        <CharacterGraph v-if="relations.length > 0" :relations="relations" />
        <div v-else class="empty muted">还没有人物关系。录入关系后此处自动成图（有向边：起始角色 → 指向角色）。</div>
        <ul v-if="relations.length > 0" class="fact-list">
          <li v-for="edge in relations" :key="edge.id" class="fact-item">
            <div class="fact-head">
              <strong>{{ edge.fromName }}</strong>
              <span class="fact-arrow">—{{ edge.relation }}→</span>
              <strong>{{ edge.toName }}</strong>
              <span class="chip chip-static">第{{ edge.chapter }}章</span>
              <span class="fact-actions">
                <button class="btn btn-ghost small" type="button" @click="openEditor('relation', 'edit', edge)">编辑</button>
                <button class="btn btn-danger-ghost small" type="button" @click="removeFact('relation', edge.id, '人物关系')">删除</button>
              </span>
            </div>
            <p class="fact-evidence">证据：{{ edge.evidence }}</p>
          </li>
        </ul>
      </section>

      <!-- 伏笔账本 -->
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>伏笔账本（{{ foreshadows.length }}）</h2>
            <p class="muted small">
              当前写到
              <input v-model="currentChapterInput" class="input chapter-input" type="number" min="1" placeholder="章号" />
              章 —— 超过目标章仍未回收的伏笔红色预警<template v-if="overdueCount > 0"><strong class="error-text">（当前 {{ overdueCount }} 条超期）</strong></template>。
            </p>
          </div>
          <button class="btn btn-primary" type="button" @click="openEditor('foreshadow', 'create')">登记伏笔</button>
        </div>
        <div v-if="foreshadows.length === 0" class="empty muted">账本空空如也。埋下伏笔就登记，超过目标章未回收会预警。</div>
        <ul v-else class="fact-list">
          <li v-for="item in foreshadows" :key="item.id" class="fact-item" :class="{ 'fact-item-overdue': item.overdue }">
            <div class="fact-head">
              <strong>{{ item.title }}</strong>
              <span class="badge" :class="`badge-foreshadow-${item.status}`">{{ FORESHADOW_STATUS_LABELS[item.status] }}</span>
              <span class="chip chip-static">第{{ item.plantedChapter }}章埋设 · 目标第{{ item.targetChapter }}章</span>
              <span v-if="item.overdue" class="overdue-flag">超期未回收</span>
              <span class="fact-actions">
                <button
                  v-if="item.status === 'planted'"
                  class="btn small"
                  type="button"
                  :disabled="transitioning === item.id"
                  @click="transitionForeshadow(item, 'progressing')"
                >
                  推进
                </button>
                <button
                  v-if="item.status === 'planted' || item.status === 'progressing'"
                  class="btn small"
                  type="button"
                  :disabled="transitioning === item.id"
                  @click="transitionForeshadow(item, 'resolved')"
                >
                  回收
                </button>
                <button
                  v-if="item.status === 'planted' || item.status === 'progressing'"
                  class="btn btn-danger-ghost small"
                  type="button"
                  :disabled="transitioning === item.id"
                  @click="transitionForeshadow(item, 'abandoned')"
                >
                  放弃
                </button>
                <button class="btn btn-ghost small" type="button" @click="openEditor('foreshadow', 'edit', item)">编辑</button>
                <button class="btn btn-danger-ghost small" type="button" @click="removeFact('foreshadow', item.id, '伏笔')">删除</button>
              </span>
            </div>
            <p v-if="item.content" class="fact-content">{{ item.content }}</p>
            <p class="fact-evidence">证据：{{ item.evidence }}</p>
          </li>
        </ul>
      </section>

      <!-- 角色运行时 -->
      <section class="panel">
        <div class="panel-head">
          <h2>角色运行时（{{ characters.length }}）</h2>
          <button class="btn btn-primary" type="button" @click="openEditor('character', 'create')">登记状态</button>
        </div>
        <div v-if="characters.length === 0" class="empty muted">还没有角色动态状态（伤势/秘密/持有物/境界）。静态角色设定放素材库设定卡，这里只记"此时此刻"。</div>
        <ul v-else class="fact-list">
          <li v-for="item in characters" :key="item.id" class="fact-item">
            <div class="fact-head">
              <strong>{{ item.name }}</strong>
              <span class="badge badge-type">{{ categoryLabel(item.category) }}</span>
              <span class="chip chip-static">第{{ item.chapter }}章</span>
              <span class="fact-actions">
                <button class="btn btn-ghost small" type="button" @click="openEditor('character', 'edit', item)">编辑</button>
                <button class="btn btn-danger-ghost small" type="button" @click="removeFact('character', item.id, '角色运行时')">删除</button>
              </span>
            </div>
            <p class="fact-content">{{ item.content }}</p>
            <p class="fact-evidence">证据：{{ item.evidence }}</p>
          </li>
        </ul>
      </section>

      <!-- 时间轴 -->
      <section class="panel">
        <div class="panel-head">
          <h2>时间轴（{{ timeline.length }}）</h2>
          <button class="btn btn-primary" type="button" @click="openEditor('timeline', 'create')">登记事件</button>
        </div>
        <div v-if="timeline.length === 0" class="empty muted">还没有时间轴事件。按叙事时序登记关键事件，避免后期时间线混乱。</div>
        <ol v-else class="fact-list">
          <li v-for="item in timeline" :key="item.id" class="fact-item">
            <div class="fact-head">
              <span class="chip chip-static">第{{ item.chapter }}章</span>
              <strong>{{ item.title }}</strong>
              <span class="fact-actions">
                <button class="btn btn-ghost small" type="button" @click="openEditor('timeline', 'edit', item)">编辑</button>
                <button class="btn btn-danger-ghost small" type="button" @click="removeFact('timeline', item.id, '时间轴事件')">删除</button>
              </span>
            </div>
            <p v-if="item.content" class="fact-content">{{ item.content }}</p>
            <p class="fact-evidence">证据：{{ item.evidence }}</p>
          </li>
        </ol>
      </section>
    </template>

    <FactEditor
      v-if="editor"
      :kind="editor.kind"
      :heading="editorHeading"
      :initial="editorInitial"
      :saving="editorSaving"
      :error="editorError"
      @saved="saveEditor"
      @cancel="editor = null"
    />
  </div>
</template>

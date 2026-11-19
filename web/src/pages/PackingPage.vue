<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api, errorMessage } from '../api';
import type { Book, InjectionView, OutlineTree, PackingItem } from '../types';

const route = useRoute();
const bookId = computed(() => Number(route.params.id));

// 服务端 DEFAULT_BUDGET_TOKENS 的镜像值（packing 模块）
const DEFAULT_BUDGET_TOKENS = 8000;

const book = ref<Book | null>(null);
const outlineTree = ref<OutlineTree | null>(null);
const view = ref<InjectionView | null>(null);

const loading = ref(true);
const loadError = ref<string | null>(null);
const packError = ref<string | null>(null);

const chapter = ref(1);
const budgetInput = ref<string | number>(DEFAULT_BUDGET_TOKENS);

const REF_TYPE_LABELS: Record<PackingItem['refType'], string> = {
  'book-contract': '书契约',
  'volume-outline': '卷纲',
  'chapter-outline': '章纲',
  'character-state': '角色运行时',
  material: '素材',
};

/** 章选项 = 大纲树扁平序（卷序 + 卷内序），序号即章号（packing 的章纲映射规则） */
const chapterOptions = computed(() => {
  const options: { value: number; label: string }[] = [];
  let ordinal = 0;
  for (const volume of outlineTree.value?.volumes ?? []) {
    for (const outline of volume.chapters) {
      ordinal += 1;
      options.push({ value: ordinal, label: `${ordinal} · ${volume.title} / ${outline.title}` });
    }
  }
  return options;
});

const budget = computed(() => {
  const value = Number(budgetInput.value);
  return Number.isInteger(value) && value >= 1 ? value : null;
});

function percentOf(tokens: number): string {
  if (!view.value || view.value.budgetTokens <= 0) return '0';
  return ((tokens / view.value.budgetTokens) * 100).toFixed(1).replace(/\.0$/, '');
}

async function pack() {
  if (chapterOptions.value.length === 0 || budget.value === null) return;
  packError.value = null;
  try {
    view.value = await api.get<InjectionView>(
      `/api/books/${bookId.value}/packing?chapter=${chapter.value}&budget=${budget.value}`
    );
  } catch (cause) {
    view.value = null;
    packError.value = errorMessage(cause);
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
    if (chapterOptions.value.length === 0) {
      chapter.value = 1;
      view.value = null;
      packError.value = null;
    } else {
      if (!chapterOptions.value.some((option) => option.value === chapter.value)) chapter.value = 1;
      await pack();
    }
  } catch (cause) {
    loadError.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

// 预算可调即时重装（预算输入防抖 300ms，章节切换即时）
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
watch([chapter, budget], ([, newBudget], [, oldBudget]) => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(pack, newBudget !== oldBudget ? 300 : 0);
});
onUnmounted(() => clearTimeout(debounceTimer));

// 同组件路由复用（/books/1/packing → /books/2/packing）时重载
watch(bookId, load);
onMounted(load);
</script>

<template>
  <div class="page">
    <header class="page-head">
      <RouterLink :to="`/books/${bookId}`" class="muted small">← 返回书详情</RouterLink>
      <h1>注入视图预览<template v-if="book"> · {{ book.title }}</template></h1>
      <p class="page-sub">
        装填进 prompt 的子集：必带层（书契约 / 本章大纲 / 出场角色运行时）永不丢失，相关性层按相关度选材、按预算截断，
        注入一律按章节号升序（ADR-0002）。全量库与注入视图严格分离。
      </p>
    </header>

    <div v-if="loading" class="panel muted">加载中……</div>
    <div v-else-if="loadError" class="panel error-text">{{ loadError }}</div>
    <template v-else>
      <!-- 装填控制：章节 + 预算，改动即时重装 -->
      <section class="panel">
        <div class="pack-controls">
          <label class="pack-field">
            <span class="muted small">目标章</span>
            <select v-model.number="chapter" class="input" :disabled="chapterOptions.length === 0">
              <option v-if="chapterOptions.length === 0" :value="1">本书还没有章纲</option>
              <option v-for="option in chapterOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <label class="pack-field">
            <span class="muted small">token 预算（默认 {{ DEFAULT_BUDGET_TOKENS }}）</span>
            <input v-model="budgetInput" class="input pack-budget-input" type="number" min="1" max="1000000" step="100" />
          </label>
          <div v-if="view" class="pack-summary">
            <div class="pack-summary-line">
              <span>已装 <strong>{{ view.usedTokens }}</strong> / 预算 {{ view.budgetTokens }} tok</span>
              <span v-if="view.overBudget" class="pack-over-flag">必带层超出预算（必带层永不截断）</span>
            </div>
            <div class="pack-bar">
              <div
                class="pack-bar-fill"
                :class="{ 'pack-bar-over': view.overBudget }"
                :style="{ width: Math.min(100, (view.usedTokens / view.budgetTokens) * 100) + '%' }"
              ></div>
            </div>
          </div>
        </div>
        <p v-if="chapterOptions.length === 0" class="empty muted">
          本书还没有章纲。先到两级大纲页规划卷纲与章纲，再回来预览注入视图。
        </p>
        <p v-else-if="budget === null" class="muted small">预算应为 ≥1 的整数，修正后自动重装。</p>
        <p v-if="packError" class="error-text">{{ packError }}</p>
      </section>

      <!-- 分层装填清单 -->
      <template v-if="view">
        <section v-for="layer in view.layers" :key="layer.key" class="panel pack-layer" :class="`pack-layer-${layer.kind}`">
          <div class="panel-head">
            <h2>
              {{ layer.label }}
              <span class="chip chip-static">{{ layer.kind === 'must' ? '必带层' : '相关性层' }}</span>
              <span v-if="layer.truncated" class="chip chip-static pack-chip-warn">已截断 · 放下 {{ layer.droppedCount }} 条</span>
            </h2>
            <span class="muted small">{{ layer.tokens }} tok · 占预算 {{ percentOf(layer.tokens) }}%</span>
          </div>
          <div v-if="layer.items.length === 0" class="empty muted">
            <template v-if="layer.key === 'characters'">本章之前没有角色运行时记录。</template>
            <template v-else-if="layer.key === 'relevance' && layer.truncated">候选素材都被预算放下，调大预算即可装回。</template>
            <template v-else-if="layer.key === 'relevance'">没有命中书内引用素材（可在书详情页引用素材进书）。</template>
            <template v-else>本层为空。</template>
          </div>
          <ul v-else class="pack-items">
            <li v-for="(item, index) in layer.items" :key="`${item.refType}-${item.refId}-${index}`" class="pack-item">
              <div class="pack-item-head">
                <strong>{{ item.title }}</strong>
                <span class="chip chip-static">{{ REF_TYPE_LABELS[item.refType] }}</span>
                <span v-if="item.sourceChapter !== null" class="chip chip-static">第{{ item.sourceChapter }}章</span>
                <span v-if="item.rank !== undefined" class="chip chip-static">相关度 #{{ item.rank }}</span>
                <span class="pack-item-tokens muted small">{{ item.tokens }} tok</span>
              </div>
              <p class="pack-item-text">{{ item.text }}</p>
            </li>
          </ul>
        </section>
      </template>
    </template>
  </div>
</template>

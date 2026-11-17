<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api, errorMessage } from '../api';
import { MATERIAL_TYPE_LABELS, type Material, type MaterialListResponse, type TagCount } from '../types';
import MaterialCard from '../components/MaterialCard.vue';
import MaterialEditor from '../components/MaterialEditor.vue';

const PAGE_SIZE = 50;

const filters = reactive({
  type: '',
  tag: '',
  q: '',
  appliedQ: '',
});
const items = ref<Material[]>([]);
const total = ref(0);
const tags = ref<TagCount[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const editorVisible = ref(false);
const editing = ref<Material | null>(null);

async function reloadTags() {
  try {
    tags.value = await api.get<TagCount[]>('/api/tags');
  } catch {
    tags.value = [];
  }
}

async function load(offset = 0) {
  loading.value = true;
  loadError.value = null;
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (filters.type !== '') params.set('type', filters.type);
    if (filters.tag !== '') params.set('tag', filters.tag);
    if (filters.appliedQ !== '') params.set('q', filters.appliedQ);
    const res = await api.get<MaterialListResponse>(`/api/materials?${params.toString()}`);
    items.value = offset === 0 ? res.items : [...items.value, ...res.items];
    total.value = res.total;
  } catch (cause) {
    loadError.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

function search() {
  filters.appliedQ = filters.q.trim();
  load(0);
}

function openCreate() {
  editing.value = null;
  editorVisible.value = true;
}

function openEdit(material: Material) {
  editing.value = material;
  editorVisible.value = true;
}

async function onSaved() {
  editorVisible.value = false;
  await Promise.all([load(0), reloadTags()]);
}

async function remove(material: Material) {
  if (!window.confirm(`确定删除素材「${material.title}」？`)) return;
  try {
    await api.delete(`/api/materials/${material.id}`);
    await Promise.all([load(0), reloadTags()]);
  } catch (cause) {
    window.alert(errorMessage(cause));
  }
}

onMounted(async () => {
  await Promise.all([load(0), reloadTags()]);
});
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1>素材库</h1>
      <p class="page-sub">设定卡 / 桥段 / 文风样本 / 书骨骼的全局素材库，支持标签与中文全文搜索。</p>
    </header>

    <section class="panel">
      <div class="filter-bar">
        <select v-model="filters.type" class="select" aria-label="按类型筛选" @change="load(0)">
          <option value="">全部类型</option>
          <option v-for="(label, type) in MATERIAL_TYPE_LABELS" :key="type" :value="type">{{ label }}</option>
        </select>
        <select v-model="filters.tag" class="select" aria-label="按标签筛选" @change="load(0)">
          <option value="">全部标签</option>
          <option v-for="tag in tags" :key="tag.name" :value="tag.name">{{ tag.name }}（{{ tag.count }}）</option>
        </select>
        <input
          v-model="filters.q"
          class="input filter-search"
          type="text"
          placeholder="全文搜索标题/正文/标签……"
          @keydown.enter="search"
        />
        <button class="btn" type="button" @click="search">搜索</button>
        <button class="btn btn-primary filter-create" type="button" @click="openCreate">新增素材</button>
      </div>
    </section>

    <section class="panel">
      <div v-if="loading && items.length === 0" class="muted">加载中……</div>
      <div v-else-if="loadError" class="error-text">{{ loadError }}</div>
      <div v-else-if="items.length === 0" class="empty muted">
        没有符合条件的素材，点击「新增素材」开始积累创作原料。
      </div>
      <template v-else>
        <div class="material-list">
          <MaterialCard
            v-for="material in items"
            :key="material.id"
            :material="material"
            @edit="openEdit(material)"
            @remove="remove(material)"
          />
        </div>
        <div v-if="items.length < total" class="load-more">
          <button class="btn" type="button" :disabled="loading" @click="load(items.length)">
            {{ loading ? '加载中……' : `加载更多（已加载 ${items.length}/${total}）` }}
          </button>
        </div>
        <div v-else class="muted small load-more">共 {{ total }} 条素材</div>
      </template>
    </section>

    <MaterialEditor v-if="editorVisible" :material="editing" @saved="onSaved" @cancel="editorVisible = false" />
  </div>
</template>

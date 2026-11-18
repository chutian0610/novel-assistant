<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api, errorMessage } from '../api';
import { MATERIAL_TYPE_LABELS, type Material, type MaterialListResponse } from '../types';

const props = defineProps<{ excludedIds: number[] }>();
const emit = defineEmits<{ add: [material: Material]; close: [] }>();

const PAGE_SIZE = 50;

const filters = reactive({ type: '', q: '', appliedQ: '' });
const items = ref<Material[]>([]);
const total = ref(0);
const loading = ref(true);
const loadError = ref<string | null>(null);

function isReferenced(material: Material): boolean {
  return props.excludedIds.includes(material.id);
}

async function load(offset = 0) {
  loading.value = true;
  loadError.value = null;
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (filters.type !== '') params.set('type', filters.type);
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

onMounted(() => load(0));
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal-panel modal-wide">
      <div class="panel-head">
        <h3>从素材库挑选素材引用进书</h3>
        <button class="btn btn-ghost" type="button" @click="emit('close')">关闭</button>
      </div>

      <div class="filter-bar picker-filter">
        <select v-model="filters.type" class="select" aria-label="按类型筛选" @change="load(0)">
          <option value="">全部类型</option>
          <option v-for="(label, type) in MATERIAL_TYPE_LABELS" :key="type" :value="type">{{ label }}</option>
        </select>
        <input
          v-model="filters.q"
          class="input filter-search"
          type="text"
          placeholder="搜索标题/正文/标签……"
          @keydown.enter="search"
        />
        <button class="btn" type="button" @click="search">搜索</button>
      </div>

      <div v-if="loading && items.length === 0" class="muted">加载中……</div>
      <div v-else-if="loadError" class="error-text">{{ loadError }}</div>
      <div v-else-if="items.length === 0" class="empty muted">没有符合条件的素材，先去素材库积累原料吧。</div>
      <ul v-else class="picker-list">
        <li v-for="material in items" :key="material.id" class="picker-row">
          <div class="picker-main">
            <span class="badge badge-type">{{ MATERIAL_TYPE_LABELS[material.type] }}</span>
            <span class="picker-title">{{ material.title }}</span>
            <span class="muted small picker-content">{{ material.content }}</span>
          </div>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="isReferenced(material)"
            @click="emit('add', material)"
          >
            {{ isReferenced(material) ? '已引用' : '引用进书' }}
          </button>
        </li>
      </ul>
      <div v-if="items.length < total" class="load-more">
        <button class="btn" type="button" :disabled="loading" @click="load(items.length)">
          {{ loading ? '加载中……' : `加载更多（已加载 ${items.length}/${total}）` }}
        </button>
      </div>
    </div>
  </div>
</template>

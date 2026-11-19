<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api, errorMessage } from '../api';
import type { Book, BookMaterialItem, BookMaterialListResponse } from '../types';
import BookEditor from '../components/BookEditor.vue';
import MaterialPicker from '../components/MaterialPicker.vue';
import OverrideEditor from '../components/OverrideEditor.vue';
import BookMaterialCard from '../components/BookMaterialCard.vue';

const route = useRoute();
const bookId = computed(() => Number(route.params.id));

const book = ref<Book | null>(null);
const items = ref<BookMaterialItem[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);

const editorVisible = ref(false);
const pickerVisible = ref(false);
const overriding = ref<BookMaterialItem | null>(null);

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
    items.value = (await api.get<BookMaterialListResponse>(`/api/books/${id}/materials`)).items;
  } catch (cause) {
    loadError.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function addMaterial(id: number) {
  actionError.value = null;
  try {
    await api.post(`/api/books/${bookId.value}/materials`, { materialId: id });
    pickerVisible.value = false;
    await load();
  } catch (cause) {
    actionError.value = errorMessage(cause);
  }
}

async function removeReference(item: BookMaterialItem) {
  if (!window.confirm(`移除「${item.effective.title}」的书内引用？全局素材库不受影响。`)) return;
  actionError.value = null;
  try {
    await api.delete(`/api/books/${bookId.value}/materials/${item.materialId}`);
    await load();
  } catch (cause) {
    actionError.value = errorMessage(cause);
  }
}

// 同组件路由复用（/books/1 → /books/2）时重载
watch(bookId, load);
onMounted(load);
</script>

<template>
  <div class="page">
    <header class="page-head">
      <RouterLink to="/books" class="muted small">← 返回书架</RouterLink>
      <h1 v-if="book">{{ book.title }}</h1>
      <h1 v-else>书详情</h1>
      <p v-if="book" class="page-sub">书内素材是全局库的引用子集：可覆写字段（不回写全局库），移除引用不删除素材。</p>
    </header>

    <div v-if="loading" class="panel muted">加载中……</div>
    <div v-else-if="loadError" class="panel error-text">{{ loadError }}</div>
    <template v-else-if="book">
      <section class="panel">
        <div class="panel-head">
          <h2>书契约</h2>
          <div class="outline-actions">
            <RouterLink :to="`/books/${book.id}/outline`" class="btn">两级大纲</RouterLink>
            <RouterLink :to="`/books/${book.id}/facts`" class="btn">事实面板</RouterLink>
            <RouterLink :to="`/books/${book.id}/packing`" class="btn">注入视图</RouterLink>
            <button class="btn" type="button" @click="editorVisible = true">编辑书契约</button>
          </div>
        </div>
        <div class="contract-grid">
          <div class="contract-item">
            <span class="contract-label muted small">题材</span>
            <span>{{ book.genre || '—' }}</span>
          </div>
          <div class="contract-item">
            <span class="contract-label muted small">基调</span>
            <span>{{ book.tone || '—' }}</span>
          </div>
          <div class="contract-item contract-wide">
            <span class="contract-label muted small">承诺</span>
            <span class="contract-promise">{{ book.promise || '—' }}</span>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>书内素材（{{ items.length }}）</h2>
          <button class="btn btn-primary" type="button" @click="pickerVisible = true">从素材库引用</button>
        </div>
        <p v-if="actionError" class="error-text">{{ actionError }}</p>
        <div v-if="items.length === 0" class="empty muted">
          还没有引用素材。从全局素材库挑选设定卡/桥段/文风样本/书骨骼，构成本书的素材子集。
        </div>
        <div v-else class="material-list">
          <BookMaterialCard
            v-for="item in items"
            :key="item.materialId"
            :item="item"
            @override="overriding = item"
            @remove="removeReference(item)"
          />
        </div>
      </section>
    </template>

    <BookEditor v-if="editorVisible && book" :book="book" @saved="editorVisible = false; load()" @cancel="editorVisible = false" />
    <MaterialPicker
      v-if="pickerVisible"
      :excluded-ids="items.map((item) => item.materialId)"
      @add="addMaterial($event.id)"
      @close="pickerVisible = false"
    />
    <OverrideEditor
      v-if="overriding"
      :book-id="bookId"
      :item="overriding"
      @saved="overriding = null; load()"
      @cancel="overriding = null"
    />
  </div>
</template>

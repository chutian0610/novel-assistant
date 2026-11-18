<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, errorMessage } from '../api';
import type { ReferenceBook, ReferenceListResponse } from '../types';

const fileInput = ref<HTMLInputElement | null>(null);
const bookTitle = ref('');
const uploading = ref(false);
const uploadError = ref<string | null>(null);

const books = ref<ReferenceBook[]>([]);
const total = ref(0);
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    const res = await api.get<ReferenceListResponse>('/api/references');
    books.value = res.items;
    total.value = res.total;
  } catch (cause) {
    loadError.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function upload() {
  const file = fileInput.value?.files?.[0];
  if (!file) {
    uploadError.value = '请选择 txt 或 epub 文件';
    return;
  }
  const format = file.name.toLowerCase().endsWith('.epub') ? 'epub' : 'txt';
  const title = bookTitle.value.trim();
  if (format === 'txt' && title === '') {
    uploadError.value = 'txt 上传需要填写书名（epub 会自动读取元数据书名）';
    return;
  }
  const params = new URLSearchParams({ format });
  if (title !== '') params.set('title', title);
  uploading.value = true;
  uploadError.value = null;
  try {
    await api.postRaw(
      `/api/references?${params.toString()}`,
      file,
      format === 'epub' ? 'application/epub+zip' : 'text/plain; charset=utf-8'
    );
    bookTitle.value = '';
    if (fileInput.value) fileInput.value.value = '';
    await load();
  } catch (cause) {
    uploadError.value = errorMessage(cause);
  } finally {
    uploading.value = false;
  }
}

async function remove(book: ReferenceBook) {
  if (!window.confirm(`删除参考书「${book.title}」？章节与未处理的抽取条目一并删除，已入库素材不受影响。`)) return;
  try {
    await api.delete(`/api/references/${book.id}`);
    await load();
  } catch (cause) {
    window.alert(errorMessage(cause));
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1>拆书</h1>
      <p class="page-sub">上传 txt/epub 参考小说，自动分章后由 AI 逐章抽取四类素材，逐条确认后带溯源入素材库。</p>
    </header>

    <section class="panel">
      <div class="panel-head">
        <h2>上传参考书</h2>
      </div>
      <div class="filter-bar">
        <input ref="fileInput" class="input upload-file" type="file" accept=".txt,.epub" aria-label="选择参考书文件" />
        <input
          v-model="bookTitle"
          class="input filter-search"
          type="text"
          placeholder="书名（txt 必填，epub 可留空自动读取）"
        />
        <button class="btn btn-primary" type="button" :disabled="uploading" @click="upload">
          {{ uploading ? '上传解析中……' : '上传并分章' }}
        </button>
      </div>
      <p v-if="uploadError" class="error-text">{{ uploadError }}</p>
    </section>

    <section class="panel">
      <div class="filter-bar">
        <span class="muted small">共 {{ total }} 本参考书</span>
      </div>
      <div v-if="loading && books.length === 0" class="muted">加载中……</div>
      <div v-else-if="loadError" class="error-text">{{ loadError }}</div>
      <div v-else-if="books.length === 0" class="empty muted">还没有参考书，上传一本 txt/epub 开始拆书。</div>
      <div v-else class="material-list">
        <article v-for="book in books" :key="book.id" class="material-card">
          <div class="material-head">
            <span class="badge badge-type">{{ book.format.toUpperCase() }}</span>
            <h3 class="material-title">{{ book.title }}</h3>
            <div class="material-actions">
              <RouterLink :to="`/references/${book.id}`" class="btn btn-ghost">打开</RouterLink>
              <button class="btn btn-danger-ghost" type="button" @click="remove(book)">删除</button>
            </div>
          </div>
          <div class="material-foot">
            <span class="muted small">共 {{ book.chapterCount }} 章</span>
            <span class="muted small">已抽取 {{ book.extractedCount }}/{{ book.chapterCount }} 章</span>
            <span v-if="book.pendingItemCount > 0" class="chip chip-static accent-chip">{{ book.pendingItemCount }} 条待确认</span>
            <span class="muted small foot-time">上传于 {{ book.createdAt.slice(0, 16).replace('T', ' ') }}</span>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

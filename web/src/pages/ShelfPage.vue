<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, errorMessage } from '../api';
import type { Book, BookListResponse } from '../types';
import BookEditor from '../components/BookEditor.vue';

const PAGE_SIZE = 50;

const books = ref<Book[]>([]);
const total = ref(0);
const loading = ref(true);
const loadError = ref<string | null>(null);
const editorVisible = ref(false);
const editing = ref<Book | null>(null);

async function load(offset = 0) {
  loading.value = true;
  loadError.value = null;
  try {
    const res = await api.get<BookListResponse>(`/api/books?limit=${PAGE_SIZE}&offset=${offset}`);
    books.value = offset === 0 ? res.items : [...books.value, ...res.items];
    total.value = res.total;
  } catch (cause) {
    loadError.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  editorVisible.value = true;
}

function openEdit(book: Book) {
  editing.value = book;
  editorVisible.value = true;
}

async function remove(book: Book) {
  if (!window.confirm(`确定删除「${book.title}」？书内素材引用一并移除，全局素材库不受影响。`)) return;
  try {
    await api.delete(`/api/books/${book.id}`);
    await load(0);
  } catch (cause) {
    window.alert(errorMessage(cause));
  }
}

function contractChips(book: Book): string[] {
  return [book.genre, book.tone].filter((value) => value !== '');
}

onMounted(load);
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1>书架</h1>
      <p class="page-sub">每次连载是一本独立的书：题材/基调/承诺构成书契约，素材从全局库引用进书。</p>
    </header>

    <section class="panel">
      <div class="filter-bar">
        <span class="muted small">共 {{ total }} 本书</span>
        <button class="btn btn-primary filter-create" type="button" @click="openCreate">新建书</button>
      </div>
    </section>

    <section class="panel">
      <div v-if="loading && books.length === 0" class="muted">加载中……</div>
      <div v-else-if="loadError" class="error-text">{{ loadError }}</div>
      <div v-else-if="books.length === 0" class="empty muted">书架空空如也，点击「新建书」开始第一次连载。</div>
      <div v-else class="book-grid">
        <article v-for="book in books" :key="book.id" class="book-card">
          <div class="book-card-head">
            <h3 class="book-title">
              <RouterLink :to="`/books/${book.id}`" class="book-link">{{ book.title }}</RouterLink>
            </h3>
            <div class="material-actions">
              <button class="btn btn-ghost" type="button" @click="openEdit(book)">编辑</button>
              <button class="btn btn-danger-ghost" type="button" @click="remove(book)">删除</button>
            </div>
          </div>
          <div v-if="contractChips(book).length > 0" class="material-foot">
            <span v-for="chip in contractChips(book)" :key="chip" class="chip chip-static">{{ chip }}</span>
          </div>
          <p v-if="book.promise" class="book-promise muted">{{ book.promise }}</p>
          <div class="material-foot">
            <span class="muted small">{{ book.materialCount }} 条书内素材</span>
            <span class="muted small foot-time">更新于 {{ book.updatedAt.slice(0, 16).replace('T', ' ') }}</span>
          </div>
        </article>
      </div>
      <div v-if="books.length < total" class="load-more">
        <button class="btn" type="button" :disabled="loading" @click="load(books.length)">
          {{ loading ? '加载中……' : `加载更多（已加载 ${books.length}/${total}）` }}
        </button>
      </div>
    </section>

    <BookEditor v-if="editorVisible" :book="editing" @saved="editorVisible = false; load()" @cancel="editorVisible = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { api, errorMessage } from '../api';
import type { Book } from '../types';

const props = defineProps<{ book: Book | null }>();
const emit = defineEmits<{ saved: []; cancel: [] }>();

const isEdit = computed(() => props.book !== null);

const form = reactive({
  title: props.book?.title ?? '',
  genre: props.book?.genre ?? '',
  tone: props.book?.tone ?? '',
  promise: props.book?.promise ?? '',
});

const saving = ref(false);
const error = ref<string | null>(null);

async function submit() {
  if (form.title.trim() === '') {
    error.value = '请填写书名';
    return;
  }
  saving.value = true;
  error.value = null;
  const body = {
    title: form.title,
    genre: form.genre.trim(),
    tone: form.tone.trim(),
    promise: form.promise.trim(),
  };
  try {
    if (isEdit.value && props.book) {
      await api.patch(`/api/books/${props.book.id}`, body);
    } else {
      await api.post('/api/books', body);
    }
    emit('saved');
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('cancel')">
    <div class="modal-panel">
      <div class="panel-head">
        <h3>{{ isEdit ? '编辑书契约' : '新建书' }}</h3>
        <button class="btn btn-ghost" type="button" @click="emit('cancel')">关闭</button>
      </div>

      <form class="editor-form" @submit.prevent="submit">
        <label class="editor-label">书名
          <input v-model="form.title" class="input" type="text" placeholder="书名" />
        </label>

        <div class="form-grid">
          <label class="editor-label">题材
            <input v-model="form.genre" class="input" type="text" placeholder="如：东方玄幻 / 都市异能" />
          </label>
          <label class="editor-label">基调
            <input v-model="form.tone" class="input" type="text" placeholder="如：热血爽文 / 冷峻写实" />
          </label>
        </div>

        <label class="editor-label">承诺
          <textarea v-model="form.promise" class="input" rows="3" placeholder="对读者的核心承诺，如：主角稳步升级，无虐主，伏笔必回收"></textarea>
        </label>

        <p v-if="error" class="error-text">{{ error }}</p>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" :disabled="saving">{{ saving ? '保存中……' : '保存' }}</button>
          <button class="btn btn-ghost" type="button" @click="emit('cancel')">取消</button>
        </div>
      </form>
    </div>
  </div>
</template>

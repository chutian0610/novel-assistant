<script setup lang="ts">
import { ref } from 'vue';
import { api, errorMessage } from '../api';
import type { ChapterOutline, ExpansionOption, ExpansionResult } from '../types';

/**
 * 章纲 AI 多方案展开：对某章请求 outline 任务路由，一次给出 3-5 个展开方案；
 * 作者选定后由本组件直接写入章纲（选定写入），锁定章会被服务端 409 拒绝。
 */
const props = defineProps<{ bookId: number; chapter: ChapterOutline }>();
const emit = defineEmits<{ applied: []; cancel: [] }>();

const hint = ref('');
const options = ref<ExpansionOption[]>([]);
const model = ref('');
const loading = ref(false);
const applying = ref<number | null>(null);
const error = ref<string | null>(null);

async function generate() {
  loading.value = true;
  error.value = null;
  options.value = [];
  try {
    const result = await api.post<ExpansionResult>(
      `/api/books/${props.bookId}/outlines/chapters/${props.chapter.id}/expansions`,
      hint.value.trim() === '' ? {} : { hint: hint.value.trim() }
    );
    options.value = result.options;
    model.value = result.model;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function apply(option: ExpansionOption) {
  if (!window.confirm(`以方案 ${option.index}《${option.title}》覆写本章章纲？`)) return;
  applying.value = option.index;
  error.value = null;
  try {
    await api.patch(`/api/books/${props.bookId}/outlines/chapters/${props.chapter.id}`, {
      title: option.title,
      summary: option.summary,
    });
    emit('applied');
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    applying.value = null;
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('cancel')">
    <div class="modal-panel modal-wide">
      <div class="panel-head">
        <div>
          <h3>AI 展开方案 · {{ chapter.title }}</h3>
          <p class="muted small">一次给出 3-5 个差异化展开，选定后写入章纲（可再手动修改）。</p>
        </div>
        <button class="btn btn-ghost" type="button" @click="emit('cancel')">关闭</button>
      </div>

      <label class="editor-label">作者要求（可选）
        <textarea v-model="hint" class="input" rows="2" placeholder="如：前紧后松，章末留钩子；避免打斗戏"></textarea>
      </label>

      <div class="form-actions">
        <button class="btn btn-primary" type="button" :disabled="loading" @click="generate">
          {{ loading ? '生成中……' : options.length > 0 ? '重新生成' : '生成展开方案' }}
        </button>
        <span v-if="model" class="muted small">生效模型：{{ model }}</span>
      </div>

      <p v-if="error" class="error-text">{{ error }}</p>

      <div v-if="options.length > 0" class="expansion-list">
        <div v-for="option in options" :key="option.index" class="expansion-option">
          <div class="expansion-head">
            <span class="expansion-index">方案 {{ option.index }}</span>
            <strong class="expansion-title">{{ option.title }}</strong>
            <button
              class="btn btn-primary"
              type="button"
              :disabled="applying !== null"
              @click="apply(option)"
            >
              {{ applying === option.index ? '写入中……' : '采用此方案' }}
            </button>
          </div>
          <p class="expansion-summary">{{ option.summary }}</p>
        </div>
      </div>
      <div v-else-if="!loading && !error" class="empty muted">点击「生成展开方案」，AI 将结合书契约、卷纲与当前章纲给出方案。</div>
    </div>
  </div>
</template>

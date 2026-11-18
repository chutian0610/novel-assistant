<script setup lang="ts">
import { reactive, ref } from 'vue';

/** 卷纲/章纲共用的标题+概述编辑器；API 调用与错误状态由父组件管理 */
const props = defineProps<{
  heading: string;
  initialTitle: string;
  initialSummary: string;
  summaryLabel: string;
  saving: boolean;
  error: string | null;
}>();
const emit = defineEmits<{ saved: [value: { title: string; summary: string }]; cancel: [] }>();

const form = reactive({ title: props.initialTitle, summary: props.initialSummary });
const localError = ref<string | null>(null);

function submit() {
  if (form.title.trim() === '') {
    localError.value = '请填写标题';
    return;
  }
  localError.value = null;
  emit('saved', { title: form.title.trim(), summary: form.summary.trim() });
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('cancel')">
    <div class="modal-panel">
      <div class="panel-head">
        <h3>{{ heading }}</h3>
        <button class="btn btn-ghost" type="button" @click="emit('cancel')">关闭</button>
      </div>

      <form class="editor-form" @submit.prevent="submit">
        <label class="editor-label">标题
          <input v-model="form.title" class="input" type="text" placeholder="标题" />
        </label>

        <label class="editor-label">{{ summaryLabel }}
          <textarea v-model="form.summary" class="input" rows="6" placeholder="叙事概述"></textarea>
        </label>

        <p v-if="localError || error" class="error-text">{{ localError ?? error }}</p>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" :disabled="saving">{{ saving ? '保存中……' : '保存' }}</button>
          <button class="btn btn-ghost" type="button" @click="emit('cancel')">取消</button>
        </div>
      </form>
    </div>
  </div>
</template>

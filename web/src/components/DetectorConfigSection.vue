<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api, errorMessage } from '../api';
import type { DetectorConfig } from '../types';

const emit = defineEmits<{ changed: [] }>();

const loading = ref(true);
const saving = ref(false);
const saveError = ref<string | null>(null);
const saved = ref(false);

// 表单初值仅占位（与服务端默认值一致的写法副本），onMounted 加载后被库里的真实配置整体覆盖
const form = reactive<DetectorConfig>({
  lexicalDiversityThreshold: 0.55,
  sentenceLengthCVThreshold: 0.35,
  trigramRepetitionThreshold: 0.02,
  templatePhrasePerKiloWordThreshold: 2,
  punctuationCVMin: 0.3,
  punctuationCVMax: 0.65,
  dialogueRatioMin: 0.05,
  dialogueRatioMax: 0.65,
  emotionDensityMin: 0.003,
  emotionDensityMax: 0.06,
  semanticSmoothnessCVThreshold: 0.3,
});

/** 表单字段元信息：key →（标签、步长） */
const FIELDS: { key: keyof DetectorConfig; label: string; step: number }[] = [
  { key: 'lexicalDiversityThreshold', label: '词汇多样性下限（MATTR）', step: 0.01 },
  { key: 'sentenceLengthCVThreshold', label: '句长波动 CV 下限', step: 0.01 },
  { key: 'trigramRepetitionThreshold', label: '3-gram 重复率上限', step: 0.005 },
  { key: 'templatePhrasePerKiloWordThreshold', label: '模板套话每千词上限', step: 0.5 },
  { key: 'punctuationCVMin', label: '标点节奏 CV 下限', step: 0.01 },
  { key: 'punctuationCVMax', label: '标点节奏 CV 上限', step: 0.01 },
  { key: 'dialogueRatioMin', label: '对白比例下限', step: 0.01 },
  { key: 'dialogueRatioMax', label: '对白比例上限', step: 0.01 },
  { key: 'emotionDensityMin', label: '情绪密度下限', step: 0.001 },
  { key: 'emotionDensityMax', label: '情绪密度上限', step: 0.005 },
  { key: 'semanticSmoothnessCVThreshold', label: '语义平滑 CV 下限', step: 0.01 },
];

async function reload() {
  const config = await api.get<DetectorConfig>('/api/detectors/config');
  Object.assign(form, config);
}

async function save() {
  saving.value = true;
  saveError.value = null;
  saved.value = false;
  try {
    const payload = Object.fromEntries(FIELDS.map(({ key }) => [key, form[key]]));
    const updated = await api.put<DetectorConfig>('/api/detectors/config', payload);
    Object.assign(form, updated);
    saved.value = true;
    emit('changed');
  } catch (cause) {
    saveError.value = errorMessage(cause);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    await reload();
  } catch (cause) {
    saveError.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <h2>检测阈值</h2>
      <button class="btn btn-primary" type="button" :disabled="loading || saving" @click="save">
        {{ saving ? '保存中……' : '保存阈值' }}
      </button>
    </div>
    <p class="muted small">
      8 维检测器的达标阈值。检测工具页与章节管线的 verify 阶段（后续版本）共用同一套阈值；修改即时生效。
    </p>
    <div v-if="loading" class="muted">加载中……</div>
    <template v-else>
      <p v-if="saveError" class="error-text">{{ saveError }}</p>
      <p v-else-if="saved" class="ok-text">已保存。</p>
      <div class="detector-config-grid">
        <label v-for="field in FIELDS" :key="field.key" class="editor-label">
          {{ field.label }}
          <input v-model.number="form[field.key]" class="input" type="number" :step="field.step" :min="0" />
        </label>
      </div>
    </template>
  </section>
</template>

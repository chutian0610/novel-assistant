<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api, errorMessage } from '../api';
import type { AuthorProfileView, Material } from '../types';

const emit = defineEmits<{ changed: [] }>();

const loading = ref(true);
const saving = ref(false);
const saveError = ref<string | null>(null);
const saved = ref(false);

const form = reactive({ themePreference: '', taboos: '' });
const styleSampleIds = ref<number[]>([]);
const styleSamples = ref<Material[]>([]);

/** 候选文风样本：全局库中未被引用的 style 素材 */
const candidates = computed(() => {
  const referenced = new Set(styleSampleIds.value);
  return allStyles.value.filter((material) => !referenced.has(material.id));
});
const allStyles = ref<Material[]>([]);
const pickedStyleId = ref<number | null>(null);

async function reload() {
  const profile = await api.get<AuthorProfileView>('/api/settings/author-profile');
  form.themePreference = profile.themePreference;
  form.taboos = profile.taboos;
  styleSampleIds.value = [...profile.styleSampleIds];
  styleSamples.value = profile.styleSamples;
  const list = await api.get<{ items: Material[]; total: number }>('/api/materials?type=style&limit=200');
  allStyles.value = list.items;
  if (!candidates.value.some((material) => material.id === pickedStyleId.value)) {
    pickedStyleId.value = candidates.value[0]?.id ?? null;
  }
}

function addStyle() {
  if (pickedStyleId.value === null || styleSampleIds.value.includes(pickedStyleId.value)) return;
  styleSampleIds.value = [...styleSampleIds.value, pickedStyleId.value];
  pickedStyleId.value = candidates.value.find((material) => material.id !== pickedStyleId.value)?.id ?? null;
}

function removeStyle(id: number) {
  styleSampleIds.value = styleSampleIds.value.filter((candidate) => candidate !== id);
}

function titleOf(id: number): string {
  return styleSamples.value.find((material) => material.id === id)?.title ?? `素材 ${id}`;
}

async function save() {
  saving.value = true;
  saveError.value = null;
  saved.value = false;
  try {
    const updated = await api.put<AuthorProfileView>('/api/settings/author-profile', {
      themePreference: form.themePreference,
      taboos: form.taboos,
      styleSampleIds: styleSampleIds.value,
    });
    styleSamples.value = updated.styleSamples;
    styleSampleIds.value = [...updated.styleSampleIds];
    form.themePreference = updated.themePreference;
    form.taboos = updated.taboos;
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
      <h2>作者偏好档案</h2>
      <span v-if="saved" class="ok-text small">已保存</span>
    </div>
    <p class="muted small">
      全局默认配置，对所有书生效：档案作为常驻必带层进入每次生成的注入视图（注入视图预览页可见）。
    </p>
    <div v-if="loading" class="muted">加载中……</div>
    <template v-else>
      <label class="profile-field">
        <span class="muted small">主题偏好</span>
        <textarea
          v-model="form.themePreference"
          class="input"
          rows="3"
          placeholder="如：克制复仇流，拒绝圣母，爽点前置"
        ></textarea>
      </label>
      <label class="profile-field">
        <span class="muted small">创作禁区</span>
        <textarea
          v-model="form.taboos"
          class="input"
          rows="3"
          placeholder="如：不写肉戏；主角不双标；配角不死而复生"
        ></textarea>
      </label>

      <div class="profile-field">
        <span class="muted small">文风样本引用（素材库 style 素材，随档案进注入视图）</span>
        <div v-if="styleSampleIds.length === 0" class="empty muted">还没有引用文风样本。</div>
        <div v-else class="chip-row">
          <span v-for="id in styleSampleIds" :key="id" class="chip">
            {{ titleOf(id) }}
            <button class="chip-remove" type="button" aria-label="移除" @click="removeStyle(id)">×</button>
          </span>
        </div>
        <div class="profile-add-row">
          <select v-model="pickedStyleId" class="select" :disabled="candidates.length === 0">
            <option v-if="candidates.length === 0" :value="null">没有可引用的文风样本（先到素材库创建 style 素材）</option>
            <option v-for="material in candidates" :key="material.id" :value="material.id">
              {{ material.title }}
            </option>
          </select>
          <button class="btn" type="button" :disabled="pickedStyleId === null" @click="addStyle">引用</button>
        </div>
      </div>

      <p v-if="saveError" class="error-text">{{ saveError }}</p>
      <div class="form-actions">
        <button class="btn btn-primary" type="button" :disabled="saving" @click="save">
          {{ saving ? '保存中……' : '保存档案' }}
        </button>
      </div>
    </template>
  </section>
</template>

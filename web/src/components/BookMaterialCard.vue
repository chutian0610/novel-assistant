<script setup lang="ts">
import { MATERIAL_FIELDS } from '../materialSchema';
import { MATERIAL_TYPE_LABELS, type BookMaterialItem } from '../types';

const props = defineProps<{ item: BookMaterialItem }>();
const emit = defineEmits<{ override: []; remove: [] }>();

const item = props.item;

function effectivePayloadText(payload: Record<string, string>): string {
  return MATERIAL_FIELDS[item.material.type]
    .map((def) => {
      const value = payload[def.key];
      return value ? `${def.label}：${value}` : null;
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}

function sourceText(): string {
  const source = item.material.source;
  return source.kind === 'reference' ? `全局来源：《${source.book}》${source.chapter}` : '全局来源：人工录入';
}
</script>

<template>
  <article class="material-card">
    <div class="material-head">
      <span class="badge badge-type">{{ MATERIAL_TYPE_LABELS[item.material.type] }}</span>
      <h3 class="material-title">
        {{ item.effective.title }}
        <span v-if="item.overriddenFields.length > 0" class="override-mark">已覆写</span>
      </h3>
      <div class="material-actions">
        <button class="btn btn-ghost" type="button" @click="emit('override')">覆写</button>
        <button class="btn btn-danger-ghost" type="button" @click="emit('remove')">移除引用</button>
      </div>
    </div>

    <p class="material-content clamp">{{ item.effective.content }}</p>
    <pre v-if="effectivePayloadText(item.effective.payload)" class="material-payload muted small">{{
      effectivePayloadText(item.effective.payload)
    }}</pre>

    <div class="material-foot">
      <span v-for="field in item.overriddenFields" :key="field" class="chip chip-static override-chip">{{ field }}</span>
      <span class="muted small">{{ sourceText() }}</span>
      <span class="muted small foot-time">引用于 {{ item.addedAt.slice(0, 16).replace('T', ' ') }}</span>
    </div>
  </article>
</template>

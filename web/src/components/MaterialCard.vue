<script setup lang="ts">
import { MATERIAL_FIELDS } from '../materialSchema';
import { MATERIAL_TYPE_LABELS, type Material } from '../types';

const props = defineProps<{ material: Material }>();
const emit = defineEmits<{ edit: []; remove: [] }>();

function sourceText(material: Material): string {
  return material.source.kind === 'reference'
    ? `来源：《${material.source.book}》${material.source.chapter}`
    : '来源：人工录入';
}

function payloadText(material: Material): string {
  const defs = MATERIAL_FIELDS[material.type];
  return defs
    .map((def) => {
      const value = material.payload[def.key];
      return value ? `${def.label}：${value}` : null;
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}
</script>

<template>
  <article class="material-card">
    <div class="material-head">
      <span class="badge badge-type">{{ MATERIAL_TYPE_LABELS[props.material.type] }}</span>
      <h3 class="material-title">{{ props.material.title }}</h3>
      <div class="material-actions">
        <button class="btn btn-ghost" type="button" @click="emit('edit')">编辑</button>
        <button class="btn btn-danger-ghost" type="button" @click="emit('remove')">删除</button>
      </div>
    </div>

    <p class="material-content clamp">{{ props.material.content }}</p>
    <pre v-if="payloadText(props.material)" class="material-payload muted small">{{ payloadText(props.material) }}</pre>

    <div class="material-foot">
      <span v-for="tag in props.material.tags" :key="tag" class="chip chip-static">{{ tag }}</span>
      <span class="muted small">{{ sourceText(props.material) }}</span>
      <span class="muted small foot-time">更新于 {{ props.material.updatedAt.slice(0, 16).replace('T', ' ') }}</span>
    </div>
  </article>
</template>

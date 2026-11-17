<script setup lang="ts">
import { RouterLink } from 'vue-router';

// 占位导航：其余页面由后续工单逐个接入
const plannedItems = ['书架', '拆书', '写作台', '事实面板', '检测报告'];
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">笔</span>
        <span class="brand-name">小说工作台</span>
      </div>
      <nav class="nav">
        <span v-for="label in plannedItems" :key="label" class="nav-item disabled" title="后续版本提供">
          {{ label }}
        </span>
        <RouterLink to="/materials" class="nav-item" active-class="active">素材库</RouterLink>
        <RouterLink to="/settings" class="nav-item" active-class="active">设置</RouterLink>
      </nav>
      <div class="sidebar-foot">V1 · 骨架</div>
    </aside>
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

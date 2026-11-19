<script setup lang="ts">
import { computed } from 'vue';
import type { CharacterRelation } from '../types';

/**
 * 人物关系图（V1）：确定性圆形布局的有向图——节点为角色，边为关系（from → to，箭头 + 关系词）。
 * 纯展示组件，无物理布局依赖；角色名过长截断，悬停 title 显示全名。
 */
const props = defineProps<{ relations: CharacterRelation[] }>();

const WIDTH = 640;
const HEIGHT = 440;
const RADIUS = 168;
const CENTER = { x: WIDTH / 2, y: HEIGHT / 2 };
const NODE_R = 26;

interface GraphNode {
  name: string;
  x: number;
  y: number;
  display: string;
}

interface GraphEdge {
  key: string;
  relation: string;
  chapter: number;
  from: GraphNode;
  to: GraphNode;
  /** 中点（关系词标签位置） */
  mx: number;
  my: number;
  selfLoop: boolean;
}

const nodes = computed<GraphNode[]>(() => {
  const names = [...new Set(props.relations.flatMap((edge) => [edge.fromName, edge.toName]))].sort();
  return names.map((name, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(names.length, 1);
    return {
      name,
      x: CENTER.x + RADIUS * Math.cos(angle),
      y: CENTER.y + RADIUS * Math.sin(angle),
      display: name.length > 6 ? `${name.slice(0, 6)}…` : name,
    };
  });
});

const nodeByName = computed(() => new Map(nodes.value.map((node) => [node.name, node])));

const edges = computed<GraphEdge[]>(() =>
  props.relations.map((edge) => {
    const from = nodeByName.value.get(edge.fromName)!;
    const to = nodeByName.value.get(edge.toName)!;
    const selfLoop = edge.fromName === edge.toName;
    return {
      key: `${edge.id}`,
      relation: edge.relation,
      chapter: edge.chapter,
      from,
      to,
      mx: (from.x + to.x) / 2,
      my: (from.y + to.y) / 2,
      selfLoop,
    };
  })
);
</script>

<template>
  <svg class="relation-graph" :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" role="img" aria-label="人物关系图">
    <defs>
      <marker id="relation-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
      </marker>
    </defs>

    <g v-for="edge in edges" :key="edge.key">
      <template v-if="!edge.selfLoop">
        <line
          :x1="edge.from.x"
          :y1="edge.from.y"
          :x2="edge.to.x"
          :y2="edge.to.y"
          stroke="var(--muted)"
          stroke-width="1.5"
          marker-end="url(#relation-arrow)"
        />
        <text :x="edge.mx" :y="edge.my - 6" class="relation-label" text-anchor="middle">{{ edge.relation }}</text>
      </template>
      <template v-else>
        <!-- 自环：节点上方画一个小环 -->
        <path
          :d="`M ${edge.from.x - 14} ${edge.from.y - NODE_R} A 18 18 0 1 1 ${edge.from.x + 14} ${edge.from.y - NODE_R}`"
          fill="none"
          stroke="var(--muted)"
          stroke-width="1.5"
          marker-end="url(#relation-arrow)"
        />
        <text :x="edge.from.x" :y="edge.from.y - NODE_R - 22" class="relation-label" text-anchor="middle">{{ edge.relation }}</text>
      </template>
    </g>

    <g v-for="node in nodes" :key="node.name">
      <circle :cx="node.x" :cy="node.y" :r="NODE_R" class="relation-node" />
      <text :x="node.x" :y="node.y + 5" class="relation-node-label" text-anchor="middle">
        <title>{{ node.name }}</title>
        {{ node.display }}
      </text>
    </g>
  </svg>
</template>

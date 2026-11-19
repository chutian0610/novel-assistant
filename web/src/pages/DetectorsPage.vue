<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, errorMessage } from '../api';
import { METRIC_KEY_LABELS, METRIC_WEIGHTS, type DetectionReport, type DetectorConfig, type MetricKey } from '../types';

const DEFAULT_SAMPLE =
  '去。他一路向北走了三百余里，途中风雪交加，粮袋早就空了，只能靠挖草根勉强糊口，好歹撑到了关外。' +
  '他说道：「今日必取你性命。」随后转身离去，头也不回地走进茫茫风雪之中，只留下一个孤独的背影。' +
  '众所周知，宗门大比三年一度。总而言之，这一战他不能输。';

const text = ref('');
const analyzing = ref(false);
const analyzeError = ref<string | null>(null);
const report = ref<DetectionReport | null>(null);
const config = ref<DetectorConfig | null>(null);

/** 句子索引 → 命中的维度 label 列表。只取不达标维度：达标维度的证据句（如适量对白句）不算问题句 */
const hitsBySentence = computed(() => {
  const map = new Map<number, string[]>();
  if (!report.value) return map;
  for (const metric of report.value.metrics) {
    if (metric.pass) continue;
    for (const index of metric.hits) {
      const labels = map.get(index) ?? [];
      labels.push(METRIC_KEY_LABELS[metric.key]);
      map.set(index, labels);
    }
  }
  return map;
});

/** 各维原始值的展示精度：每千词计数 1 位，其余 3 位 */
function formatValue(key: MetricKey, value: number): string {
  return value.toFixed(key === 'templatePhrase' ? 1 : 3);
}

/**
 * 各维达标方向（镜像 server/src/detectors/metrics.ts 的维度口径，增维须两处同步）：
 * lower = 原始值低于阈值扣分；upper = 高于阈值扣分；range = 区间外扣分
 */
const THRESHOLD_KIND: Record<MetricKey, 'lower' | 'upper' | 'range'> = {
  trigramRepetition: 'upper',
  templatePhrase: 'upper',
  sentenceLengthCV: 'lower',
  lexicalDiversity: 'lower',
  semanticSmoothness: 'lower',
  punctuationCV: 'range',
  dialogueRatio: 'range',
  emotionDensity: 'range',
};

function formatThresholdLabel(key: MetricKey, threshold: number | { min: number; max: number }): string {
  const digits = key === 'templatePhrase' ? 1 : 3;
  if (typeof threshold === 'number') {
    return THRESHOLD_KIND[key] === 'lower' ? `≥ ${threshold.toFixed(digits)}` : `≤ ${threshold.toFixed(digits)}`;
  }
  return `${threshold.min.toFixed(digits)} ~ ${threshold.max.toFixed(digits)}`;
}

async function analyze() {
  if (text.value.trim() === '') return;
  analyzing.value = true;
  analyzeError.value = null;
  try {
    // 阈值随报告一起取，保证表格与报告口径一致
    const [nextReport, nextConfig] = await Promise.all([
      api.post<DetectionReport>('/api/detectors/analyze', { text: text.value }),
      api.get<DetectorConfig>('/api/detectors/config'),
    ]);
    report.value = nextReport;
    config.value = nextConfig;
  } catch (cause) {
    analyzeError.value = errorMessage(cause);
    report.value = null;
  } finally {
    analyzing.value = false;
  }
}

function loadSample() {
  text.value = DEFAULT_SAMPLE;
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1>检测工具</h1>
      <p class="page-sub">
        8 维确定性统计检测（词汇多样性 / 句长波动 / 3-gram 重复 / 模板套话 / 标点节奏 / 对白比例 / 情绪密度 / 语义平滑），
        加权合成 AI 倾向分。纯代码指标，不经 LLM。阈值可在设置页调整；从已有章节选入文本将在写作台（章节管线）接入后支持。
      </p>
    </header>

    <section class="panel">
      <div class="panel-head">
        <h2>待检文本</h2>
        <button class="btn btn-ghost small" type="button" @click="loadSample">填入示例</button>
      </div>
      <textarea v-model="text" class="input detector-input" rows="10" placeholder="粘贴或输入要检测的正文……"></textarea>
      <div class="detector-actions">
        <span class="muted small">{{ text.length }} 字符</span>
        <button class="btn btn-primary" type="button" :disabled="analyzing || text.trim() === ''" @click="analyze">
          {{ analyzing ? '检测中……' : '开始检测' }}
        </button>
      </div>
      <p v-if="analyzeError" class="error-text">{{ analyzeError }}</p>
    </section>

    <template v-if="report">
      <!-- 倾向分 -->
      <section class="panel detector-score-panel">
        <div class="detector-score">
          <span class="detector-score-num" :class="report.adjustedScore >= 50 ? 'error-text' : ''">
            {{ report.adjustedScore }}
          </span>
          <span class="muted">AI 倾向分（0 = 人味足，100 = 机器味重）</span>
        </div>
        <ul class="detector-score-meta">
          <li>词元数 {{ report.wordCount }}</li>
          <li>置信度 {{ Math.round(report.confidence * 100) }}%</li>
          <li v-if="report.insufficient" class="warn-text">样本不足（低于 60 词元），倾向分已按置信度降权</li>
          <li v-if="report.confidence < 1 && !report.insufficient">未降权原始分 {{ report.aiScore }}</li>
        </ul>
      </section>

      <!-- 8 维报告 -->
      <section class="panel">
        <div class="panel-head">
          <h2>分维报告</h2>
          <span v-if="config" class="muted small">阈值来自设置页（可改，即时生效）</span>
        </div>
        <table class="detector-table">
          <thead>
            <tr>
              <th>维度</th>
              <th>数值</th>
              <th>阈值（达标方向）</th>
              <th>问题分（权重）</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="metric in report.metrics" :key="metric.key">
              <td>{{ METRIC_KEY_LABELS[metric.key] }}</td>
              <td>{{ formatValue(metric.key, metric.value) }}</td>
              <td class="muted">{{ formatThresholdLabel(metric.key, metric.threshold) }}</td>
              <td>
                {{ metric.score.toFixed(2) }}
                <span class="muted small">（权重 {{ METRIC_WEIGHTS[metric.key] }}）</span>
              </td>
              <td>
                <span v-if="metric.skipped" class="chip chip-static">样本不足</span>
                <span v-else class="badge" :class="metric.pass ? 'badge-ok' : 'badge-off'">
                  {{ metric.pass ? '达标' : '不达标' }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 问题句高亮 -->
      <section class="panel">
        <div class="panel-head">
          <h2>逐句定位</h2>
          <span class="muted small">黄色底为问题/证据句，标签标注命中的维度</span>
        </div>
        <p class="detector-sentences">
          <template v-for="(sentence, index) in report.sentences" :key="index">
            <mark v-if="hitsBySentence.has(index)" class="detector-hit">
              {{ sentence }}
              <span v-for="label in hitsBySentence.get(index)" :key="label" class="chip chip-static detector-hit-chip">
                {{ label }}
              </span>
            </mark>
            <span v-else>{{ sentence }}</span>
          </template>
        </p>
        <p v-if="hitsBySentence.size === 0" class="empty muted">没有可定位的问题句。</p>
      </section>
    </template>
  </div>
</template>

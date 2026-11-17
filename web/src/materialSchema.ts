import type { MaterialType } from './types';

/** 各类型素材的编辑器字段定义（与 server/src/api/materials.ts 的 payloadSchemas 镜像同步） */
export interface MaterialFieldDef {
  key: string;
  label: string;
  multiline?: boolean;
  required?: boolean;
  placeholder?: string;
}

export const MATERIAL_FIELDS: Record<MaterialType, MaterialFieldDef[]> = {
  setting: [{ key: 'category', label: '领域分类', placeholder: '世界观 / 人物 / 物品 / 势力 / 地点' }],
  trope: [
    {
      key: 'structure',
      label: '结构要点',
      multiline: true,
      placeholder: '冲突模式、名场面结构、钩子/反转如何展开',
    },
  ],
  style: [{ key: 'rhythm', label: '句式节奏说明', multiline: true, placeholder: '长短句配比、节奏起伏、标点习惯等' }],
  skeleton: [
    { key: 'pacingCurve', label: '节奏曲线', multiline: true, required: true, placeholder: '开篇到高潮的节奏铺排' },
    { key: 'volumeStructure', label: '卷纲结构', multiline: true, required: true, placeholder: '各卷主线与分界' },
    { key: 'archetypes', label: '人物原型', multiline: true, required: true, placeholder: '主角/配角原型与关系模式' },
  ],
};

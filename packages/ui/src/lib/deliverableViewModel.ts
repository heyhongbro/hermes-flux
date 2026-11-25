/**
 * 跨端成果物统一列表视图模型 (packages/ui/src/lib/deliverableViewModel.ts)
 *
 * 【设计意图 (Why)】
 *   依据 AGENTS.md「UI 高度抽象与组件复用」铁律：
 *   桌面端右侧「成果物侧边栏」与移动端「成果物 Tab」严禁各自拼接文件名、格式徽标或路径；
 *   统一经由本视图模型将 `DeliverableItem` 映射为“纯文件名 + 24px 类型图标/缩略图 + 短格式徽标”，
 *   确保两端渲染结构与口径 100% 同源、完整路径仅沉淀于悬停提示与打开动作。
 */

import { extractPathBasename, type DeliverableItem, type DeliverableKind } from '@hermes-flux/core';

export interface DeliverableListRowVM {
  id: string;
  /** 仅包含文件basename，严禁拼接父目录前缀 */
  name: string;
  /** 完整物理路径 / 媒体 URL，供 hover tooltip 与预览打开动作使用 */
  path: string;
  kind: DeliverableKind;
  /** 短格式徽标，如 HTML / MD / PNG / JPG / SVG / MP4 / PDF / FILE */
  extLabel: string;
  /** 兼容移动端 MobileInspectorArtifactItem 的类型标识 */
  type: string;
  size: string;
  previewUrl?: string;
}

/**
 * 统一规范化短格式徽标文案。
 */
export function formatDeliverableExtLabel(nameOrPath: string, kind: DeliverableKind): string {
  const clean = (nameOrPath || '').split(/[?#]/)[0].trim();
  if (clean && !clean.startsWith('data:')) {
    const base = extractPathBasename(clean);
    const dotIdx = base.lastIndexOf('.');
    if (dotIdx > 0) {
      const ext = base.slice(dotIdx + 1).toLowerCase();
      if (ext === 'htm' || ext === 'html') return 'HTML';
      if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'MD';
      if (ext === 'jpeg') return 'JPG';
      if (ext.length <= 6) return ext.toUpperCase();
    }
  }
  switch (kind) {
    case 'image':
      return 'IMG';
    case 'video':
      return 'VIDEO';
    case 'html':
      return 'HTML';
    case 'markdown':
      return 'MD';
    case 'document':
      return 'DOC';
    default:
      return 'FILE';
  }
}

/**
 * 提取干净的纯文件名（用于正文小卡片、桌面成果物侧边栏、移动端成果物列表）。
 */
export function resolveDeliverableDisplayName(pathOrName: string, fallback = 'file'): string {
  const raw = (pathOrName || '').trim();
  if (!raw) return fallback;
  if (raw.startsWith('data:')) return fallback;
  const clean = raw.split(/[?#]/)[0].replace(/\\/g, '/').replace(/\/+$/, '');
  const base = clean.split('/').pop() || clean;
  return base || fallback;
}

/**
 * 将核心领域 `DeliverableItem[]` 映射为桌面与移动端共用的统一成果物行模型。
 */
export function buildDeliverableListItems(items: readonly DeliverableItem[]): DeliverableListRowVM[] {
  return items.map((item) => {
    const displayName = resolveDeliverableDisplayName(item.path, item.name || 'file');
    const extLabel = formatDeliverableExtLabel(displayName, item.kind);
    return {
      id: item.id,
      name: displayName,
      path: item.path,
      kind: item.kind,
      extLabel,
      type: extLabel,
      size: '',
      ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}),
    };
  });
}

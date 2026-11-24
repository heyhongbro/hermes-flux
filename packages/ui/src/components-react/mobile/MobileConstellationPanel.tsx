/**
 * 移动端「记忆与学习 — 认知星图」薄适配入口 (MobileConstellationPanel)
 *
 * 【设计意图 (Why)】
 *   复用到桌面端与移动端共用的 `CognitiveStarMapPanel`（`variant="mobile"`），
 *   消除两端重复编写星图画布、技能列表与详情弹窗，同时保留既有 `MobileConstellationPanel` 导出签名向后兼容。
 */

import * as React from 'react';
import type { LearningDetailState, LearningLoadState } from '@hermes-flux/core';
import {
  CognitiveStarMapPanel,
  type CognitiveStarMapPanelProps,
} from '../learning/CognitiveStarMapPanel.js';
import type { SettingsActions } from '../settings/settingsModel.js';

export interface MobileConstellationPanelProps {
  targetProfile?: string;
  targetBotLabel?: string;
  learningState: LearningLoadState;
  learningDetail: LearningDetailState;
  onEnsureLoaded?: (profile: string) => void;
  onRefresh: (profile?: string) => void;
  onSelectNodeDetail: (id: string, profile?: string) => void;
  onSaveEdit?: (id: string, content: string, profile?: string) => Promise<{ ok: boolean; message?: string }>;
  onDeleteNode?: (id: string, profile?: string) => Promise<{ ok: boolean; message?: string }>;
  onInspectSkill?: SettingsActions['onInspectSkill'];
  onCopyText?: (text: string) => void;
  onNotify?: (message: string) => void;
  footerHint?: string;
}

export function MobileConstellationPanel({
  targetProfile = 'default',
  targetBotLabel,
  learningState,
  learningDetail,
  onEnsureLoaded,
  onRefresh,
  onSelectNodeDetail,
  onSaveEdit,
  onDeleteNode,
  onInspectSkill,
  onCopyText,
  onNotify,
  footerHint,
}: MobileConstellationPanelProps): React.ReactElement {
  const sharedProps: CognitiveStarMapPanelProps = {
    targetProfile,
    targetBotLabel,
    variant: 'mobile',
    testIdPrefix: 'mobile-constellation',
    learningState,
    learningDetail,
    onEnsureLoaded,
    onRefresh,
    onSelectNodeDetail,
    onSaveEdit,
    onDeleteNode,
    onInspectSkill,
    onCopyText,
    onNotify,
    footerHint,
  };
  return <CognitiveStarMapPanel {...sharedProps} />;
}

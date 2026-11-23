/**
 * 右侧状态栏 React 岛根宿主（含退场快照保留防空白闪现）
 */

import * as React from 'react';
import { SessionStatusPanel } from './SessionStatusPanel.js';
import { SubagentDetailView } from './SubagentDetailView.js';
import type { RightPodActions, RightPodSnapshot } from './types.js';

export interface RightPodRootProps {
  snapshot: RightPodSnapshot;
  actions: RightPodActions;
}

export function RightPodRoot({ snapshot, actions }: RightPodRootProps): React.ReactElement | null {
  // 闭合退场期间 host 带 inert 保留最后一帧有效视图，防止 160ms 收口滑出瞬间白屏
  const lastViewRef = React.useRef<RightPodSnapshot | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const currentKind = snapshot.rightPodMode.kind;

  if (currentKind === 'status' || currentKind === 'subagent') {
    lastViewRef.current = snapshot;
  }

  React.useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof el.toggleAttribute !== 'function') return;
    el.toggleAttribute('inert', Boolean(snapshot.inert));
  }, [snapshot.inert]);

  const effectiveSnapshot =
    currentKind === 'status' || currentKind === 'subagent'
      ? snapshot
      : snapshot.inert && lastViewRef.current
      ? lastViewRef.current
      : null;

  return (
    <div
      ref={rootRef}
      data-flux-island=""
      className="right-pod-island"
      data-inert={snapshot.inert ? 'true' : undefined}
    >
      {effectiveSnapshot ? (
        effectiveSnapshot.rightPodMode.kind === 'subagent' ? (
          <SubagentDetailView snapshot={effectiveSnapshot} actions={actions} />
        ) : (
          <SessionStatusPanel snapshot={effectiveSnapshot} actions={actions} />
        )
      ) : null}
    </div>
  );
}

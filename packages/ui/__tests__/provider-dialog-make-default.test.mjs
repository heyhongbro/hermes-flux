/**
 * AddProviderDialog 默认模型开关与 providerDialogLogic makeDefault 单测
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddProviderDialog } from '../dist/components-react/settings/AddProviderDialog.js';
import {
  buildSaveEndpointOptions,
  formReducer,
  initialFormState,
} from '../dist/components-react/settings/providerDialogLogic.js';
import { setLocale, t } from '../dist/i18n/index.js';

function createStubSnapshot() {
  return {
    isOpen: true,
    section: 'providers',
    theme: 'obsidian',
    locale: 'zh',
    fontPrefs: { uiFont: 'system', codeFont: 'jetbrains-mono', fontSize: 14 },
    activityVariant: 'pulse',
    conversationWidth: 'standard',
    leftRailLayout: 'grouped',
    orgPrefs: { showTags: true, showArchived: false },
    projects: { status: 'ready', data: [] },
    profiles: { status: 'ready', data: [] },
    bots: [
      { profile: 'default', displayName: '大总管' },
      { profile: 'aura', displayName: 'Aurora' },
    ],
    botManagement: {
      status: 'ready',
      roster: [],
      activeBotId: 'default',
      drafts: {},
      dirty: false,
      saving: false,
      wizardOpen: false,
      wizardMode: 'create',
      wizardDraft: { name: '', displayName: '', archetype: 'assistant', model: '' },
      wizardSaving: false,
    },
    learningState: { status: 'idle', nodes: [], edges: [], activeProfile: 'default' },
    scopedProfile: 'default',
    providerViews: { status: 'ready', data: [] },
    providerFailures: [],
    providerLastSyncedAt: 0,
    customEndpoints: { status: 'ready', data: [] },
    endpointProfiles: {},
    endpointFailures: [],
    oauthSessions: { status: 'ready', data: [] },
    settingsSkills: { status: 'ready', data: [] },
    settingsMcp: { status: 'ready', data: [] },
    gateway: {
      url: 'http://127.0.0.1:18789',
      username: '',
      hasStoredPassword: false,
      profileName: 'default',
      status: 'connected',
      latencyMs: 10,
      test: { status: 'idle' },
    },
    gatewayConnected: true,
    busy: false,
  };
}

const noopActions = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'onProbeEndpoint') return async () => ({ kind: 'ok', resolvedBaseUrl: '', models: [], modelCount: 0 });
      if (prop === 'onSaveEndpoint') return async () => ({ ok: true });
      return () => undefined;
    },
  },
);

test('AddProviderDialog：新增模式默认渲染并勾选「同时设为所选 BOT 的默认模型」开关，编辑模式不渲染', () => {
  setLocale('zh-CN');
  const bots = [
    { profile: 'default', displayName: '大总管' },
    { profile: 'aura', displayName: 'Aurora' },
  ];
  const addHtml = renderToStaticMarkup(
    React.createElement(AddProviderDialog, {
      open: true,
      onClose() {},
      bots,
      defaultProfile: 'default',
      snapshot: createStubSnapshot(),
      actions: noopActions,
      editing: null,
      defaultTab: 'custom',
    }),
  );
  assert.ok(addHtml.includes('data-testid="custom-endpoint-make-default-switch"'));
  assert.ok(addHtml.includes(t('settings.customEndpointSetDefaultForBots')));
  assert.ok(addHtml.includes('aria-checked="true"'));

  const editHtml = renderToStaticMarkup(
    React.createElement(AddProviderDialog, {
      open: true,
      onClose() {},
      bots,
      defaultProfile: 'default',
      snapshot: createStubSnapshot(),
      actions: noopActions,
      editing: {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        models: ['deepseek-chat'],
        apiMode: '',
        hasApiKey: true,
        isCurrent: false,
      },
      defaultTab: 'custom',
    }),
  );
  assert.equal(editHtml.includes('data-testid="custom-endpoint-make-default-switch"'), false);
});

test('providerDialogLogic：makeDefault 开关状态迁移与保存参数构建', () => {
  assert.deepEqual(
    buildSaveEndpointOptions(false, ['bot-b', 'bot-a', 'bot-b'], undefined),
    { targetProfiles: ['bot-b', 'bot-a'], fanOutTo: ['bot-a'], makeDefault: false },
  );
  assert.deepEqual(
    buildSaveEndpointOptions(false, ['bot-b', 'bot-a'], undefined, true),
    { targetProfiles: ['bot-b', 'bot-a'], fanOutTo: ['bot-a'], makeDefault: true },
  );
  assert.deepEqual(
    buildSaveEndpointOptions(true, ['ignored'], ['bot-1', 'bot-2'], true),
    { targetProfiles: ['bot-1', 'bot-2'], fanOutTo: ['bot-2'], makeDefault: false },
  );

  const initAdd = initialFormState(null, undefined, [{ profile: 'a', displayName: 'A' }, { profile: 'b', displayName: 'B' }], 'b');
  assert.equal(initAdd.makeDefault, true);

  const toggled = formReducer(initAdd, { type: 'setMakeDefault', makeDefault: false });
  assert.equal(toggled.makeDefault, false);

  const reAdd = formReducer(toggled, { type: 'initAdd', initialProfiles: ['a'] });
  assert.equal(reAdd.makeDefault, true);
});

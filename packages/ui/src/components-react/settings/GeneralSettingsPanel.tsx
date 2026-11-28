import * as React from 'react';
import { t } from '../../i18n/index.js';
import { DEFAULT_CONVERSATION_ORG_PREFS } from '../../tokens/conversationOrgPrefs.js';
import { Switch } from '../primitives/Switch.js';
import { SegmentedControl } from './SegmentedControl.js';
import { SettingInset, SettingRow, SettingSection } from './SettingRow.js';
import { SettingsSectionHeading } from './SettingsSectionHeading.js';
import type { SettingsActions, SettingsSnapshot } from './settingsModel.js';

export function GeneralSettingsPanel({
  snapshot,
  actions,
}: {
  snapshot: SettingsSnapshot;
  actions: SettingsActions;
}): React.ReactElement {
  const orgPrefs = snapshot.orgPrefs ?? DEFAULT_CONVERSATION_ORG_PREFS;
  return (
    <div className="flex flex-col gap-6">
      <SettingSection>
        <SettingsSectionHeading title={t('settings.languageTitle')} hint={t('settings.languageHint')} />
        <SettingInset>
          <SettingRow label={t('settings.languageLabel')} anchorId="language">
            <SegmentedControl
              ariaLabel={t('settings.languageLabel')}
              value={snapshot.locale}
              onChange={(locale) => actions.onLocaleChange(locale)}
              options={[
                { value: 'zh', label: t('settings.languageZh') },
                { value: 'en', label: t('settings.languageEn') },
              ]}
            />
          </SettingRow>
        </SettingInset>
      </SettingSection>

      <SettingSection>
        <SettingsSectionHeading title={t('settings.orgGroupTitle')} />
        <SettingInset>
          <SettingRow
            label={t('settings.showDoneSection')}
            hint={t('settings.showDoneSectionDesc')}
            anchorId="show-done-section"
            onLabelActivate={() =>
              actions.onConversationOrgPrefsChange?.({
                showDoneSection: !orgPrefs.showDoneSection,
              })
            }
          >
            <Switch
              checked={orgPrefs.showDoneSection}
              aria-label={t('settings.showDoneSection')}
              onCheckedChange={(checked) =>
                actions.onConversationOrgPrefsChange?.({ showDoneSection: checked })
              }
            />
          </SettingRow>
          <SettingRow
            label={t('settings.autoReopenOnSend')}
            hint={t('settings.autoReopenOnSendDesc')}
            anchorId="auto-reopen-on-send"
            onLabelActivate={() =>
              actions.onConversationOrgPrefsChange?.({
                autoReopenOnSend: !orgPrefs.autoReopenOnSend,
              })
            }
          >
            <Switch
              checked={orgPrefs.autoReopenOnSend}
              aria-label={t('settings.autoReopenOnSend')}
              onCheckedChange={(checked) =>
                actions.onConversationOrgPrefsChange?.({ autoReopenOnSend: checked })
              }
            />
          </SettingRow>
        </SettingInset>
      </SettingSection>

      <SettingSection>
        <SettingsSectionHeading title={t('settings.sidebarLayoutTitle')} hint={t('settings.sidebarLayoutHint')} />
        <SettingInset>
          <SettingRow label={t('settings.leftRailLayout')} anchorId="left-rail-layout">
            <SegmentedControl
              ariaLabel={t('settings.leftRailLayout')}
              value={snapshot.leftRailLayout}
              onChange={(layout) => actions.onLeftRailLayoutChange(layout)}
              options={[
                { value: 'dual-rail', label: t('settings.leftRailLayoutDual') },
                { value: 'grouped', label: t('settings.leftRailLayoutGrouped') },
              ]}
            />
          </SettingRow>
        </SettingInset>
      </SettingSection>

      <SettingSection>
        <SettingsSectionHeading title={t('settings.presenceTitle')} hint={t('settings.presenceHint')} />
        <SettingInset>
          <SettingRow label={t('settings.presenceLayout')} anchorId="presence-layout">
            <SegmentedControl
              ariaLabel={t('settings.presenceLayout')}
              value={snapshot.presenceLayout}
              onChange={(layout) => actions.onPresenceLayoutChange(layout)}
              options={[
                { value: 'stage', label: t('settings.presenceLayoutStage') },
                { value: 'dock', label: t('settings.presenceLayoutDock') },
              ]}
            />
          </SettingRow>
        </SettingInset>
      </SettingSection>
    </div>
  );
}

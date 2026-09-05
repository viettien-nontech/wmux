import { useStore } from '../../store';
import { useT } from '../../i18n';
import { NOTIFICATION_SOUND_LABELS, previewNotificationSound } from '../../notification-sound';

export default function NotificationSettings() {
  const t = useT();
  const { notificationPrefs, setNotificationPrefs } = useStore();

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.notifications.alertsSection', 'Alerts')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.toast', 'Show toast notifications')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.toast}
          onChange={(e) => setNotificationPrefs({ toast: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.taskbarFlash', 'Taskbar flash')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.taskbarFlash}
          onChange={(e) => setNotificationPrefs({ taskbarFlash: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.paneRing', 'Pane ring')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.paneRing}
          onChange={(e) => setNotificationPrefs({ paneRing: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.paneFlashAnimation', 'Pane flash animation')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.paneFlashAnimation}
          onChange={(e) => setNotificationPrefs({ paneFlashAnimation: e.target.checked })}
        />
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.notifications.aiAgentsSection', 'AI agents')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.agentInputNotify', 'Notify when agent needs input')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.agentInputNotify}
          onChange={(e) => setNotificationPrefs({ agentInputNotify: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.agentStopNotify', "Notify when agent finishes its turn")}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.agentStopNotify}
          onChange={(e) => setNotificationPrefs({ agentStopNotify: e.target.checked })}
        />
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.notifications.quotaSection', 'Quota')}</h3>

      <p className="settings-hint">
        {t(
          'settings.notifications.quotaHint',
          'Chuông kêu một lần ở mỗi mức, cho mỗi cửa 5 giờ và cửa tuần. Mức thấp hơn cũng là mức sidebar tô màu.',
        )}
      </p>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.quotaWarn', 'Cảnh báo ở (%)')}</label>
        <input
          type="number"
          className="settings-input settings-input--narrow"
          value={notificationPrefs.quotaWarnPct}
          min={1}
          max={100}
          onChange={(e) => setNotificationPrefs({ quotaWarnPct: clampPct(e.target.value, notificationPrefs.quotaWarnPct) })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.quotaAlert', 'Gần cạn ở (%)')}</label>
        <input
          type="number"
          className="settings-input settings-input--narrow"
          value={notificationPrefs.quotaAlertPct}
          min={1}
          max={100}
          onChange={(e) => setNotificationPrefs({ quotaAlertPct: clampPct(e.target.value, notificationPrefs.quotaAlertPct) })}
        />
      </div>

      {notificationPrefs.quotaWarnPct > notificationPrefs.quotaAlertPct && (
        /* Said rather than corrected. Reordering the fields as they are typed
           makes the box under the cursor jump, so the two numbers are stored
           exactly as entered and every reader sorts them — which means the
           lower one warns either way round. Worth one sentence, not an error. */
        <p className="settings-hint">
          {t(
            'settings.notifications.quotaInverted',
            'Số nhỏ hơn luôn là mức cảnh báo trước — hai ô đang ngược nhau, nhưng chuông vẫn kêu đúng thứ tự.',
          )}
        </p>
      )}

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.notifications.soundSection', 'Sound')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.sound', 'Notification sound')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            className="settings-select"
            value={notificationPrefs.sound}
            onChange={(e) => {
              const sound = e.target.value as typeof notificationPrefs.sound;
              setNotificationPrefs({ sound });
              previewNotificationSound(sound);
            }}
          >
            {NOTIFICATION_SOUND_LABELS.map((s) => (
              <option key={s.value} value={s.value}>{t(s.labelKey, s.fallback)}</option>
            ))}
          </select>
          <button
            type="button"
            className="settings-button"
            disabled={notificationPrefs.sound === 'none'}
            onClick={() => previewNotificationSound(notificationPrefs.sound)}
          >
            {t('settings.notifications.preview', 'Preview')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What a keystroke in one of the percent boxes is worth.
 *
 * An empty box is `''`, and `Number('')` is 0 — which would be written to
 * settings as a threshold every reading has crossed, i.e. a bell that rings
 * forever, from deleting one character. Keep the previous value for anything
 * that is not a number, and clamp the rest into the range the tool's own
 * numbers live in.
 */
function clampPct(raw: string, previous: number): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) return previous;
  return Math.min(100, Math.max(1, Math.round(n)));
}

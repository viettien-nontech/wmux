import { useStore } from '../../store';
import { useT } from '../../i18n';
import { isNearLimit } from './quota';

/**
 * The account's remaining quota, always visible above the workspace list.
 *
 * Deliberately its OWN row, not folded into AgentRosterBanner: that banner
 * auto-hides when no agent is tracked ("who needs me?" has no answer with
 * zero agents running, so it disappears). Quota has no such condition — it
 * answers "how much is left", which is true and useful whether or not
 * anything is running right now. Gating it on agent count would hide the
 * one number a user most wants before starting anything.
 *
 * One line for the whole window, not one per pane — three Claude panes
 * share a single 5-hour window, so a per-row number would just be three
 * chances to disagree with itself.
 */
export default function QuotaBanner() {
  const quota = useStore((s) => s.quota);
  const t = useT();

  if (!quota) return null;

  if (quota.error) {
    return (
      <div className="quota-banner" title={quota.error}>
        {t('agentRoster.quotaUnknown', 'quota ?')}
      </div>
    );
  }

  if (quota.bays.length === 0) return null;

  return (
    <div className="quota-banner">
      {quota.bays.map((bay, i) => (
        <span key={bay.id} className="quota-banner__bay">
          {i > 0 && <span className="quota-banner__sep">·</span>}
          <span className="quota-banner__label">{bay.label}</span>
          <span
            className={
              isNearLimit(bay.fiveHour.pct)
                ? 'quota-banner__pct quota-banner__pct--near'
                : 'quota-banner__pct'
            }
          >
            {bay.fiveHour.pct != null ? `${bay.fiveHour.pct}%` : '?'}
          </span>
        </span>
      ))}
    </div>
  );
}

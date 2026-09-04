import { useStore } from '../../store';
import { useT } from '../../i18n';
import { isNearLimit, formatResetTime, type QuotaBay } from './quota';

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
 *
 * Shows BOTH windows, not just the 5-hour one. The first version showed only
 * the 5-hour percent and quietly dropped the reset time and the weekly
 * number — a real regression against the Herdr design this replaced, caught
 * by comparing the two side by side. The weekly window is not a nice-to-have:
 * a session can be wide open on the 5-hour window and still blocked by a
 * nearly-exhausted week, and each window is coloured on its OWN percent
 * rather than either borrowing the other's — 5h at 4% with Weekly at 91%
 * must still read red.
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
          <QuotaBayLine bay={bay} />
        </span>
      ))}
    </div>
  );
}

function Pct({ value }: { value: number | null }) {
  return (
    <span className={isNearLimit(value) ? 'quota-banner__pct quota-banner__pct--near' : 'quota-banner__pct'}>
      {value != null ? `${value}%` : '?'}
    </span>
  );
}

function QuotaBayLine({ bay }: { bay: QuotaBay }) {
  const reset = formatResetTime(bay.fiveHour.resetsAt);
  return (
    <>
      <span className="quota-banner__label">{bay.label}</span>
      <span className="quota-banner__window">5h</span>
      <Pct value={bay.fiveHour.pct} />
      {reset && <span className="quota-banner__reset">→{reset}</span>}
      <span className="quota-banner__window">Weekly</span>
      <Pct value={bay.sevenDay.pct} />
    </>
  );
}

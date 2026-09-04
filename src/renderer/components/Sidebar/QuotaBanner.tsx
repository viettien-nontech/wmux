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

  if (!quota) return <QuotaSkeleton />;

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
      {quota.bays.map((bay) => (
        <div key={bay.id} className="quota-banner__bay" title={bay.reason || undefined}>
          <QuotaBayLine bay={bay} />
        </div>
      ))}
    </div>
  );
}

/**
 * Holds the row's place while the first measurement is on its way.
 *
 * Not a number and not pretending to be one: dimmed labels and dashes, so the
 * workspace list below does not jump down a row the moment the real figures
 * land. The two labels are the two bays this build reads; they are a shape,
 * replaced wholesale by whatever the tool actually reports, so a machine with
 * only one agent sees the placeholder for the fraction of a second before the
 * answer arrives and then sees the truth.
 */
function QuotaSkeleton() {
  return (
    <div className="quota-banner quota-banner--pending" aria-hidden="true">
      {['CC', 'CX'].map((label) => (
        <div key={label} className="quota-banner__bay">
          <span className="quota-banner__label">{label}</span>
          <span className="quota-banner__window">5h</span>
          <span className="quota-banner__pct">—</span>
          <span className="quota-banner__window">Weekly</span>
          <span className="quota-banner__pct">—</span>
        </div>
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
      {/* Only when there is nothing to show AND a reason why. `?` on its own
          reads the same for "no agent has ever run here" as for "the reading
          expired" — one is nothing to act on, the other means the numbers on
          screen are no longer true. The word is short because the row is
          narrow; the tool's full sentence is the row's tooltip. */}
      {bay.status !== 'ok' && bay.fiveHour.pct == null && bay.sevenDay.pct == null && (
        <span className="quota-banner__stale">{bay.status === 'stale' ? 'cũ' : bay.status}</span>
      )}
    </>
  );
}

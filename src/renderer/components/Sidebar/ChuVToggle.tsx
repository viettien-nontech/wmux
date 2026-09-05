import React, { useState } from 'react';
import { useT } from '../../i18n';
import { chuVEnabled, CHU_V_KEY } from './chu-v';

/**
 * The V-model review switch.
 *
 * One row for the whole app, not one per pane, and that is not a simplification
 * — the tool it controls has no concept of a pane. Its scope is a pair of git
 * REPOSITORIES, and it reviews `git diff HEAD` across them; three panes in one
 * workspace usually look at the same repo, so "on in pane 1, off in pane 2"
 * would not describe anything that exists.
 *
 * Deliberately just a checkbox. Which model, which base commit, dossier-only —
 * the tool has flags for all of those, and putting them here would make a
 * sidebar row into a launcher for a thing the sidebar cannot launch. The one
 * decision worth having at hand is whether to spend money at all.
 *
 * State lives in `settings.json`, which is also where the external tool reads
 * it. Not in the Zustand settings slice: that slice hydrates once at module
 * load, and this value can be changed by the tool's own docs telling someone to
 * edit the file. Reading it fresh on mount is the honest thing for a value with
 * a second writer outside the app.
 */
export default function ChuVToggle() {
  const t = useT();
  const [bat, setBat] = useState<boolean>(() => {
    try {
      return chuVEnabled(window.wmux?.settings?.getAllSync?.());
    } catch {
      // A settings read that throws is not an instruction to stop reviewing.
      return true;
    }
  });

  const doi = (moi: boolean): void => {
    setBat(moi);
    try {
      window.wmux?.settings?.set?.(CHU_V_KEY, { bat: moi });
    } catch {
      /* The write is fire-and-forget over IPC; main owns the file. Failing to
         persist must not leave the checkbox lying about what it did, so put it
         back rather than showing a state nothing agrees with. */
      setBat(!moi);
    }
  };

  return (
    <div className="chuv-toggle">
      <label className="chuv-toggle__label">
        <input
          type="checkbox"
          className="chuv-toggle__box"
          checked={bat}
          onChange={(e) => doi(e.target.checked)}
        />
        <span>{t('chuV.label', 'Soát bằng AI thứ hai')}</span>
      </label>
      {!bat && (
        /* Off is the state worth saying out loud: nothing else on screen would
           show that reviews have stopped, and an absence is what nobody
           notices. */
        <span className="chuv-toggle__off">{t('chuV.off', 'đang tắt')}</span>
      )}
    </div>
  );
}

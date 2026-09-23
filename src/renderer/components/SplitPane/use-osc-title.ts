import { useStore } from '../../store';

/**
 * Read a surface's program-set window title, for the tab label (issue #221).
 *
 * One hook rather than the same two selectors inlined in the tab bar and the
 * split-drag preview: the PREF GATE has to be identical in both, and a preview
 * that labelled a pane differently from the tab it is previewing is exactly the
 * kind of drift that is invisible until someone drags a tab.
 *
 * Returns undefined — not '' — when the feature is off or nothing has set a
 * title, because that is what `getSurfaceLabel` treats as "fall through".
 */
export function useOscTitleLookup(): (surfaceId: string) => string | undefined {
  const enabled = useStore((state) => state.terminalPrefs.oscTitleTabs);
  const oscTitles = useStore((state) => state.oscTitles);
  return (surfaceId: string) => (enabled ? oscTitles[surfaceId]?.title : undefined);
}

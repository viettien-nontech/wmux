/**
 * Whether this build may update itself from upstream's GitHub releases.
 *
 * ⛔ FALSE ON THIS FORK, and it has to stay false.
 *
 * The updater answers to `amirlehmam/wmux`. On 2026-09-23 it did exactly what
 * it was built to do: saw upstream's 2.13.1, offered it, and — on one click —
 * replaced `~/wmux-app` with the stock app. Every fork change (the CDP
 * multiplexer, `/wmux/cdp-state`, the quota sidebar, chữ V) was gone from the
 * running app, while the source sat untouched in git. Nothing warned that an
 * "update" of a fork is a downgrade to someone else's code.
 *
 * So the fork updates the way it was built: merge upstream, then
 * `npm run package:app`. Flip this only after pointing the updater at a
 * release feed this fork publishes itself.
 */
export const FORK_SELF_UPDATE = false;

/**
 * Phase 3: the draft becomes a Yjs document (ralph/PLAN.md §2.3).
 *
 * `y_state` holds a binary Yjs update — the merged state of the collaborative
 * draft, written back by the websocket server. It is deliberately the ONLY Yjs
 * column: PLAN §2.3 persists Yjs state for the draft and nothing else, because
 * published versions are self-contained snapshots that must render with no Yjs
 * available. If a version ever grew a y_state, the temptation to reconstruct it
 * by replaying history would come back with it.
 *
 * draft_body / draft_markdown stay, and stay authoritative for everything that
 * is not the editor: publish snapshots them, the version-diff reads them, and
 * `GET /documents/:id/content?ref=draft` serves them. They are the *projection*
 * of the Yjs doc — the server rewrites them from the live document on each
 * persist — so phase 2's publish path did not change to accommodate Yjs, only
 * its writer did. That is the arrangement PLAN §2.3 predicted ("Publish reads
 * from the same columns phase 3 will populate").
 *
 * Nullable in the same way draft_body is: a document created before this
 * migration, or one nobody has opened in the editor yet, has no Yjs state. The
 * server initialises one from draft_body on first join, so there is no
 * backfill to get wrong here and no document is stranded without a draft.
 */
exports.up = (pgm) => {
  pgm.addColumns('documents', {
    y_state: { type: 'bytea' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('documents', ['y_state']);
};

/**
 * Transaction meta set on the schema plugins' own transactions (heading ids, page ids). They
 * only change attributes that don't affect layout, so pagination can skip them:
 * `if (tr.getMeta(LAYOUT_NEUTRAL_META)) return prev;`. They also carry addToHistory: false.
 */
export const LAYOUT_NEUTRAL_META = 'hbLayoutNeutral';

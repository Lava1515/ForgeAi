const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && (() => {
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value;
})();
const validPrice = (tier) => Number.isFinite(tier?.input_per_mtok) && tier.input_per_mtok >= 0
  && Number.isFinite(tier?.output_per_mtok) && tier.output_per_mtok >= 0;

/** Resolve one verified rate tier for an input token count and UTC calendar date.
 * Entries without tiers are flat rates. Tiered entries fail closed on missing,
 * malformed, or overlapping selectors so callers never guess a list price.
 */
export function resolvePriceTier(entry, inputCount, date) {
  if (!entry || !isCount(inputCount)) return null;
  if (!Array.isArray(entry.tiers)) return validPrice(entry) ? { input_per_mtok: entry.input_per_mtok, output_per_mtok: entry.output_per_mtok } : null;
  if (!isDate(date) || entry.tiers.length === 0) return null;

  let malformed = false;
  const reject = () => { malformed = true; return false; };
  const matches = entry.tiers.filter((tier) => {
    if (!validPrice(tier)) return reject();
    const hasInputSelector = tier.min_input_tokens !== undefined || tier.max_input_tokens !== undefined;
    const hasDateSelector = tier.effective_from !== undefined || tier.effective_through !== undefined;
    if (hasInputSelector === hasDateSelector) return reject();
    if (hasInputSelector) {
      if ((tier.min_input_tokens !== undefined && !isCount(tier.min_input_tokens))
        || (tier.max_input_tokens !== undefined && !isCount(tier.max_input_tokens))) return reject();
      if (tier.min_input_tokens !== undefined && tier.max_input_tokens !== undefined && tier.min_input_tokens > tier.max_input_tokens) return reject();
      return (tier.min_input_tokens === undefined || inputCount >= tier.min_input_tokens)
        && (tier.max_input_tokens === undefined || inputCount <= tier.max_input_tokens);
    }
    if ((tier.effective_from !== undefined && !isDate(tier.effective_from))
      || (tier.effective_through !== undefined && !isDate(tier.effective_through))) return reject();
    if (tier.effective_from !== undefined && tier.effective_through !== undefined && tier.effective_from > tier.effective_through) return reject();
    return (tier.effective_from === undefined || date >= tier.effective_from)
      && (tier.effective_through === undefined || date <= tier.effective_through);
  });
  return !malformed && matches.length === 1
    ? { input_per_mtok: matches[0].input_per_mtok, output_per_mtok: matches[0].output_per_mtok }
    : null;
}

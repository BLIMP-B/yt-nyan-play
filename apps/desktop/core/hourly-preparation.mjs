// Until a complete generation/synthesis/search/player measurement exists,
// prepare one minute ahead. Fast measured paths can start with the chime.
export function hourlyPreparationLead(measurement, budgetMs) {
  const elapsed = measurement?.preparationMs;
  if (!measurement?.preparationUnavailable && Number.isFinite(elapsed) && elapsed >= 0 && elapsed + 1000 <= budgetMs) return 0;
  return Math.min(180000, Math.max(60000, Math.ceil((Number.isFinite(elapsed) ? elapsed + 5000 : 60000) / 1000) * 1000));
}

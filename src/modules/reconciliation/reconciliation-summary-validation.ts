export function isValidBoundedReconciliationSweep(
  candidateCount: number,
  processedCount: number,
  deferredCount: number,
  maxOrderLookupsPerRun: number,
  issueCodes: readonly string[],
): boolean {
  const completedCount = processedCount + deferredCount;
  let deferredIssueCount = 0;
  for (const code of issueCodes) {
    if (code === "ORDER_LOOKUP_DEFERRED") deferredIssueCount += 1;
  }

  return Number.isSafeInteger(completedCount) &&
    completedCount === candidateCount &&
    processedCount <= maxOrderLookupsPerRun &&
    deferredIssueCount === (deferredCount > 0 ? 1 : 0);
}

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

await import("./env.test.js");
await import("./position-guard-pilot-config.test.js");
await import("./position-guard-pilot-authority.test.js");
await import("./position-guard-pilot-initializer.test.js");
await import("./position-guard-pilot-registry-loader.test.js");
await import("./create-app.test.js");
await import("./db-sqlite-wiring.test.js");
await import("./candidate-pilot-repository-contract.test.js");
await import("./candidate-evidence-service.test.js");
await import("./account-execution-lease-contract.test.js");
await import("./db-candidate-pilot-persistence.test.js");
await import("./risk-guards.test.js");
await import("./telegram-commands.test.js");
await import("./telegram-presentation.test.js");
await import("./snapshot-service.test.js");
await import("./portfolio-drift.test.js");
await import("./reconciliation-service.test.js");
await import("./portfolio-sync-service.test.js");
await import("./candidate-btc-run-preparation.test.js");
await import("./history-recovery-validation.test.js");
await import("./startup-recovery.test.js");
await import("./runtime-lifecycle.test.js");
await import("./sync-controller.test.js");
await import("./scheduler-preflight.test.js");
await import("./strategy-run-controller.test.js");
await import("./strategy-scheduler.test.js");
await import("./upbit-public-client.test.js");
await import("./upbit-private-client.test.js");
await import("./execution-service.test.js");
await import("./execution-send-authority.test.js");
await import("./execution-candidate-intent.test.js");
await import("./execution-candidate-final-authority.test.js");
await import("./telegram-delivery.test.js");
await import("./telegram-inbound.test.js");
await import("./telegram-inbound-smoke.test.js");
await import("./dryrun-readiness-smoke.test.js");
await import("./dryrun-sync-smoke.test.js");
await import("./dryrun-operator-smoke.test.js");
await import("./dryrun-completion-smoke.test.js");
await import("./live-readiness-smoke.test.js");
await import("./live-scheduler-preflight-smoke.test.js");
await import("./windows-task-scripts.test.js");
await import("./telegram-operator-contracts.test.js");
await import("./position-guard-market-structure.test.js");
await import("./position-guard-snapshot.test.js");
await import("./position-guard-context.test.js");
await import("./position-guard-runner.test.js");
await import("./position-guard-candidate-runner.test.js");
await import("./position-guard-core-strategy.test.js");
await import("./position-guard-backtest.test.js");
await import("./strategy-counterfactual.test.js");
await import("./performance-sensitivity.test.js");
await import("./performance-stability-validation.test.js");
await import("./performance-add-policy-evaluation.test.js");
await import("./performance-candle-coverage.test.js");
await import("./performance-hourly-coverage.test.js");
await import("./performance-add-diagnostics.test.js");
await import("./performance-add-excursions.test.js");
await import("./performance-add-loss-attribution.test.js");
await import("./performance-add-holdout-hypothesis.test.js");
await import("./performance-strategy-hypothesis-evaluation.test.js");
await import("./performance-combined-conservative-holdout.test.js");
await import("./performance-holdout-failure-diagnostics.test.js");
await import("./performance-holdout-episode-attribution.test.js");
await import("./performance-component-ablation.test.js");
await import("./position-guard-backtest-frames.test.js");
await import("./position-guard-backtest-report.test.js");
await import("./position-guard-public-backtest.test.js");
await import("./position-guard-candidate-state.test.js");
await import("./position-guard-candidate-policy.test.js");
await import("./position-guard-candidate-parity.test.js");
await import("./position-guard-candidate-dependency-boundary.test.js");
await import("./position-guard-policy-router.test.js");
await import("./candidate-pilot-recovery-fault-persistence.test.js");
await import("./position-guard-pilot-recovery.test.js");
await import("./candidate-bound-order-validation.test.js");
await import("./candidate-bound-order-intent-in-memory.test.js");
await import("./candidate-bound-order-intent-sqlite.test.js");
await import("./candidate-execution-authority.test.js");
await import("./performance-calculator.test.js");
await import("./performance-trade-matcher.test.js");
await import("./performance-diagnostics.test.js");
await import("./performance-attribution.test.js");
await import("./research-candle-dataset.test.js");
await import("./research-no-trade-evidence.test.js");
await import("./research-candle-dataset-builder.test.js");
await import("./upbit-research-candle-acquisition.test.js");
await import("./upbit-no-trade-evidence-acquisition.test.js");
await import("./upbit-no-trade-evidence-cli.test.js");
await import("./upbit-candle-dataset-cli.test.js");
await import("./performance-regimes.test.js");
await import("./performance-excursions.test.js");
await import("./performance-report.test.js");
await import("./integrated-strategy-evaluation.test.js");
const { runRegisteredTests } = await import("./harness.js");
await runRegisteredTests();

// Node test suites are isolated from the repository's shared custom harness.
const prospectiveTestPaths = [
  "./performance-prospective-shadow-registration.test.js",
  "./performance-prospective-shadow-registration-writer.test.js",
  "./performance-prospective-shadow-commitment.test.js",
  "./prospective-shadow-git-commitment-reader.test.js",
  "./prospective-shadow-commitment-cli.test.js",
  "./performance-prospective-shadow-evaluation.test.js",
  "./performance-prospective-shadow-replay.test.js",
  "./prospective-component-shadow-cli.test.js",
  "./prospective-shadow-dependency-boundary.test.js",
].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));
const prospectiveResult = await execFileAsync(process.execPath, ["--test", ...prospectiveTestPaths], {
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
});
process.stdout.write(prospectiveResult.stdout);
process.stderr.write(prospectiveResult.stderr);

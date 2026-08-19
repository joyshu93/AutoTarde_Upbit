# Architecture

## Core Principles

- TypeScript strict mode everywhere
- modular monolith first
- pure logic separated from side effects
- explicit state transitions for orders, fills, balances, positions, risk, and execution control
- no hidden defaults for execution behavior
- exchange and strategy boundaries designed for later replacement

## Module Map

### `domain`

Holds the explicit contracts that the rest of the system shares:
- supported assets and markets
- execution mode and operator state
- strategy decision records
- order, order-event, and fill records
- risk and reconciliation records

### `strategy`

Produces deterministic decisions only.

It must:
- be inspectable
- avoid discretionary judgment
- emit inputs suitable for execution and audit

It must not:
- talk directly to Telegram
- submit orders
- mutate persistence

Current strategy direction:
- the runtime app still wires a safe `HOLD` stub
- the first pure `PositionGuard_PaperTrade` core port exists in `position-guard-core`
- the first pure `PositionGuard_PaperTrade` market-structure analyzer port exists in `market-structure`
- `position-guard-snapshot` now normalizes Upbit public ticker and 1h/4h/1d candle responses into the analyzer input shape
- live snapshot reads use exclusive timeframe-aligned boundaries, retaining 200 completed 1h/4h/1d candles for EMA200 without including the active candle
- `position-guard-context` now assembles persisted balances, positions, latest compatible strategy decisions, and recent filled sell context into the core decision input shape
- `position-guard-runner` now performs one explicit market cycle: public snapshot read, structure analysis, persisted context assembly, core decision, durable strategy-decision persistence, and optional `DRY_RUN` execution submission
- `position-guard-runner` also supports a non-mutating preview path that computes the same decision and order intent without persisting strategy decisions or submitting orders
- the port preserves invalidation-first exits, no-chase entries, staged entry/add sizing, soft reduce logic, and borderline hourly confirmation semantics
- borderline `DEFERRED_CONFIRMATION` decisions are persisted as `PENDING_CONFIRMATION` without an order; only a later matching `EXECUTED_AFTER_CONFIRMATION` decision is order-capable, and offline replay follows the same rule
- flat portfolios treat bearish exit evidence as risk avoidance and return `HOLD` without a sell quantity, so the strategy does not emit no-position exit orders
- REDUCE decisions avoid double-counting derived `riskLevel` summaries and require independent weakening evidence when the structure stage is still `NONE`, so borderline bearish momentum alone remains a HOLD
- PositionGuard now applies a profit-protective staged defensive exposure policy for open positions in weak downtrend, breakdown-risk, and profitable range-deterioration states, suppressing below-minimum reduce intents while preserving immediate invalidation exits
- `position-guard-backtest` provides a pure offline replay harness for PositionGuard analysis frames, applying fee, slippage, minimum-trade, turnover, drawdown, and regime/action metrics without touching DB, Telegram, exchange adapters, order lifecycle records, or live-send gates
- `position-guard-backtest-frames` converts completed historical 1h/4h/1d candle arrays into replay frames at 1h decision cutoffs, exposing source candle counts and latest close times so research runs can audit that no future candle data was used
- replay frames require 200 completed candles in every timeframe by default, and the public runner uses a 220-day warmup plus a 100-page fetch ceiling so EMA200 availability matches the live analyzer contract
- `position-guard-backtest-report` turns replay results into stable offline summaries with cash/buy-and-hold benchmarks, monthly returns, regime return contribution, skip-reason counts, trade diagnostics, action/regime counts, return, drawdown, turnover, fee, skipped-intent, time-in-market, and source-window warnings without touching DB, Telegram, exchange adapters, order lifecycle records, or live-send gates
- `position-guard-public-backtest` fetches paginated Upbit public 1h/4h/1d candles sequentially, de-duplicates overlapping pages, builds no-lookahead replay frames, and formats a research report without touching DB, Telegram, private exchange endpoints, order lifecycle records, or live-send gates
- Telegram `/run BTC|ETH` now exposes a controlled operator trigger for one runner cycle without enabling live order transmission
- Telegram `/preview BTC|ETH` exposes the same deterministic decision and order intent without persistence or order submission
- Telegram `/run BTC|ETH` runs a manual live persisted-health preflight before invoking the runner when the runtime is in `LIVE`
- the disabled-by-default strategy scheduler now uses the same runner/controller path and still inherits the default live-order blockers
- scheduler `RUN_ON_START` runs configured markets sequentially so the account-scoped strategy runner lock does not skip the second market at startup
- live-mode scheduler startup now has an automatic preflight gate before timers are installed
- live-mode scheduled ticks first refresh exchange-backed account-health evidence with reconciliation source `SCHEDULER_PREFLIGHT`, then re-run the persisted-health preflight before invoking the strategy runner
- regular scheduler timer ticks are queued across configured markets for the exchange account, so simultaneous BTC/ETH timers do not produce account-lock `ALREADY_RUNNING` skips
- in `LIVE`, once a scheduled market tick submits an order, remaining market ticks from that same scheduler batch are persisted as `SKIPPED` and deferred to the next interval; scheduler batches use one-second granularity so millisecond-staggered BTC/ETH timers from the same cadence still share the same batch

### `performance`

Calculates and reports persisted order-stream performance without joining the runtime execution graph.

- `performance-calculator` is pure FIFO accounting over normalized fills, opening positions, and mark prices. It separates opening-inventory realized PnL from selected-stream realized PnL and preserves missing fees or costs as unknown values and warnings.
- `performance-trade-matcher` is pure FIFO evidence matching. It emits auditable realization slices and separate flat-to-flat position episodes, keeps opening inventory outside selected-strategy episodes, orders fills by exact offset-aware epoch nanoseconds with stable fill-ID ties, and rejects opposite-side fills for one market at the same exact instant as ambiguous.
- `performance-diagnostics` is pure statistics over normalized fills and persisted marks. Completed position episodes define the default win rate, while FIFO-slice outcomes remain separate. Mark curves expose `persistedObservationCount` and `usableObservationCount`; missing, wholly unusable, and partially usable mark sets surface as `MARK_DATA_UNAVAILABLE`, `MARK_DATA_UNUSABLE`, and `MARK_DATA_PARTIAL` integrated gaps without interpolation or future observations. Additive mark-exclusion manifests identify the persisted snapshot, market, affected metric scope, and stable reason codes for every excluded observation; they diagnose evidence completeness but do not repair or replace it.
- `sqlite-performance-reader` is a read-only adapter that constructs calculator and diagnostic input from explicitly selected account, execution mode, order origin, and optional `[from,to)` bounds. It validates order/fill/strategy-decision relationships, exposes persisted mark observations, and records a strictly pre-first-fill attribution baseline separately from the period-opening snapshot. A missing persisted fill fee may use an exact single-fill/single-trade order-response match; ambiguous evidence remains unknown. It opens an existing database with `DatabaseSync(path, { readOnly: true })` directly and never imports migration or runtime wiring.
- the opening snapshot is the latest snapshot at or before `from`, or the latest snapshot before the first selected fill when `from` is absent. The mark snapshot is the latest strictly before exclusive `to`, or the latest available snapshot when `to` is absent.
- `performance-report` is a thin CLI that validates all arguments and formats stable text or finite JSON with BTC/ETH and combined episode, FIFO, fee, action-contribution, realized-drawdown, and snapshot-mark diagnostics plus complete snapshot and fill provenance. It does not call Upbit, Telegram, reconciliation, strategy, scheduler, execution, or order mutation paths.
- the report describes the selected order stream and its opening inventory, not account-wide return. Deposits, withdrawals, unrelated origins, and unexplained balance changes are outside its PnL attribution.
- `performance-attribution`, `research-candle-dataset`, `strategy-counterfactual`, `performance-sensitivity`, `performance-regimes`, and `performance-excursions` are pure research modules. They preserve structured evidence gaps, original offset/nanosecond frame timestamps with exact-instant ordering, immutable local-dataset checksums, independent BASELINE/NO_ADD replay, explicit modeled-cost cells, existing frame-time regimes, and completed-episode MAE/MFE boundaries.
- `research-candle-dataset-builder` is a pure acquisition-side module that filters complete intervals to the explicit requested range, orders `1h`/`4h`/`1d` candles by exact instant, delegates schema validation, calculates the canonical SHA-256 checksum, and produces deterministic JSON without network, filesystem, SQLite, secret, or runtime dependencies.
- `upbit-research-candle-acquisition` is an injected-reader service that requests the three timeframes through the existing historical public-candle pagination boundary with explicit page size and page limit. It returns only a complete validated dataset and non-mutation metadata; it neither constructs a private exchange client nor permits partial or silently shortened evidence.
- `research-candle-dataset-writer` publishes a checksum-verified temporary artifact to a caller-selected new path using no-overwrite semantics. `upbit-candle-dataset` is the standalone research CLI composition root exposed only through `research:candles`; it validates all six required arguments and the absent destination before constructing the unauthenticated public reader.
- the acquisition path is operator-invoked and research-only. No app, runtime, execution, scheduler, Telegram, reconciliation, private exchange, order, migration, or operational SQLite import path may reach its builder, acquisition service, writer, or CLI. Automated tests use injected fixtures and do not call Upbit; only an explicit manual CLI invocation may use the public candle network boundary.
- `research-no-trade-evidence` is a pure in-memory sidecar parser, parent validator, and hourly coverage classifier. It authenticates supplied evidence against the immutable parent dataset, derives only absolute UTC hour-aligned intervals fully contained in the parent range, rejects observed `1h` candles outside that grid, and exposes exact `[from,to)` missing and sub-hour uncovered ranges without synthesizing or interpolating candles. A source-level AST regression enforces its direct specifier allowlist across static, side-effect, export-from, dynamic-import, and `require` syntax, then follows literal relative edges for the transitive graph check. This guards declared source dependencies; it is not a proof against arbitrary runtime-generated module loading.
- `integrated-strategy-evaluation` is a research CLI composed from those pure modules and the existing read-only performance reader. It is reachable only through `report:strategy-evaluation`; app creation, runtime, execution, scheduler, Telegram, reconciliation, exchange, order, migration, and database-write graphs do not import it.
- `performance-stability-validation` is a pure anchored-forward subperiod analyzer. It slices caller-supplied non-overlapping `[from,to)` windows from continuous BASELINE and NO_ADD paths, preserves asset and modeled-cost separation, reports coverage without interpolation, and makes no statistical-significance claim.
- `performance-add-policy-evaluation` is a pure conditional-candidate gate evaluator. The integrated research CLI alone derives its finite full-path and exactly-three-window observations from continuous candidate, BASELINE, and NO_ADD replay evidence at explicit base/stress costs. It records raw nominal cadence, approved `NO_TRADE_INTERVAL` frame ranges, unexplained missing frames, duplicate/off-grid frames, window cadence, and upstream replay-state continuity. Approved no-trade frames are evidence rather than a gate failure; unexplained frame loss and sequence anomalies remain blocking. Conditional replays add auditable ALLOW/SUPPRESS evidence only for ADD decisions, while BASELINE and NO_ADD retain their prior output shapes. Policy support uses completed candidate-path episodes containing an explicit ALLOW whose ADD trade executed; per-window support requires the episode close inside `[from,to)`, preventing future-close leakage.
- `performance-candle-coverage` is a pure research evidence calculator over immutable local datasets and generated backtest-frame provenance. It keeps raw `1h/4h/1d` nominal-grid cadence and exact missing manifests as compatibility evidence, while the actual generated-candle sequence is authoritative for recursive feature input. `sourceSequenceStatus` is the gate; `clockGridStatus` reports `DENSE`, `SPARSE_BY_CONTRACT`, or `ANOMALOUS`. A sparse nominal boundary is preserved as `NO_TRADE_INTERVAL`, but duplicate, off-grid, post-boundary, future-reference, insufficient actual-candle, acquisition-boundary, and corrupt-data evidence remains blocking. It never repairs, interpolates, forward-fills, synthesizes candles/OHLCV/indicator inputs/frames, or feeds data back into strategy execution. Frames remain generated only at observed `1h` closes; this does not claim scheduler-clock replay equivalence.
- conditional candidate cells do not enter legacy stability, regime, excursion, or BASELINE/NO_ADD ADD-diagnostic analyzers. Those legacy paths retain only their original anchor scenarios, while conditional results are emitted in the separate optional `conditionalAddPolicyEvaluation` report section. When conditional scenarios are absent, the prior report shape is preserved exactly.
- `performance-add-diagnostics` is a pure descriptive counterfactual analyzer. It pairs NO_ADD-suppressed ADD decisions with BASELINE frames at the same exact instant, preserves regime and ATR evidence, and aggregates completed position episodes without mixing them with FIFO lots. ADD-fill contribution is attributed only through FIFO realization slices whose entry fill is that exact ADD; gross PnL remains available when valid while net PnL and fee impact remain `UNKNOWN` if any allocated fee evidence is missing.
- `performance-add-excursions` is a separate pure analyzer for executed ADD exposures. It measures long-side MAE/MFE from the ADD fill price through the completed episode close using actual persisted 1h candles. An interval excused by authoritative source no-trade evidence adds neither a candle nor an OHLC extreme; any unexplained missing interval keeps the excursion `UNKNOWN`. Open episodes, unmatched evidence, and non-executed counterfactual paths never produce partial numeric claims. Both ADD analyzers explicitly set `causalClaim: false` and are not connected to the execution graph.
- `performance-add-loss-attribution` is a pure diagnostic over existing ADD diagnostics, post-decision excursions, and caller-supplied existing-policy `researchSuppression` evidence. Its unit is one executed ADD fill, ordered by exact decision epoch and stable fill ID within its linked position episode. It preserves full, partial, and unrealized inventory states; gross contribution may remain known, but net contribution and fee impact remain `UNKNOWN` unless the persisted FIFO realization-slice fee evidence is complete. It forms only predeclared cohorts for regime, ATR shock, weakening stage, exact trend-alignment score, and ADD ordinal, plus exact existing-policy suppressed sets. It neither reimplements policy predicates nor imports DB, runtime, exchange, execution, scheduler, reconciliation, Telegram, or strategy side effects.
- `performance-add-holdout-hypothesis` is a pure cross-asset classifier over BTC and ETH ADD attribution and the existing candidate-gate matrix. It emits only `NOT_APPLICABLE`, `INSUFFICIENT`, `CONFLICTING`, or `READY_FOR_FUTURE_HOLDOUT` for the three existing conditional ADD candidates. The latter is a frozen future-data research hypothesis, not an eligibility override, causal conclusion, strategy change, runtime signal, or deployment permission.
- `integrated-strategy-evaluation` emits the optional `addLossAttribution` section only when both assets have the required anchor, conditional-candidate, ADD-diagnostic, excursion, and candidate-gate evidence. The section retains dataset, filter, cost-cell, validation-window, candidate, and suppression-evidence provenance. Text output bounds itself to the three largest known-net loss cohorts per asset; JSON retains all cohorts and completeness states. This optional research branch remains outside every execution, reconciliation, runtime, scheduler, Telegram, exchange, migration, and database-write import graph.
- the CLI accepts only `--execution-mode LIVE`. Its report has separate `OBSERVED_LIVE_ATTRIBUTION`, `SIMULATED_COUNTERFACTUAL`, and `MODELED_COST_SCENARIO` sections. It opens the operational SQLite database read-only, reads only caller-provided local candle files for simulations, does not collect candles or call a network fallback, and never aggregates independent BTC/ETH simulation capital into a portfolio return.
- observed attribution keeps `totals` (selected stream) separate from `openingInventoryTotals`; entry `sourceContributions` are selected-stream only, while exit `sourceContributions` retain distinct `SELECTED_STREAM` and `OPENING` maps. Cost cells likewise declare `costMetricScope: ALL_SIMULATED_FILLS` for `turnoverKrw`/`modeledFeesKrw` and `fifoOutcomeMetricScope: SELECTED_STREAM_FIFO` for completed-episode outcomes.
- omitted datasets produce `DATASET_UNAVAILABLE`. Supplied schema-valid datasets that are empty, cannot supply 200 completed candles per timeframe, or have no overlapping replay instant produce structured `DATASET_UNUSABLE` sections with `reasonCode` `EMPTY_TIMEFRAME_CANDLES`, `INSUFFICIENT_COMPLETED_CANDLES`, or `NO_OVERLAPPING_REPLAY_WINDOW`; invalid schema, checksum, asset, or market remains an explicit error.
- acquired datasets preserve checksum-backed provenance and are evidence for later analysis, not trading truth, a backtest result, or a recommendation. BTC and ETH are collected as separate immutable artifacts before their paths are supplied independently to integrated `BASELINE` and `NO_ADD` comparison.
- conditional ADD evaluation requires all three named candidates, both anchors, exactly three explicit windows, the first caller-ordered cell as a `0.0005` fee base with valid explicit slippage, and a distinct `0.001` fee / `0.002` slippage stress cell. Missing prerequisites stay explicit as `UNAVAILABLE`; unexplained full-path/window candidate-frame loss, blocking sequence anomalies, insufficient actual generated candles, upstream replay-state uncertainty, multi-timeframe recursive feature input failure, or insufficient completed policy-exposed episodes stays `INSUFFICIENT`. A nominal no-trade boundary alone is reported but is not synthetic missing data. Missing candles are never synthesized from previous closes or coarser candles. No result is a deployment decision.
- left-censored fees and inherent BASELINE/NO_ADD model divergence remain explicit unresolved evidence classes. The current W1/W2/W3 boundaries and 30 full-path / 10 per-window support thresholds are immutable inputs to the current evaluation; a later holdout must be reported as a separate evaluation rather than appended to or substituted for those windows.
- `position-guard-research-manifest` is the single frozen authority for the `BROAD_LOSS_CAUSE_V1` development range, windows, cost roles, timing models, candidate order, and inspectable policy thresholds. `position-guard-backtest`, `strategy-counterfactual`, and `performance-strategy-hypothesis-evaluation` derive their contracts from it rather than maintaining independent copies.
- The optional broad-loss section evaluates `HTF_TREND_GATE`, `STRICT_PULLBACK`, `EARLY_THESIS_FAILURE`, `ADD_LIMITED`, `COOLDOWN_CONTROL`, and `COMBINED_CONSERVATIVE` against `BASELINE` and `NO_ADD` on continuous BTC and ETH paths. Fixed windows slice those paths without resetting state; post-cutoff data is excluded; same-close and next-frame fills remain explicitly modeled. Per-asset `dataSufficiency` is separate from `directionalGateOutcome`, observable failure takes precedence, and cross-asset output is non-adjudicative. This graph remains read-only and disconnected from execution, scheduler, Telegram, reconciliation, exchange, migration, and database-write paths.
- broad path diagnostics reuse the existing FIFO/episode, regime, and excursion analyzers for every asset/scenario/timing/cost path. They preserve fee completeness, realized-PnL curves, streak and holding metrics, action contribution, MAE/MFE gaps, and exact intervention counts separately from the directional eligibility gate; unavailable window evidence is omitted rather than represented as a fabricated zero return.

### `risk`

Applies hard guardrails before an order can proceed.

Current guard families:
- global kill switch
- paused execution
- live-mode gate
- stale price guard
- stale-price evidence uses the exchange ticker timestamp that supplied the strategy reference price rather than resetting the capture time when submission begins
- duplicate order guard
- minimum order value guard
- per-asset allocation cap
- total exposure cap

The intended policy framing is budget-first:
- total exposure cap is the primary reserve control
- per-asset allocation caps are concentration backstops
- future strategy sizing should key off total equity / exposure budgets rather than a simplistic equal-slot asset count rule
- exposure cap checks apply to exposure-increasing orders; `ask` orders are modeled as risk-reducing exposure decreases for cap projection

### `execution`

Owns:
- order intent construction
- idempotency key generation
- persistence-before-submit behavior
- adapter invocation
- explicit failure recording
- pre-trade validation via Upbit `orders/chance` and `orders/test`

The execution layer is where `DRY_RUN` and `LIVE` diverge operationally, while still preserving the same durable order model.
The runtime wires the live Upbit adapter only when execution mode is `LIVE`, the live gate is enabled, and Upbit credentials are present; otherwise the send path remains the dry-run adapter.
For market sell intents where Upbit order input carries volume but no price, execution derives notional value from the strategy reference price and requested volume before applying local and exchange minimum-total guards.

### `exchange`

Owns exchange-specific behavior:
- Upbit private authentication
- request signing
- public ticker and candle reads for deterministic strategy inputs, including bounded 429 retry/backoff for Upbit public quotation rate limits
- balance queries
- order chance and order test paths
- create, cancel, and get-order methods

The exchange layer should not own portfolio policy or strategy behavior.

### `reconciliation`

Owns recovery-oriented comparison between persisted local lifecycle state and exchange-backed truth.

Current slice:
- exchange-backed active-order reconciliation through `/sync`
- local dry-run order repair during reconciliation, so `dryrun_*` UUIDs are never queried against Upbit as real exchange orders
- terminal-order fill backfill during `/sync`
- balance and position drift detection by comparing new exchange-backed snapshots against the prior persisted snapshots plus local fill history, using parsed timestamp instants rather than raw timestamp text
- fill backfill preserves Upbit order-level `paid_fee` as KRW fill-fee evidence when individual trade rows omit fee data, and KRW balance drift detection tolerates only explicit 1 KRW rounding dust after fee-adjusted fills
- portfolio drift detection re-evaluates otherwise-drifting windows with a bounded one-second fill-start grace so Upbit trade timestamps rounded to whole seconds do not create false drift when the fill explains the later snapshot
- terminal reconciliation rechecks stored canceled `bid`/`price` orders when the local raw payload or fill ledger shows executed volume, repairing filled Upbit market-buy dust-cancel records to local `FILLED`
- portfolio drift detection excludes simulated `DRY_RUN` fills because they do not mutate exchange balances
- startup recovery sweep when exchange-backed Upbit reads are configured
- per-run reconciliation lookup budgeting with oldest-first processing inside each priority tier
- checkpointed exchange-history recovery with an explicit stop-before boundary, explicit exchange-retention assumption metadata, `IN_PROGRESS` / `COMPLETE` coverage status, and separate `HIGH` / `PARTIAL` / `FAILED` confidence classification
- startup policy that can mark persisted operator state `DEGRADED` when unresolved portfolio drift remains after startup recovery

It should eventually reconcile:
- active orders
- fills
- balances
- positions
- execution failures that occurred between local persistence and exchange acknowledgement

### `telegram`

Telegram is an operator surface only.

It provides:
- `/help` for static command-contract inspection and operator safety boundaries
- `/start` as a transport-friendly alias to `/help`
- locale-aware `/config` for non-secret runtime configuration, ignored deprecated environment variables, enabled-feature credential requirements, live blockers, and explicit risk-limit inspection
- locale-aware `/readiness` operator summary over runtime config, execution state, worker status, latest persisted health records, and bounded local persistence health
- `/readiness detail` for the canonical technical check list; both forms classify reconciliation recovery progress as warnings while keeping portfolio drift and unresolved order recovery as blockers
- inspection commands
- pause/resume/killswitch controls
- reporting-friendly formatters
- a stable `telegram/formatter.ts` compatibility facade that re-exports the implementation from `telegram/presentation/technical.ts`, allowing focused presentation modules without changing existing imports
- persisted-status inspection that can summarize recent operator-state transitions
- locale-aware `/status` operator summary for execution mode, live-order availability and blockers, kill-switch and degraded state, scheduler timing, and latest persisted reconciliation health
- `/status detail` for the canonical technical execution view, including checkpointed exchange-history recovery progress, retention-assumption status, coverage status, confidence classification, scheduler counters, and recent state transitions
- locale-aware `/statehistory` for read-only execution_state transition history with KST guidance and unchanged canonical transition evidence
- locale-aware `/synchistory` for read-only persisted reconciliation_runs inspection with coverage/confidence guidance and unchanged canonical run evidence
- locale-aware `/recovery` for read-only checkpointed exchange-history recovery progress inspection without overstating archive completeness
- locale-aware `/alerts` summary for the bounded recent notification and delivery sample, including pending, due, scheduled retry, failed, lease, and recent attempt counts with the sample limits stated explicitly
- `/alerts detail` for the canonical technical notification, delivery-run, delivery-attempt, retry, and queue-metric output
- locale-aware `/risks` summary for recent persisted `risk_events`, including severity counts, rule explanations, original messages, and linked order or strategy-decision references
- `/risks detail` for the canonical technical risk-event list; both forms use the same single bounded local read
- locale-aware `/balances` and `/positions` summaries over the latest persisted exchange snapshots
- `/balances detail` and `/positions detail` for the canonical technical snapshot output; all four forms use the same bounded local reads and never accept manual portfolio input
- `/sync` for reconciliation-triggered snapshot and reconciliation record persistence with read-only public ticker valuation
- locale-aware `/sync` result presentation over the single existing reconciliation-controller result, retaining canonical status, raw request timestamp, and exact detail without performing another sync or any additional exchange, repository, strategy, scheduler, order, or notification action
- locale-aware `/preview BTC|ETH` for one non-mutating PositionGuard decision and order-intent preview, retaining canonical fields and Upbit order-shape semantics while adding no calculation, persistence, exchange read, reconciliation, or order transmission
- locale-aware `/run BTC|ETH` for one deterministic PositionGuard strategy runner cycle through the configured safe execution path; the presentation preserves canonical output, warns about LIVE transmission capability, and never equates submission acceptance with a fill
- `/status` concise strategy-scheduler state and per-market next-run timestamps
- `/status detail` strategy-scheduler lines for configured intervals, recent in-memory outcomes, persisted recent scheduler run history, startup preflight scope, detail, and check results
- `/readiness` warns when a `LIVE` scheduler is running while the latest persisted balance snapshot, position snapshot, or reconciliation run is older than the shortest configured scheduler interval
- live scheduler startup preflight blocks are persisted as operator notifications before startup can close local persistence
- live scheduler per-run account-refresh or preflight blocks are persisted as failed `strategy_scheduler_runs` plus operator notifications before any strategy decision or order intent is created
- scheduler-triggered failures, overlapping-run skips, and scheduler-triggered order submission/rejection outcomes are persisted as operator notifications so automatic operation does not fail silently
- Windows Task Scheduler helpers register manual-only launch wrappers around ignored local startup scripts; they never store secrets in task definitions or add startup/logon triggers
- locale-aware `/order <order-id|identifier> [detail]` contract: the default is a bounded lifecycle summary and `detail` preserves the canonical complete order, event payload, fill, and identifier output without exchange mutation
- locale-aware `/orders` summary for recent persisted lifecycle state and status counts, with exact `/order <id>` inspection hints
- `/orders detail` for the canonical bounded technical order list; both forms use the same single read-only order query
- locale-aware `/scheduler` summary that separates current in-memory scheduler status from the bounded persisted `strategy_scheduler_runs` sample and displays the newest three persisted runs
- `/scheduler detail` for the canonical runtime, startup-preflight, per-market, and latest-20 persisted-run output without triggering scheduler execution
- locale-aware `/inbound` summary that separates current in-memory polling state from persisted `telegram_inbound_offsets` progress and reports whether their next offsets agree
- `/inbound detail` for the canonical runtime polling and persisted-offset fields; both forms use at most one runtime snapshot and one offset read without polling Telegram or mutating offset state
- locale-aware `/pause`, `/resume`, and `/killswitch` result presentation over the existing persisted operator-state transitions, retaining canonical status, mode, gate, blocker, reason, and timestamp evidence
- future reconciliation inspection as a read-only operator view
- `/synchistory` summaries that expose bounded archival recovery progress such as checkpoint window movement, page counts, stop-before boundary, retention-assumption boundary, coverage status, truncation flags, and confidence classification
- execution_state transition history inspection from persisted state
- outbox-based Telegram delivery that persists first, then attempts best-effort send behind `ENABLE_TELEGRAM_DELIVERY`
- delivery kicks received while an inline delivery worker is already running are coalesced into a follow-up pass, so due notifications created during an in-flight pass are not stranded as `PENDING`
- disabled-by-default inbound polling that routes text commands only from the private chat whose source chat ID and sender ID both equal `TELEGRAM_OPERATOR_CHAT_ID`
- inbound polling splits long routed replies into bounded Telegram messages so large inspection views such as `/alerts` do not fail the command update
- a bounded `smoke:telegram:inbound` operator validation script that forces `DRY_RUN`, disables live orders and scheduler ticks, and calls only one inbound `pollOnce()` without starting the runtime loop
- a non-mutating `smoke:dryrun:readiness` local preflight that forces DRY_RUN/live-disabled/scheduler-disabled startup settings, reads local readiness evidence, and reports next actions before the local DRY_RUN runtime starts
- an exchange-backed `smoke:dryrun:sync` local rehearsal that forces DRY_RUN/live-disabled/Telegram-disabled/scheduler-disabled settings, runs `/sync`, then inspects balances, positions, readiness, and sync history without running strategy or transmitting orders
- a fixture-backed `smoke:dryrun:operator` command rehearsal that forces offline `DRY_RUN`, clears Upbit private read credentials for the process, disables Telegram delivery/inbound polling and the scheduler, then routes `/config`, `/status`, `/readiness`, `/sync`, `/balances`, `/positions`, `/run BTC|ETH`, `/orders`, `/scheduler`, and `/alerts`
- a local DRY_RUN scheduler launcher that keeps live-send disabled, runs `smoke:dryrun:sync` and `smoke:dryrun:readiness` before startup, then starts the runtime with the scheduler enabled and `RUN_ON_START=true` for an automatic scheduled-path rehearsal
- a persisted-evidence `smoke:dryrun:completion` gate that forces live-send, Telegram transport, and scheduler startup disabled, then reads local snapshots, reconciliation, risk, notification, and `strategy_scheduler_runs` evidence to decide whether the DRY_RUN automatic scheduler rehearsal is complete without mutating execution state

`/help` is intentionally contract-derived and locale-aware. Presentation defaults to `ko-KR`, supports only `ko-KR` and `en-US`, and does not read repositories, poll Telegram, inspect exchange state, start sync, start strategy runs, start scheduler ticks, mutate orders, or enable live order transmission.
`/status` is a locale-aware, inspection-only operator summary. `/status detail` preserves the canonical technical output and uses the same bounded repository reads; neither form calls Upbit, triggers reconciliation or strategy execution, starts scheduler work, mutates orders, or enables live order transmission.
`/balances` and `/positions` are locale-aware, inspection-only summaries of the latest persisted exchange snapshots. Their `detail` forms preserve the canonical technical output. These commands do not call Upbit, trigger sync, infer holdings from Telegram, or accept manual cash or position input.
`/orders` is a locale-aware, inspection-only summary of recent persisted order lifecycle records. `/orders detail` preserves the canonical technical list. Neither form submits, cancels, retries, reconciles, or otherwise mutates an order.
`/order <reference>` is a locale-aware, inspection-only lifecycle summary with bounded recent event and fill history. `/order <reference> detail` preserves the canonical technical order, full event payload, fill, and identifier output. Missing references do not trigger event or fill reads, and neither form calls Upbit or mutates orders.
`/risks` is a locale-aware, inspection-only summary of recent persisted risk history. `/risks detail` preserves the canonical technical risk-event list. Historical rows do not by themselves mean that a risk block is currently active; both forms use the same bounded repository read and do not evaluate risk, clear or create events, call Upbit, mutate orders, or change execution state.
`/alerts` is a locale-aware, inspection-only summary of a bounded recent notification and delivery sample. It displays at most three recent notifications, one delivery run, and one delivery attempt, states the underlying repository-read limits, and points to `/alerts detail` for the canonical technical output. Both forms use the same three bounded local reads and do not claim, send, retry, finalize, or mutate notifications; they also do not poll Telegram, call Upbit, run sync or strategy, mutate orders, or change execution state.
`/inbound` is a locale-aware, inspection-only summary of the current in-memory polling worker and persisted offset progress. `/inbound detail` preserves the canonical technical fields, including the bot-token reference. Both forms use at most one runtime-status callback and one persisted-offset read and do not call `getUpdates`, start or stop polling, route commands, save offsets, call Upbit, run sync or strategy, mutate orders, or change execution state.
The Telegram transport exposes typed HTML messages, inline keyboards, message editing, and callback acknowledgement. Callback updates are normalized separately from text messages, their durable offset is advanced before handling, and only a closed discriminated read-only action union is parsed. Valid callbacks are acknowledged before a dedicated `routeReadOnlyCallback` lookup and then edit only the originating bot message; they never enter the generic text `route()` mutation cases. Orders use five-row pages, alerts use three-row pages, and absolute numeric indexes resolve bounded navigation detail. Missing callback capabilities fail explicitly instead of reporting a false success.
Telegram interface setup is a separate non-trading startup service. It uses `setMyCommands` with the configured operator-chat scope to replace the Korean fallback menu and the `en` language-specific menu with deterministic command lists. The setup runs only when both the bot token and operator chat ID are configured, writes no database state, and exposes only configured/attempted/status plus stable secret-free failure metadata. Scheduler and inbound startup decisions are made independently, signal handlers are installed before waiting on Bot API profile calls when background work is active, and Bot API profile rejection cannot weaken or block trading-safety initialization.
`/pause`, `/resume`, and `/killswitch` keep their existing mutation path through `OperatorStateStore`; only the resulting Telegram presentation is localized. The formatter derives live-order availability from the resulting persisted state and configured send path, never clears a kill switch, and never overrides or performs a second state transition.
`/scheduler` is a locale-aware, inspection-only summary that labels current in-memory runtime state separately from persisted scheduler-run history. It displays every configured runtime market and at most three of the latest 20 persisted runs, while `/scheduler detail` preserves the canonical technical output. Both forms use the same single bounded history read and one runtime-status snapshot and do not start or stop timers, trigger scheduler ticks, run strategy or sync, call Upbit, create or mutate orders, change execution state, or alter scheduler-run records.
`/config` is intentionally non-secret and runtime-derived; it renders configured/not-configured booleans for secrets, exposes ignored deprecated environment variable names when present, and never prints raw credentials, tokens, or chat identifiers.
`/readiness` is an inspection-only, locale-aware summary with human-readable PASS/WARN/BLOCK guidance. `/readiness detail` preserves the canonical technical checks and safety boundaries. Both forms read the same bounded local state and runtime status, including active/non-terminal order count, recent risk `BLOCK` count, and pending operator notification count, but do not poll Telegram, call Upbit, start sync, run strategies, tick schedulers, mutate offsets, deliver notifications, or mutate orders.

It does not provide:
- portfolio truth entry
- cash recording
- manual position recording

### `db`

Owns repository interfaces and storage adapters.

The default runtime path is SQLite-backed local persistence via `DATABASE_PATH` (default: `./var/autotrade-upbit.sqlite`).
Persisted `execution_state` is the operator authority for runtime control, including pause, resume, kill-switch, and live-order gating decisions.
It also carries persisted `degraded_reason` / `degraded_at` metadata so startup health signals survive `/pause -> /resume` without being conflated with pause semantics.

This slice contains:
- the initial migration
- SQLite statement/type shapes
- repository contracts
- SQLite-backed runtime repositories
- in-memory implementations kept for isolated tests and temporary scaffolding

## Durable Records

The schema is centered on recovery and auditability:
- `users`
- `exchange_accounts`
- `execution_state`
- `execution_state_transitions`
- `strategy_decisions`
- `balance_snapshots`
- `position_snapshots`
- `orders`
- `order_events`
- `fills`
- `reconciliation_runs`
- `strategy_scheduler_runs`
- `operator_notifications`
- `operator_notification_delivery_attempts`
- `operator_notification_delivery_runs`
- `telegram_inbound_offsets`
- `risk_events`

The important design choice is that order lifecycle data is first-class. Balance or position drift must be explainable through orders, fills, cancellations, failures, reconciliation runs, and explicit operator-state transitions.
Single-order inspection reads only persisted `orders`, `order_events`, and `fills`, so it improves recoverability without becoming an execution trigger.
`operator_notifications` follow the same philosophy: delivery status is durable and separate from execution or reconciliation state.
Retry metadata is durable too, so delivery workers can reschedule without mutating execution or reconciliation records.
Lease metadata is durable as well, so workers can claim rows and finalize only when the claimed `lease_token` still matches.
`operator_notification_delivery_attempts` add append-oriented delivery observability without changing the current-summary semantics of `operator_notifications`.
`operator_notification_delivery_runs` add one row per delivery-worker execution so scheduled or inline workers leave a durable summary even when no notification was sent.
Delivery-worker queue metrics are currently derived from persisted notification, delivery-run, and attempt rows.
Readiness-local health metrics are likewise bounded persisted summaries only: active/non-terminal order count from order state, recent risk `BLOCK` count from `risk_events`, and pending operator notification count from `operator_notifications`.
`strategy_scheduler_runs` records scheduler-triggered strategy cycles separately from strategy decisions and orders so operators can inspect scheduler health without treating scheduler state as trading truth.
`telegram_inbound_offsets` records `getUpdates` transport progress, scoped by exchange account and non-secret bot-token fingerprint. It is durable transport state, not portfolio truth.

## Execution Modes

### `DRY_RUN`

- default runtime mode
- order intents are persisted to the active repository
- risk is evaluated
- the dry-run exchange adapter simulates submission without live transmission
- submitted dry-run orders are immediately settled with simulated `FILLED` lifecycle evidence and synthetic fills when the order shape supports it
- reconciliation repairs older local dry-run artifacts to terminal local states without issuing Upbit private order lookups
- operator surfaces still see realistic lifecycle records

### `LIVE`

- not wired as the default application path
- requires both `APP_EXECUTION_MODE=LIVE` and `ENABLE_LIVE_ORDERS=true`
- requires configured Upbit credentials before the live adapter can become the send path
- must still use the same order lifecycle tables and risk gates
- Upbit `price` market buys can return exchange state `cancel` after a successful fill when only dust-sized KRW or fee lock remains; filled `bid`/`price` snapshots are treated as local `FILLED` while preserving the raw exchange response, fill, and fee evidence

## Runtime Flow

1. Bootstrap configuration.
2. Optionally run an exchange-backed startup recovery sweep when Upbit read credentials are configured.
3. During startup recovery, persist fresh balance and position snapshots, reconcile orders/fills, detect unexplained portfolio drift, then apply the bootstrap-only `DEGRADED` policy if needed.
4. Load execution policy and operator state.
5. If the scheduler is enabled, build a scheduler startup preflight; in `LIVE` scope, block timer installation unless live-send configuration, execution state, fresh persisted snapshots, fresh latest reconciliation, and active-order state are safe.
6. Before each `LIVE` scheduled tick, run an exchange-backed account-health refresh that persists balance snapshots, position snapshots, and reconciliation evidence with source `SCHEDULER_PREFLIGHT`.
7. After that refresh, re-run the same persisted-health preflight and fail the scheduler run without creating a strategy decision if the account-health evidence is stale or unsafe.
8. If multiple configured market timers become due together, queue their scheduled strategy cycles for the exchange account instead of letting the account-scoped runner lock skip one market.
9. If a `LIVE` scheduled tick submits an order, record remaining ticks from the same one-second scheduler batch as `SKIPPED` and defer them to the next interval.
10. Build a deterministic strategy decision, either from an explicit operator `/run BTC|ETH` request or the disabled-by-default scheduler.
11. Convert the decision into an order intent with an idempotency key.
12. Run risk guards.
13. Run exchange pre-trade validation through `orders/chance` and `orders/test`.
14. Persist the order record and append an order event.
15. Call the exchange adapter.
16. Persist the updated order state.
17. Persist operator_notifications for significant operator-facing outcomes.
18. Kick best-effort Telegram delivery without letting network delivery alter execution outcomes.
19. If another delivery kick arrives while the inline worker is in flight, record a follow-up request and run one more delivery pass after the current pass finishes.
20. Due notifications are claimed with a lease token so concurrent workers do not finalize the same row blindly.
21. Delivery attempt outcomes are also written to `operator_notification_delivery_attempts` so operators can inspect recent send behavior separately from the summary row.
22. Delivery worker executions are written to `operator_notification_delivery_runs` with completed, skipped, or failed status.
23. Retryable Telegram delivery failures stay `PENDING` with future `next_attempt_at`, while permanent failures become `FAILED`.
24. Expose inspection and reconciliation surfaces.
25. If scheduler or inbound polling background timers are started, install signal handlers that stop Telegram inbound polling, stop scheduler timers, and close SQLite persistence on `SIGINT` / `SIGTERM`.
26. If no background runtime is started, close SQLite persistence immediately after the startup banner is printed.

## Failure Posture

The system prefers explicit failure records over silent suppression.

Examples:
- if risk blocks an order, persist a `risk_event`
- if exchange submission fails after local persistence, keep the order and mark it `FAILED`
- if order state cannot be reconciled, mark it for recovery rather than pretending success
- if exchange-backed snapshots move in a way the local fill ledger cannot explain, persist both reconciliation issues and `risk_events`, then consider `DEGRADED` during startup bootstrap
- if Telegram delivery fails, keep the notification and mark it `FAILED` rather than mutating execution or reconciliation outcomes
- if Telegram inbound reply delivery fails, surface that failure in polling status rather than mutating execution, reconciliation, or order state
- sanitize inbound polling failures before status storage so bot-token paths, bearer credentials, and secret-bearing query values cannot reach `/inbound` output
- if the Telegram inbound smoke script detects non-smoke safety settings after its forced environment patch, block polling and report the blocker explicitly
- if the dry-run readiness smoke detects live mode, live order gate, live send path, or scheduler startup settings after its forced environment patch, block startup preflight and report the blocker explicitly
- if the dry-run sync smoke detects live mode, live order gate, live send path, Telegram delivery/inbound, or scheduler startup settings after its forced environment patch, block the exchange-backed sync rehearsal and report the blocker explicitly
- if the dry-run operator smoke detects live, exchange-backed, Telegram-delivery, inbound-polling, or scheduler-enabled settings after its forced environment patch, block the rehearsal and report the blocker explicitly
- if the local DRY_RUN scheduler launcher sees missing placeholders, failed exchange-backed sync smoke, or failed readiness smoke, it refuses to start the scheduler runtime
- if the dry-run completion smoke detects live mode, live order gate, live send path, Telegram transport, scheduler startup settings, missing sync evidence, unresolved risk/notification/order state, or missing latest BTC/ETH scheduler completion evidence, block the promotion gate and report the blocker explicitly
- if a local LIVE startup script sees a blocking live readiness or scheduler-preflight smoke result, refuse to start the long-running runtime
- if live scheduler startup is requested while live-send configuration or persisted account health is unsafe, block scheduler timers and expose the startup preflight detail
- if live scheduler startup preflight blocks timers, persist an operator notification with the preflight detail and failed checks before startup shutdown can close persistence
- if live scheduler startup preflight is checked by a smoke command, report the same preflight result without starting timers, polling Telegram, calling Upbit, running `/sync`, running strategy, or submitting orders
- if live scheduler per-run account refresh or preflight blocks a tick, persist a failed scheduler run and operator notification without creating a strategy decision or order intent
- if a scheduled strategy run fails, overlaps a still-running market cycle, submits an order, or has its order rejected, persist an operator notification without changing the scheduler run outcome
- if runtime shutdown cleanup fails, report a partial shutdown failure instead of silently skipping resource cleanup

## Current Gaps

- exchange-history recovery now includes bounded recent windows, checkpointed archival closed-order sweeps, a configured stop-before boundary, explicit retention-assumption confidence semantics, page-limit truncation detection, lookup-failure confidence records, and a dedicated `/recovery` inspection view
- reconciliation is still only partially exchange-backed today
- runtime startup does not auto-run trading cycles unless `STRATEGY_SCHEDULER_ENABLED=true`; `/run BTC|ETH` and the scheduler both trigger the first `PositionGuard_PaperTrade` runner and submit eligible decisions into the default `DRY_RUN` execution lifecycle

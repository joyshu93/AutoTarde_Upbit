# Product Boundary

## Mission
Build an Upbit-based BTC/ETH spot execution system that can progress from `DRY_RUN` validation toward live trading without changing the core contracts for orders, fills, balances, risk, reconciliation, and operator control.

## In Scope
- Upbit private authentication and request signing
- BTC and ETH spot trading against KRW markets only
- deterministic, inspectable, rule-based strategy decisions
- order validation via exchange metadata and order-test path
- order create, cancel, and status inquiry interfaces
- balance and position snapshot persistence
- balance and position drift detection against persisted local state and fill history
- order, fill, reconciliation, and risk event persistence
- startup recovery and operator-triggered reconciliation entry points
- Telegram reporting and operator controls
- execution recovery and reconciliation loops

## Out of Scope
- manual balance or position entry through Telegram
- leveraged, margin, futures, or derivatives trading
- discretionary or LLM-based trade decisions
- news, sentiment, or narrative-based trading inputs
- multi-exchange support in the first release
- hidden fallbacks that silently alter execution behavior

## Truth Sources
The system of record is:
1. exchange state from Upbit
2. the local execution database

Telegram is not a truth source for balances, positions, or fills.

Research evaluation output is not a trading truth source. `report:strategy-evaluation` is LIVE-only and may read selected persisted LIVE execution evidence plus caller-supplied immutable local candle datasets to diagnose observed attribution and simulated counterfactuals, but it must not update balances, positions, orders, fills, risk, execution state, or strategy settings. Selected-stream and opening-inventory evidence must remain separate, as must observed, simulated, and modeled evidence classes.

An artifact produced by the manually invoked `research:candles` command is analysis evidence, not trading truth, a backtest result, or a trade recommendation. BTC and ETH acquisition is independent, uses only unauthenticated Upbit public candle endpoints, and records explicit requested-range, collection-time, source, market, and canonical SHA-256 provenance. It must not read private credentials or Telegram secrets, open operational SQLite, overwrite an existing artifact, or inspect or mutate operational state.

An independent no-trade evidence sidecar is immutable, caller-supplied research evidence that classifies only absolute UTC hour-aligned intervals fully contained in the parent range as dense or sparse. Sparse evidence is independently verified only when authenticated sidecar ranges cover every missing nominal hour; uncovered evidence remains an exact sub-hour `[from,to)` range rather than being rounded to a candle. The manually invoked `research:no-trade-evidence` CLI queries only missing parent hours through unauthenticated Upbit public `1m` candles after authenticating the parent and confirming that the output path is new. It never reads private credentials or Telegram secrets, opens SQLite, or invokes runtime, scheduler, strategy, reconciliation, migration, or order paths. Its output is no-overwrite and whole-acquisition: any pagination, source, cursor, validation, or parent-gap conflict failure produces no completed sidecar. V1 stores canonical response fingerprints, not raw response bodies or a source-page manifest; that provenance limitation requires a separate versioned artifact design to change. It may be supplied only to the read-only research evaluator as absence evidence for its exact authenticated parent dataset. It is not a backtest, strategy modification, deployment approval, LIVE action, trading truth, or runtime strategy input; it must not synthesize candles, interpolate gaps, or import operational/runtime paths.

## Execution Modes
- `DRY_RUN`: default mode; no live order transmission is permitted
- `LIVE`: implemented as a gated capability but disabled by default

Live mode requires both:
- explicit user intent
- explicit configuration enabling live order submission

The application may wire the live Upbit adapter only when `APP_EXECUTION_MODE=LIVE`, `ENABLE_LIVE_ORDERS=true`, and Upbit credentials are configured. If any condition is missing, the runtime must fall back to the dry-run send path.

## Asset And Market Limits
- assets: `BTC`, `ETH`
- markets: `KRW-BTC`, `KRW-ETH`
- spot only

## Operator Interface
Telegram may expose:
- `/help`
- `/config`
- `/readiness`
- `/status`
- `/statehistory`
- `/synchistory`
- `/recovery`
- `/alerts [detail]`
- `/risks [detail]`
- `/balances`
- `/positions`
- `/orders`
- `/order <order-id|identifier> [detail]`
- `/scheduler [detail]`
- `/inbound [detail]`
- `/pause`
- `/resume`
- `/killswitch`
- `/sync`
- `/preview BTC|ETH`
- `/run BTC|ETH`

Telegram commands are operational controls and inspection requests, not portfolio data entry.
`/help` may list supported Telegram commands from static command contracts and safety boundaries using `TELEGRAM_LOCALE`. The default is `ko-KR`, the only alternative is `en-US`, and it must not trigger exchange reads, sync, strategy runs, scheduler ticks, order mutation, or live order transmission.
`/config` may inspect non-secret runtime configuration, explicit risk limits, ignored deprecated environment variables, and live-send blockers in the configured locale, but it must render only configured/not-configured booleans for secrets, describe credentials as required only when their dependent feature is enabled, and must not mutate runtime or exchange state.
`/statehistory`, `/synchistory`, and `/recovery` may add locale-aware guidance and KST timestamps to their persisted evidence, but must retain the canonical technical body, keep the same bounded local reads, and must not turn historical or partial recovery evidence into current exchange truth.
`/readiness` may provide a locale-aware concise operator summary from runtime configuration, persisted execution state, runtime worker status, latest persisted health records, active-order counts, recent risk-block counts, and pending notification counts. `/readiness detail` preserves the canonical technical checks. Both forms are read-only and must not perform active probes, poll Telegram, call Upbit, trigger sync, run strategies, tick schedulers, mutate offsets, submit/cancel orders, or deliver notifications.
Telegram inbound polling is a transport for those commands only; it is disabled by default, accepts text commands only from the configured operator's private chat when both the source chat ID and sender ID match `TELEGRAM_OPERATOR_CHAT_ID`, and persists only update-offset transport progress.
Telegram transport may receive typed inline-button callback updates, but the accepted callback vocabulary is a closed read-only navigation set. Callback authorization requires both the private source chat ID and the sender ID to match `TELEGRAM_OPERATOR_CHAT_ID`; malformed, unknown, or mutation-shaped callback data is acknowledged without command routing or execution side effects. `/start` renders the read-only dashboard, and approved callbacks may inspect status, readiness, persisted balances, positions, orders, alerts, risks, and scheduler evidence by editing the originating bot message. Orders use five rows per page and alerts use three; callback navigation cannot represent execution, sync, pause, resume, or kill-switch actions.
When a bot token and operator chat ID are configured, startup may replace the operator chat's Telegram command menu with deterministic Korean fallback and English language-specific descriptions. Command-menu registration is profile configuration only: it does not route a command, read or mutate trading state, call Upbit, run sync or strategy, start a scheduler tick, or transmit an order. Registration failure is reported with secret-free status and must not block scheduler or inbound-polling startup.
Long inbound command replies may be split into multiple Telegram messages for transport limits; reply splitting must not alter execution, reconciliation, order, balance, or position truth.
Telegram `/start` renders the locale-aware read-only operator dashboard for first-run bot UX and does not add an execution command; `/help` remains the complete locale-aware command reference.
Telegram `/status` is a locale-aware concise operator summary by default. `/status detail` preserves the canonical technical execution, scheduler, reconciliation, recovery, and transition fields; both forms are read-only and must not trigger exchange calls, sync, strategy execution, scheduler ticks, order mutation, or live order transmission.
Telegram `/balances` and `/positions` may present locale-aware summaries of the latest persisted exchange snapshots. `/balances detail` and `/positions detail` preserve canonical technical fields. These commands must not call Upbit, trigger sync, infer holdings from Telegram messages, or accept manual cash or position input.
Telegram `/orders` may present a locale-aware recent-order lifecycle summary with exact `/order <id>` inspection hints. `/orders detail` preserves the canonical bounded technical list. Both forms are read-only and must not submit, cancel, retry, reconcile, or mutate orders.
Telegram `/order <reference>` may present a locale-aware lifecycle summary with bounded recent event and fill history. `/order <reference> detail` preserves canonical complete order, event payload, fill, and identifier fields. Both forms are read-only and must not query Upbit or mutate exchange or local order state.
Telegram `/risks` may present a locale-aware summary of recent persisted risk-event history, including severity counts, explanations, original messages, and linked order or strategy-decision references. `/risks detail` preserves the canonical technical list. Historical rows are not proof of a currently active risk block, and both forms must use the same bounded local read without evaluating risk, clearing or creating events, calling Upbit, mutating orders, or changing execution state.
Telegram `/alerts` may present a locale-aware summary of the bounded recent operator-notification and delivery sample, with repository-read limits stated explicitly and only the newest three notifications, one delivery run, and one delivery attempt displayed. `/alerts detail` preserves the canonical technical notification, delivery-run, delivery-attempt, retry, and queue output. Both forms must use the same three bounded local reads and must not claim, send, retry, finalize, or mutate notifications, poll Telegram, call Upbit, run sync or strategy, mutate orders, or change execution state.
Telegram `/scheduler` may present a locale-aware summary that explicitly separates current in-memory scheduler state from the bounded latest-20 persisted scheduler-run sample and displays only its newest three rows. `/scheduler detail` preserves the canonical runtime, startup-preflight, per-market, and persisted-run fields. Both forms must use the same single bounded history read and one runtime-status snapshot and must not start or stop timers, trigger scheduler ticks, run strategy or sync, call Upbit, create or mutate orders, change execution state, or alter scheduler-run records.
Telegram `/inbound` may present a locale-aware summary that explicitly separates the current in-memory polling state from persisted `telegram_inbound_offsets` progress and compares their next offsets when both are available. `/inbound detail` preserves the canonical technical runtime and persisted-offset fields. Both forms must use at most one runtime-status snapshot and one offset-record read, and must not poll Telegram, route commands, mutate offset state, call Upbit, run sync or strategy, mutate orders, or change execution state.
Telegram `/pause`, `/resume`, and `/killswitch` may return locale-aware control results after the existing persisted operator-state transition completes. Their presentation must preserve the exact command, accepted result, canonical status transition, execution mode, live gate, live-order blocker codes, kill-switch state, reason, and update time. Presentation must not alter transition semantics: `/resume` does not clear an active global kill switch and must not claim that execution resumed while blockers remain.
Telegram `/sync` may return a locale-aware result after the existing exchange-backed reconciliation request completes. The presentation must preserve the canonical request status, original request timestamp, and exact controller detail, and must not turn `COMPLETED` into a claim that reconciliation itself was drift-free. Formatting the result must not trigger a second sync, repository read, exchange call, strategy run, scheduler action, order mutation, or notification delivery.
`npm run smoke:telegram:inbound` may perform one bounded Telegram `getUpdates` poll for operator validation, but it forcibly uses `DRY_RUN`, disables live-send and scheduler paths, and never starts the long-running polling loop.
`npm run smoke:dryrun:readiness` may inspect local DRY_RUN runtime configuration and persisted readiness evidence before the local runtime starts, but it must not run `/sync`, run strategies, poll Telegram, start the scheduler, call Upbit, deliver notifications, or transmit orders.
`npm run smoke:dryrun:sync` may perform one exchange-backed DRY_RUN `/sync` rehearsal with Upbit read credentials and local persistence, but it must disable live-send, Telegram delivery/inbound polling, scheduler startup, strategy runs, and order transmission.
`npm run smoke:dryrun:operator` may run a fixture-backed local command rehearsal through the Telegram router, including `/sync` and `/run BTC|ETH`, but it forcibly uses `DRY_RUN`, clears Upbit private read credentials for the process, disables Telegram delivery/inbound polling, disables the scheduler, and must never transmit live orders.
The local DRY_RUN scheduler launcher may enable `STRATEGY_SCHEDULER_ENABLED=true` and `STRATEGY_SCHEDULER_RUN_ON_START=true` only while `APP_EXECUTION_MODE=DRY_RUN` and `ENABLE_LIVE_ORDERS=false`; it must require an explicit local DRY_RUN scheduler confirmation, run exchange-backed DRY_RUN sync/readiness checks before startup, and never enable live order transmission.
`npm run smoke:dryrun:completion` may inspect persisted DRY_RUN completion evidence after the automatic scheduler rehearsal, including latest snapshots, latest reconciliation, recent risk and notification state, and latest `strategy_scheduler_runs` for `KRW-BTC` and `KRW-ETH`, but it must force live-send disabled, Telegram transport disabled, scheduler startup disabled, and must not run `/sync`, run strategies, poll Telegram, start the scheduler, call Upbit, deliver notifications, create orders, or transmit orders.
`/alerts` may summarize persisted operator notifications, recent delivery-run rows, recent delivery-attempt audit rows, and derived delivery-worker queue metrics, but none of them become trading truth sources.
`/order <order-id|identifier> [detail]` may inspect one persisted order, its local lifecycle events, and its fills, but it must not query Telegram as truth or trigger exchange-side mutation.
`/preview BTC|ETH` may compute one deterministic PositionGuard strategy decision and order intent for a supported asset, but it must not persist a strategy decision, create an order, run reconciliation, or submit an order.
Telegram `/preview BTC|ETH` may present that result in the configured locale with readable action, execution-disposition, money, quantity, and order-intent semantics while preserving every canonical result field and the exact no-mutation boundary. Presentation must not recalculate strategy or order values, add repository or exchange reads, describe an intent as an executed order, or promise that a later `/run` will reproduce the same result from newer market and account state.
`/run BTC|ETH` may request one deterministic PositionGuard strategy cycle for a supported asset, but it must route through the configured execution path and inherits the default `DRY_RUN` live-send blockers. Its locale-aware presentation must retain all canonical result fields and exact detail, warn that LIVE mode can transmit a real order, and distinguish submission acceptance from fill completion. In `LIVE` mode, a manual `/run` must first pass the same persisted-health preflight family used for live scheduled ticks before any strategy decision or order intent is created.
`/scheduler [detail]` may inspect current in-memory scheduler status plus persisted `strategy_scheduler_runs`, but it must not trigger execution or mutate portfolio truth.
The strategy scheduler may run the same deterministic cycle automatically only when `STRATEGY_SCHEDULER_ENABLED=true`; it is disabled by default and does not bypass execution-state, risk, or live-send gates.
When the strategy scheduler is enabled in `LIVE` mode, startup safety must require persisted balance snapshots, position snapshots, and the latest reconciliation run to be fresh enough for the configured scheduler cadence; stale persisted health is not acceptable evidence for automatic trading.
Before each `LIVE` scheduled cycle, the scheduler must first run an exchange-backed account-health refresh that may persist balance snapshots, position snapshots, and reconciliation evidence with source `SCHEDULER_PREFLIGHT`; it must not create strategy decisions, order intents, or order lifecycle records.
After that refresh, the scheduler must re-run the same persisted-health preflight and block the strategy cycle before any order intent is created if account health is stale or unsafe.
If multiple configured market timers fire at the same time, scheduler-triggered market cycles must be serialized for the exchange account so the account-scoped strategy runner lock does not skip a market solely because another scheduled market started first.
In `LIVE` mode, if one scheduled market submits an order, later market ticks from the same scheduler batch must be recorded as `SKIPPED` and deferred to their next scheduled interval so account health can be refreshed after the exchange mutation.
Any local script that enables the live scheduler must keep automatic startup execution disabled by default and require a separate explicit confirmation that scheduled live orders are understood.
Any local script that starts LIVE mode must run the matching non-mutating live smoke first and refuse runtime startup when that smoke exits with a blocking failure.
Windows Task Scheduler helper scripts may register manual-only launch entries for local operation, but they must not add startup/logon triggers, store secrets in the task definition, or bypass application-level live gates.
Startup recovery is read-only against exchange truth and must never create or cancel orders.
When startup recovery confirms unresolved portfolio drift against persisted state, the operator state may move into `DEGRADED` without enabling any live path.

Read-only performance diagnostics may derive a missing fee only from exact persisted single-fill exchange-response evidence and may use a strictly pre-fill snapshot to classify external opening inventory. These are report-time evidence transformations only: they must not repair the operational DB, create synthetic orders or fills, call Upbit, or change strategy/runtime state.

Optional `NO_ADD` stability validation is an offline counterfactual diagnostic over explicit non-overlapping periods and continuous forward paths. It is not a live strategy rule, an automatic optimization step, or evidence that future returns are guaranteed.

ADD exposure diagnostics are descriptive offline evidence only. Same-instant BASELINE/NO_ADD pairing, regime labels, and associated completed-episode outcomes must not be described as proof that ADD caused profit or loss, and unsupported post-decision excursion or fee attribution must remain explicitly unknown.

Conditional ADD candidate evaluation is offline research evidence only. It requires all three named conditional scenarios, BASELINE and NO_ADD anchors, exactly three caller-selected validation windows, and explicit base/stress cost cells before candidate gates are built. Full-path and per-window observations must come from continuous replay paths, and a policy-exposed episode may enter a window support count only after its close is observed inside that `[from,to)` window. `ELIGIBLE_FOR_FURTHER_RESEARCH` is not approval to alter or deploy the live strategy.

Optional ADD loss attribution is offline research evidence only. It uses executed ADD fills as contribution units and keeps their FIFO realization slices separate from completed position episodes and their win rate. Partial or open ADD inventory remains visible rather than being treated as a completed trade. Missing entry or exit fee evidence keeps fee-dependent net contribution `UNKNOWN`; it is never replaced with zero. The cross-asset future-holdout classifier may return `NOT_APPLICABLE`, `INSUFFICIENT`, `CONFLICTING`, or `READY_FOR_FUTURE_HOLDOUT` for an existing conditional ADD candidate. `READY_FOR_FUTURE_HOLDOUT` only freezes an existing hypothesis for separately collected future data. It is not a deployment approval, does not change candidate eligibility, strategy rules, thresholds, execution state, or LIVE behavior, and does not establish causality.

The `BROAD_LOSS_CAUSE_V1` higher-timeframe trend, pullback, thesis-failure, ADD-limit, cooldown-control, and combined scenarios are offline research overlays only. They may be evaluated only through the explicit frozen profile with BTC and ETH kept independent, exact W1/W2/W3 windows, exact ordered BASE/STRESS costs, the frozen development cutoff, and both modeled timing paths. CLI parsing and the exported programmatic builder reject altered, missing, extra, reordered, or mislabeled scenarios and cost cells before persistence or replay, including any fee/slippage mismatch; report provenance uses the validated actual cell. Data sufficiency and directional failure remain separate; known failure cannot be hidden by missing evidence. `ELIGIBLE_FOR_SHADOW_TEST` is not permission to change strategy rules, execution state, scheduler configuration, or LIVE behavior.

The optional `COMBINED_CONSERVATIVE` holdout is a separate read-only research result. It replays continuously from the frozen development start, scores only an explicit post-cutoff `[from,to)` range, and compares the candidate independently with both `BASELINE` and `NO_ADD` under both timing models and both cost cells. The frozen development authority binds the initial state, development frames, cadence, and consumed `1h`/`4h`/`1d` feature coverage; a mismatch fails rather than silently redefining the candidate baseline. Feature-coverage inputs are clipped to the final analyzed frame, so later dataset candles cannot alter development or holdout evidence classification. A test-only injected verifier is labeled `UNVERIFIED_TEST_OVERRIDE`, forces carry-in evidence incomplete, and cannot produce shadow support. Existing pre-freeze data is labeled `RETROSPECTIVE_HOLDOUT`; only data whose explicit holdout begins at or after the frozen authority time may be labeled `PROSPECTIVE_SHADOW`. `SUPPORTS_CONTINUED_SHADOW` permits only further observation and is never deployment approval.

`COMBINED_CONSERVATIVE_AGGREGATE_FAILURE_DIAGNOSTICS` is a technical summary of each asset's 32 holdout comparisons: two timing models, two cost cells, two anchors, and four aggregate metrics. It is read-only descriptive evidence with `causalClaim: false` and `deploymentApproval: false`; its associations do not attribute failure to an individual component rule and are not evidence to change strategy rules or LIVE behavior.

The optional `broadStrategyShadowHoldoutComponentDiagnostics` report field is a separate, read-only retrospective component-ablation diagnostic for the frozen `COMBINED_CONSERVATIVE` policy. It replays exactly four leave-one-component-out variants, with no threshold search or additional combinations: `COMBINED_MINUS_HTF_TREND_GATE`, `COMBINED_MINUS_EARLY_THESIS_FAILURE`, `COMBINED_MINUS_ADD_LIMITED`, and `COMBINED_MINUS_COOLDOWN_CONTROL`. `STRICT_PULLBACK` is not a combined component and is not ablated. The matrix has exactly 32 continuous paths: `2` assets x `2` modeled timings x `2` frozen cost cells x `4` variants. It compares each variant only with the full combined path inside the same asset/timing/cost cell, matches episodes by the exact first executed `ENTER` decision instant using epoch-nanosecond time, and keeps FIFO realization slices separate from flat-to-flat position episodes. Partial exits remain in their one episode; carry-in and open-at-end episodes remain visible but are excluded from closed known-net-PnL comparison.

JSON retains complete per-cell provenance and metrics plus detached, deeply frozen episode evidence rather than reducing the result to counts. Episode envelopes explicitly retain scenario/asset/market/timing/cost identity, episode and entry/exit/modeled-attribution/legacy-intervention fill IDs, FIFO realization-slice IDs, intervention-evidence IDs, exact decision/execution/open/close time identities, gross/fee/net PnL, opened/realized/remaining quantities, duration, and carry/open/known-net flags. Separate ordered reference/ablation intervention records retain stable IDs, decision evidence and frame/time, action/outcome/reason, and nullable fill, strategy-decision, and episode links; a suppressed intervention does not require an invented fill. Each ablation classification is frozen behind nine explicit completeness gates: cadence, consumed feature coverage, carry-in state, reference lifecycle, ablation lifecycle, reference fees, ablation fees, reference finite metrics, and ablation finite metrics. Any incomplete gate, unresolved episode evidence, or inadequate completed-episode support produces `INSUFFICIENT_EVIDENCE`. Otherwise the frozen tolerance comparison yields only `PROTECTIVE_ASSOCIATION`, `HARM_ASSOCIATION`, `MIXED_ASSOCIATION`, or `NO_MEASURABLE_DIFFERENCE`; these are descriptive associations, not causal findings. Holdout evidence is bounded to `[from,to)` so future data is excluded. Because the diagnostic was designed after the observed holdout outcome, it is retrospective only and has `readOnly: true`, `causalClaim: false`, `deploymentApproval: false`, and `prospectiveApproval: false`; it cannot authorize deployment, prospective testing, strategy changes, or LIVE behavior. It has no execution graph, runtime, API, Telegram, order, sync, scheduler, or migration connection.

Verified source no-trade intervals are absence evidence only: they contribute no synthetic candle or OHLC extreme. Unexplained hourly gaps keep affected excursion metrics `UNKNOWN`. Persisted-mark exclusion manifests explain exactly which stored observations were excluded and why, without repairing evidence. Left-censored fee evidence and BASELINE/NO_ADD model divergence remain unresolved rather than being inferred away. The existing W1/W2/W3 windows and 30 full-path / 10 per-window support thresholds are frozen; any future holdout is separate evidence and must not rewrite those results.

The `PROSPECTIVE_COMPONENT_SHADOW_V1` protocol is offline research only. Its public procedure has two distinct publication stages: Publication A first lands the complete implementation and read-only workflow on public `origin/main`; the experiment authority is then frozen against that commit with a 72-hour preparation lead; Publication B later adds only the canonical registration and registry entry. Its successful Actions run must have a GitHub server `created_at` at least 48 hours before the future window. The Publication B Actions run supplies the external commitment evidence. Neither stage connects the experiment to APIs, operational SQLite/DB, Upbit acquisition, Telegram, orders, scheduler/runtime, process control beyond narrowly allowlisted read-only Git inspection, or LIVE approval. No actual `PCS-2026-001` registration has been created in this repository yet.

The registered window is a fixed 120-day `[from,to)` no-peek period. Before `to`, the only valid evaluation state is `COLLECTING`; after the boundary the result may be `REGISTRATION_INVALID`, `REJECTED`, `INSUFFICIENT`, or `SUPPORTS_CONTINUED_SHADOW` according to the frozen evidence policy. None of these statuses authorizes strategy changes, deployment, DRY_RUN/LIVE execution, or order transmission.

## Design Consequences
- every order must have an explicit lifecycle record
- every fill must be recoverable from reconciliation
- every exchange-history recovery uncertainty must remain explicit through coverage, retention-assumption, and confidence metadata
- portfolio drift comparison must compare fill and snapshot timestamps as instants, not as raw timestamp strings
- every risk rejection must be persisted
- exposure caps must not block risk-reducing sell orders solely because current exposure is already above cap
- every unexplained balance or position drift must be persisted as both reconciliation evidence and risk evidence
- every transition into pause or kill-switch state must be explicit and inspectable
- every transition into or out of `DEGRADED` must be explicit and inspectable
- every scheduler-triggered cycle must leave inspectable run history without becoming portfolio truth
- live-send capability must stay behind a separate safety gate even after implementation exists
- research evaluation must remain isolated from app, execution, scheduler, Telegram, reconciliation, exchange, and runtime dependency graphs; it may open the operational SQLite database only with `readOnly: true`, must reject non-LIVE observed filters, and must not use a network fallback for absent or unusable candle data
- immutable research candle acquisition must remain isolated from app, execution, scheduler, Telegram, reconciliation, private exchange, orders, migrations, operational SQLite, and runtime dependency graphs; only an explicit operator invocation may call unauthenticated Upbit public candle endpoints
- research candle acquisition must require explicit asset, history start, end, new output path, page size, and page limit; it must checksum-verify provenance, refuse overwrite, fail rather than silently truncate coverage, and leave no completed destination artifact after failure
- omitted candle datasets must remain `DATASET_UNAVAILABLE`; supplied schema-valid but inadequate or non-overlapping datasets must remain structured `DATASET_UNUSABLE` evidence, while malformed, checksum-invalid, or asset/market-mismatched datasets fail explicitly
- performance evidence must preserve exact offset/nanosecond instant ordering, separate selected-stream from opening-inventory attribution, distinguish persisted from usable marks, and declare whether modeled cost and FIFO outcome metrics cover all simulated fills or selected-stream FIFO evidence
- ADD contribution diagnostics are descriptive counterfactual research only: they attribute exact FIFO slices entered by a simulated ADD fill and use complete persisted candle intervals for post-decision MAE/MFE; they do not establish causality, alter strategy rules, or enter the live execution graph
- conditional ADD candidate policies and `performance-add-policy-evaluation` must remain outside app, execution, scheduler, Telegram, reconciliation, exchange, runtime, and database-write graphs; legacy stability and ADD-diagnostic paths continue to receive only BASELINE and NO_ADD evidence
- conditional ADD coverage must preserve the raw nominal clock-grid gap manifest without interpolation. A boundary with no generated Upbit candle is recorded as `NO_TRADE_INTERVAL` evidence, while duplicate, off-grid, post-boundary, future-reference, unexplained candidate-frame, acquisition-boundary, and dataset-corruption evidence remains explicit and blocking
- conditional ADD feature coverage must inspect the observed generated-candle sequences for `1h`, `4h`, and `1d` prefixes actually consumed by each decision. `sourceCadenceStatus` and `sourceMissing*` remain nominal-grid compatibility evidence; `sourceSequenceStatus` is the authoritative feature and candidate gate, and `clockGridStatus` distinguishes `DENSE`, `SPARSE_BY_CONTRACT`, and `ANOMALOUS`. The 200-candle minimum requires 200 actual generated candles, not synthetic clock-grid placeholders
- generated `1h` closes are the only decision-frame source. Offline research does not synthesize, interpolate, or forward-fill candles, OHLCV, indicator inputs, or frames, and this candle-close replay contract does not claim scheduler-clock replay equivalence. MAE/MFE excursion evidence remains independently `UNKNOWN` when required observed intraperiod OHLC is absent

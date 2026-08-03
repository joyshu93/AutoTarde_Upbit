# Telegram Korean-First Operator UX Design
## Goal

Make the Telegram operator interface Korean-first and easier to operate without changing the exchange-backed truth model, persisted audit records, strategy decisions, risk policy, or live-order safety gates.

## Decisions

- `TELEGRAM_LOCALE` accepts `ko-KR` and `en-US`; the explicit default is `ko-KR`.
- Locale changes require process restart. No `/language` command and no locale database migration are introduced.
- Canonical domain values such as `FILLED`, `LIVE`, `RECONCILIATION_DRIFT_DETECTED`, order IDs, and persisted payloads remain unchanged.
- Default Telegram replies use concise localized summaries. Existing exhaustive technical output remains available through a `detail` argument.
- `/start` and `/help` present a Korean-first operator dashboard and help surface.
- Inline buttons are read-only in this phase: navigation, refresh, detail, and pagination only.
- `/run`, `/resume`, `/pause`, `/killswitch`, and `/sync` remain text commands. Callback buttons must never reach those mutation paths.
- Telegram is never a balance or position system of record.

## Presentation Model

Every localized summary follows this order when applicable:

1. Result or current state
2. One-sentence explanation
3. Required operator action (`없음` when no action is required)
4. Key facts such as market, side, amount, quantity, and KST timestamp
5. Canonical codes or identifiers when they are needed for audit or follow-up

Formatting rules:

- Korean timestamps use `Asia/Seoul` and `YYYY-MM-DD HH:mm:ss`.
- KRW values use locale grouping and an explicit `원` suffix.
- BTC and ETH quantities retain enough precision to identify the stored value without floating-point noise.
- HTML parse mode is used for hierarchy. All dynamic values are escaped before interpolation.
- Order submission and order fill wording remain distinct.
- Non-blocking recovery is described as automatic synchronization; blocking drift remains visibly blocking.

## Module Boundaries

- `presentation/locale.ts`: locale parsing, default, localized labels, and message copy.
- `presentation/common.ts`: HTML escaping and money, quantity, percentage, and KST time formatting.
- `presentation/dashboard.ts`: `/start` and read-only dashboard navigation.
- `presentation/inspection.ts`: status, readiness, configuration, history, recovery, and inbound summaries.
- `presentation/portfolio.ts`: balances and positions.
- `presentation/orders.ts`: order list, detail, and pagination.
- `presentation/operations.ts`: scheduler, control-result, sync, preview, and run result copy.
- `presentation/alerts.ts`: operator notifications and risk events.
- `presentation/technical.ts`: the current exhaustive formatter implementation used by detail mode.
- `formatter.ts`: compatibility barrel and stable imports during migration.

## Telegram-Native Interaction

The transport supports:

- `sendMessage` with HTML parse mode and inline keyboard markup
- `editMessageText` for refresh, detail, and pagination without chat clutter
- `answerCallbackQuery` for immediate callback acknowledgement
- `callback_query` in `getUpdates.allowed_updates`
- localized `setMyCommands` registration for the configured operator chat

Callback authorization requires both the configured private chat ID and callback sender ID to match the operator chat ID. Callback data is validated against a closed read-only action union and stays below Telegram's callback-data size limit.

Supported callback actions:

- home/dashboard
- status summary/detail/refresh
- readiness summary/detail/refresh
- balances and positions
- orders previous/next/detail
- alerts previous/next/detail
- risks
- scheduler

Unknown, expired, or malformed callbacks return a localized non-mutating acknowledgement and do not call the command router mutation cases.

## Compatibility

- Existing slash commands remain supported.
- `/start` remains an alias for the help/dashboard surface.
- Existing notification rows and English persisted title/message fields remain readable.
- Delivery retry, lease, and audit behavior remains unchanged.
- The live execution adapter, scheduler, reconciliation, and risk services are not modified by this feature.

## Testing

- Environment tests prove `ko-KR` default and explicit `en-US` support.
- Locale contract tests prove Korean and English summaries retain canonical IDs/codes and required information.
- Formatting tests cover HTML escaping, KST, KRW, and crypto quantities.
- Transport tests cover markup, message editing, command registration, and callback acknowledgement.
- Inbound tests cover callback normalization, authorization, read-only routing, pagination, and malformed callbacks.
- Regression tests prove text mutation commands continue to use the existing command router and callback actions cannot invoke them.

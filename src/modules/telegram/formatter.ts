import type {
  BalanceSnapshotRecord,
  ExchangeBalance,
  ExecutionStateRecord,
  OrderRecord,
  PositionSnapshot,
  PositionSnapshotRecord,
  RiskEventRecord,
} from "../../domain/types.js";
import type { SupportedTelegramCommand, TelegramSyncResult } from "./interfaces.js";

const MANUAL_INPUT_NOTE = "Telegram does not accept manual cash or position input.";

export function formatStatusMessage(state: ExecutionStateRecord): string {
  return [
    "Execution Status",
    `mode: ${state.executionMode}`,
    `live_gate: ${state.liveExecutionGate}`,
    `system_status: ${state.systemStatus}`,
    `kill_switch: ${state.killSwitchActive ? "on" : "off"}`,
    `pause_reason: ${state.pauseReason ?? "none"}`,
    `updated_at: ${state.updatedAt}`,
  ].join("\n");
}

export function formatBalanceMessage(snapshot: BalanceSnapshotRecord | null): string {
  if (!snapshot) {
    return [
      "Balances Snapshot",
      "status: unavailable",
      "note: No exchange balance snapshot is stored yet.",
      `operator_boundary: ${MANUAL_INPUT_NOTE}`,
    ].join("\n");
  }

  const balances = tryParseJson<ExchangeBalance[]>(snapshot.balancesJson);

  return [
    "Balances Snapshot",
    `captured_at: ${snapshot.capturedAt}`,
    `source: ${snapshot.source}`,
    `total_krw_value: ${snapshot.totalKrwValue ?? "unknown"}`,
    ...formatBalanceLines(balances, snapshot.balancesJson),
    `operator_boundary: ${MANUAL_INPUT_NOTE}`,
  ].join("\n");
}

export function formatPositionMessage(snapshot: PositionSnapshotRecord | null): string {
  if (!snapshot) {
    return [
      "Positions Snapshot",
      "status: unavailable",
      "note: No exchange position snapshot is stored yet.",
      `operator_boundary: ${MANUAL_INPUT_NOTE}`,
    ].join("\n");
  }

  const positions = tryParseJson<PositionSnapshot[]>(snapshot.positionsJson);

  return [
    "Positions Snapshot",
    `captured_at: ${snapshot.capturedAt}`,
    `source: ${snapshot.source}`,
    ...formatPositionLines(positions, snapshot.positionsJson),
    `operator_boundary: ${MANUAL_INPUT_NOTE}`,
  ].join("\n");
}

export function formatOrdersMessage(orders: OrderRecord[]): string {
  if (orders.length === 0) {
    return [
      "Orders",
      "count: 0",
      "note: No orders are stored yet.",
    ].join("\n");
  }

  const sortedOrders = [...orders].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return [
    "Orders",
    `count: ${sortedOrders.length}`,
    ...sortedOrders.map(
      (order) =>
        `- ${order.updatedAt} | ${order.market} | ${order.side} | ${order.status} | mode=${order.executionMode} | price=${order.price ?? "market"} | volume=${order.volume ?? "notional"} | id=${order.identifier}`,
    ),
  ].join("\n");
}

export function formatRiskEventsMessage(events: RiskEventRecord[]): string {
  if (events.length === 0) {
    return [
      "Risk Events",
      "count: 0",
      "note: No risk events are stored yet.",
    ].join("\n");
  }

  const sortedEvents = [...events].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return [
    "Risk Events",
    `count: ${sortedEvents.length}`,
    ...sortedEvents.map(
      (event) => `- ${event.createdAt} | ${event.level} | ${event.ruleCode} | ${event.message}`,
    ),
  ].join("\n");
}

export function formatControlCommandMessage(
  command: SupportedTelegramCommand,
  state: ExecutionStateRecord,
): string {
  return [
    "Execution Control",
    `command: ${command}`,
    `result: accepted`,
    `system_status: ${state.systemStatus}`,
    `kill_switch: ${state.killSwitchActive ? "on" : "off"}`,
    `pause_reason: ${state.pauseReason ?? "none"}`,
    `updated_at: ${state.updatedAt}`,
  ].join("\n");
}

export function formatSyncMessage(result: TelegramSyncResult): string {
  return [
    "Reconciliation Sync",
    `status: ${result.status}`,
    `requested_at: ${result.requestedAt}`,
    `detail: ${result.detail}`,
    `operator_boundary: ${MANUAL_INPUT_NOTE}`,
  ].join("\n");
}

function formatBalanceLines(
  balances: ExchangeBalance[] | null,
  rawJson: string,
): string[] {
  if (!balances || balances.length === 0) {
    return [`balances_json: ${rawJson}`];
  }

  return [
    "balances:",
    ...balances.map(
      (balance) =>
        `- ${balance.currency} free=${balance.balance} locked=${balance.locked} avg_buy_price=${balance.avgBuyPrice} ${balance.unitCurrency}`,
    ),
  ];
}

function formatPositionLines(
  positions: PositionSnapshot[] | null,
  rawJson: string,
): string[] {
  if (!positions || positions.length === 0) {
    return [`positions_json: ${rawJson}`];
  }

  return [
    "positions:",
    ...positions.map(
      (position) =>
        `- ${position.market} qty=${position.quantity} avg=${position.averageEntryPrice ?? "unknown"} mark=${position.markPrice ?? "unknown"} value=${position.marketValue ?? "unknown"} exposure=${position.exposureRatio ?? "unknown"}`,
    ),
  ];
}

function tryParseJson<T>(rawJson: string): T | null {
  try {
    return JSON.parse(rawJson) as T;
  } catch {
    return null;
  }
}

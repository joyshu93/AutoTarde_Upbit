import type {
  BalanceSnapshotRecord,
  ClaimedOperatorNotificationRecord,
  ExecutionStateRecord,
  ExecutionStateTransitionRecord,
  ExchangeAccountRecord,
  FillRecord,
  HistoryRecoveryCheckpointRecord,
  OperatorNotificationDeliveryAttemptRecord,
  OperatorNotificationDeliveryTransition,
  OperatorNotificationRecord,
  OrderEventRecord,
  OrderRecord,
  PortfolioExposureSnapshot,
  PositionSnapshot,
  PositionSnapshotRecord,
  ReconciliationRunRecord,
  RiskEventRecord,
  StrategyDecisionRecord,
  SupportedAsset,
  SupportedMarket,
  UserRecord,
} from "../../../domain/types.js";
import type {
  SqliteBalanceSnapshotRow,
  SqliteExecutionStateRow,
  SqliteExecutionStateTransitionRow,
  SqliteExchangeAccountRow,
  SqliteFillRow,
  SqliteHistoryRecoveryCheckpointRow,
  SqliteOperatorNotificationDeliveryAttemptRow,
  SqliteOperatorNotificationRow,
  SqliteOrderEventRow,
  SqliteOrderRow,
  SqlitePositionSnapshotRow,
  SqliteReconciliationRunRow,
  SqliteRiskEventRow,
  SqliteStrategyDecisionRow,
  SqliteUserRow,
} from "../types.js";
import type { ExecutionRepository, OperatorStateStore } from "../interfaces.js";
import type { SqliteBootstrapOptions, SqlitePersistenceBundle } from "./contracts.js";
import { fromSqliteBoolean, parseJson, stringifyJson, toSqliteBoolean } from "./sqlite-shapes.js";
import { openSqliteDatabase } from "./sqlite-database.js";
import { createId } from "../../../shared/ids.js";

const ACTIVE_ORDER_STATUSES = new Set<OrderRecord["status"]>([
  "INTENT_CREATED",
  "PERSISTED",
  "SUBMITTING",
  "OPEN",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
  "RECONCILIATION_REQUIRED",
]);

export function createSqlitePersistence(options: SqliteBootstrapOptions): SqlitePersistenceBundle {
  const handle = openSqliteDatabase(options.databasePath);
  const repositories = new SqliteExecutionRepository(handle.db);

  const now = new Date().toISOString();
  const bootstrapStateInserted = ensureBootstrapRecords(handle.db, {
    user: {
      id: options.userId,
      telegramUserId: options.userTelegramId,
      telegramChatId: null,
      displayName: options.userDisplayName,
      createdAt: now,
      updatedAt: now,
    },
    exchangeAccount: {
      id: options.exchangeAccountId,
      userId: options.userId,
      exchange: "UPBIT",
      venueType: "SPOT",
      accountLabel: "primary",
      accessKeyRef: options.accessKeyRef,
      secretKeyRef: options.secretKeyRef,
      quoteCurrency: "KRW",
      isPrimary: true,
      createdAt: now,
      updatedAt: now,
    },
    executionState: {
      id: `execution_state_${options.exchangeAccountId}`,
      exchangeAccountId: options.exchangeAccountId,
      executionMode: options.executionMode,
      liveExecutionGate: options.liveExecutionGate,
      systemStatus: options.killSwitchActive ? "KILL_SWITCHED" : "RUNNING",
      killSwitchActive: options.killSwitchActive,
      pauseReason: null,
      degradedReason: null,
      degradedAt: null,
      updatedAt: now,
    },
  });

  if (bootstrapStateInserted) {
    recordExecutionStateTransition(handle.db, {
      id: createId("execution_state_transition"),
      exchangeAccountId: options.exchangeAccountId,
      command: "BOOTSTRAP",
      fromExecutionMode: null,
      toExecutionMode: options.executionMode,
      fromLiveExecutionGate: null,
      toLiveExecutionGate: options.liveExecutionGate,
      fromSystemStatus: null,
      toSystemStatus: options.killSwitchActive ? "KILL_SWITCHED" : "RUNNING",
      fromKillSwitchActive: null,
      toKillSwitchActive: options.killSwitchActive,
      reason: "bootstrap_seed",
      createdAt: now,
    });
  }

  return {
    repositories,
    operatorState: new SqliteOperatorStateStore(handle.db, options.exchangeAccountId),
    close() {
      handle.close();
    },
  };
}

export class SqliteExecutionRepository implements ExecutionRepository {
  constructor(private readonly db: import("node:sqlite").DatabaseSync) {}

  async saveStrategyDecision(record: StrategyDecisionRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO strategy_decisions (
        id, exchange_account_id, strategy_key, market, action, status,
        decision_basis_json, intended_notional_krw, intended_quantity,
        reference_price, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exchange_account_id = excluded.exchange_account_id,
        strategy_key = excluded.strategy_key,
        market = excluded.market,
        action = excluded.action,
        status = excluded.status,
        decision_basis_json = excluded.decision_basis_json,
        intended_notional_krw = excluded.intended_notional_krw,
        intended_quantity = excluded.intended_quantity,
        reference_price = excluded.reference_price,
        created_at = excluded.created_at
    `).run(
      record.id,
      record.exchangeAccountId,
      record.strategyKey,
      record.market,
      record.action,
      record.status,
      record.decisionBasisJson,
      record.intendedNotionalKrw,
      record.intendedQuantity,
      record.referencePrice,
      record.createdAt,
    );
  }

  async saveOrder(record: OrderRecord): Promise<void> {
    this.upsertOrder(record);
  }

  async updateOrder(record: OrderRecord): Promise<void> {
    this.upsertOrder(record);
  }

  async findOrderByIdempotencyKey(exchangeAccountId: string, idempotencyKey: string): Promise<OrderRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM orders
      WHERE exchange_account_id = ? AND idempotency_key = ?
      LIMIT 1
    `).get(exchangeAccountId, idempotencyKey) as SqliteOrderRow | undefined;

    return row ? mapOrderRow(row) : null;
  }

  async listActiveOrders(exchangeAccountId: string, market?: SupportedMarket): Promise<OrderRecord[]> {
    const rows = market
      ? (this.db.prepare(`
          SELECT * FROM orders
          WHERE exchange_account_id = ? AND market = ?
          ORDER BY updated_at DESC
        `).all(exchangeAccountId, market) as unknown as SqliteOrderRow[])
      : (this.db.prepare(`
          SELECT * FROM orders
          WHERE exchange_account_id = ?
          ORDER BY updated_at DESC
        `).all(exchangeAccountId) as unknown as SqliteOrderRow[]);

    return rows.map(mapOrderRow).filter((order) => ACTIVE_ORDER_STATUSES.has(order.status));
  }

  async listOrders(exchangeAccountId: string): Promise<OrderRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM orders
      WHERE exchange_account_id = ?
      ORDER BY updated_at DESC
    `).all(exchangeAccountId) as unknown as SqliteOrderRow[];

    return rows.map(mapOrderRow);
  }

  async appendOrderEvent(record: OrderEventRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO order_events (id, order_id, event_type, event_source, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.orderId,
      record.eventType,
      record.eventSource,
      record.payloadJson,
      record.createdAt,
    );
  }

  async saveFill(record: FillRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO fills (
        id, order_id, exchange_fill_id, market, side, price, volume,
        fee_currency, fee_amount, filled_at, raw_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_id, exchange_fill_id) DO UPDATE SET
        market = excluded.market,
        side = excluded.side,
        price = excluded.price,
        volume = excluded.volume,
        fee_currency = excluded.fee_currency,
        fee_amount = excluded.fee_amount,
        filled_at = excluded.filled_at,
        raw_payload_json = excluded.raw_payload_json
    `).run(
      record.id,
      record.orderId,
      record.exchangeFillId,
      record.market,
      record.side,
      record.price,
      record.volume,
      record.feeCurrency,
      record.feeAmount,
      record.filledAt,
      record.rawPayloadJson,
    );
  }

  async listFills(orderId?: string): Promise<FillRecord[]> {
    const rows = orderId
      ? (this.db.prepare(`
          SELECT * FROM fills WHERE order_id = ? ORDER BY filled_at DESC
        `).all(orderId) as unknown as SqliteFillRow[])
      : (this.db.prepare(`
          SELECT * FROM fills ORDER BY filled_at DESC
        `).all() as unknown as SqliteFillRow[]);

    return rows.map(mapFillRow);
  }

  async saveBalanceSnapshot(record: BalanceSnapshotRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO balance_snapshots (
        id, exchange_account_id, captured_at, source, total_krw_value, balances_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exchange_account_id = excluded.exchange_account_id,
        captured_at = excluded.captured_at,
        source = excluded.source,
        total_krw_value = excluded.total_krw_value,
        balances_json = excluded.balances_json
    `).run(
      record.id,
      record.exchangeAccountId,
      record.capturedAt,
      record.source,
      record.totalKrwValue,
      record.balancesJson,
    );
  }

  async getLatestBalanceSnapshot(exchangeAccountId: string): Promise<BalanceSnapshotRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM balance_snapshots
      WHERE exchange_account_id = ?
      ORDER BY captured_at DESC
      LIMIT 1
    `).get(exchangeAccountId) as SqliteBalanceSnapshotRow | undefined;

    return row ? mapBalanceSnapshotRow(row) : null;
  }

  async savePositionSnapshot(record: PositionSnapshotRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO position_snapshots (
        id, exchange_account_id, captured_at, source, positions_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exchange_account_id = excluded.exchange_account_id,
        captured_at = excluded.captured_at,
        source = excluded.source,
        positions_json = excluded.positions_json
    `).run(
      record.id,
      record.exchangeAccountId,
      record.capturedAt,
      record.source,
      record.positionsJson,
    );
  }

  async getLatestPositionSnapshot(exchangeAccountId: string): Promise<PositionSnapshotRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM position_snapshots
      WHERE exchange_account_id = ?
      ORDER BY captured_at DESC
      LIMIT 1
    `).get(exchangeAccountId) as SqlitePositionSnapshotRow | undefined;

    return row ? mapPositionSnapshotRow(row) : null;
  }

  async getPortfolioExposure(exchangeAccountId: string): Promise<PortfolioExposureSnapshot> {
    const balanceSnapshot = await this.getLatestBalanceSnapshot(exchangeAccountId);
    const positionSnapshot = await this.getLatestPositionSnapshot(exchangeAccountId);
    const positions = positionSnapshot ? parseJson<PositionSnapshot[]>(positionSnapshot.positionsJson) : [];
    const assetExposureKrw = positions.reduce<Record<SupportedAsset, number>>(
      (accumulator, position) => {
        accumulator[position.asset] += Number(position.marketValue ?? "0");
        return accumulator;
      },
      { BTC: 0, ETH: 0 },
    );

    return {
      totalEquityKrw: Number(balanceSnapshot?.totalKrwValue ?? "0"),
      totalExposureKrw: Object.values(assetExposureKrw).reduce((sum, value) => sum + value, 0),
      assetExposureKrw,
    };
  }

  async saveRiskEvent(record: RiskEventRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO risk_events (
        id, exchange_account_id, strategy_decision_id, order_id,
        level, rule_code, message, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exchange_account_id = excluded.exchange_account_id,
        strategy_decision_id = excluded.strategy_decision_id,
        order_id = excluded.order_id,
        level = excluded.level,
        rule_code = excluded.rule_code,
        message = excluded.message,
        payload_json = excluded.payload_json,
        created_at = excluded.created_at
    `).run(
      record.id,
      record.exchangeAccountId,
      record.strategyDecisionId,
      record.orderId,
      record.level,
      record.ruleCode,
      record.message,
      record.payloadJson,
      record.createdAt,
    );
  }

  async listRiskEvents(exchangeAccountId: string, limit?: number): Promise<RiskEventRecord[]> {
    const rows = typeof limit === "number"
      ? (this.db.prepare(`
          SELECT * FROM risk_events
          WHERE exchange_account_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        `).all(exchangeAccountId, limit) as unknown as SqliteRiskEventRow[])
      : (this.db.prepare(`
          SELECT * FROM risk_events
          WHERE exchange_account_id = ?
          ORDER BY created_at DESC, rowid DESC
        `).all(exchangeAccountId) as unknown as SqliteRiskEventRow[]);

    return rows.map(mapRiskEventRow);
  }

  async saveReconciliationRun(record: ReconciliationRunRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO reconciliation_runs (
        id, exchange_account_id, status, started_at, completed_at, summary_json, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exchange_account_id = excluded.exchange_account_id,
        status = excluded.status,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        summary_json = excluded.summary_json,
        error_message = excluded.error_message
    `).run(
      record.id,
      record.exchangeAccountId,
      record.status,
      record.startedAt,
      record.completedAt,
      record.summaryJson,
      record.errorMessage,
    );
  }

  async updateReconciliationRun(record: ReconciliationRunRecord): Promise<void> {
    await this.saveReconciliationRun(record);
  }

  async listReconciliationRuns(exchangeAccountId: string, limit?: number): Promise<ReconciliationRunRecord[]> {
    const rows = typeof limit === "number"
      ? (this.db.prepare(`
          SELECT * FROM reconciliation_runs
          WHERE exchange_account_id = ?
          ORDER BY started_at DESC, rowid DESC
          LIMIT ?
        `).all(exchangeAccountId, limit) as unknown as SqliteReconciliationRunRow[])
      : (this.db.prepare(`
          SELECT * FROM reconciliation_runs
          WHERE exchange_account_id = ?
          ORDER BY started_at DESC, rowid DESC
        `).all(exchangeAccountId) as unknown as SqliteReconciliationRunRow[]);

    return rows.map(mapReconciliationRunRow);
  }

  async saveHistoryRecoveryCheckpoint(record: HistoryRecoveryCheckpointRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO history_recovery_checkpoints (
        id, exchange_account_id, market, checkpoint_type, next_window_end_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(exchange_account_id, market, checkpoint_type) DO UPDATE SET
        id = excluded.id,
        next_window_end_at = excluded.next_window_end_at,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.exchangeAccountId,
      record.market,
      record.checkpointType,
      record.nextWindowEndAt,
      record.updatedAt,
    );
  }

  async listHistoryRecoveryCheckpoints(exchangeAccountId: string): Promise<HistoryRecoveryCheckpointRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM history_recovery_checkpoints
      WHERE exchange_account_id = ?
      ORDER BY market ASC, checkpoint_type ASC
    `).all(exchangeAccountId) as unknown as SqliteHistoryRecoveryCheckpointRow[];

    return rows.map(mapHistoryRecoveryCheckpointRow);
  }

  async getHistoryRecoveryCheckpoint(
    exchangeAccountId: string,
    market: SupportedMarket,
    checkpointType: HistoryRecoveryCheckpointRecord["checkpointType"],
  ): Promise<HistoryRecoveryCheckpointRecord | null> {
    const row = this.db.prepare(`
      SELECT * FROM history_recovery_checkpoints
      WHERE exchange_account_id = ? AND market = ? AND checkpoint_type = ?
      LIMIT 1
    `).get(exchangeAccountId, market, checkpointType) as SqliteHistoryRecoveryCheckpointRow | undefined;

    return row ? mapHistoryRecoveryCheckpointRow(row) : null;
  }

  async saveOperatorNotification(record: OperatorNotificationRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO operator_notifications (
        id, exchange_account_id, channel, notification_type, severity,
        title, message, payload_json, delivery_status, attempt_count,
        last_attempt_at, next_attempt_at, failure_class, lease_token,
        lease_expires_at, created_at, delivered_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        exchange_account_id = excluded.exchange_account_id,
        channel = excluded.channel,
        notification_type = excluded.notification_type,
        severity = excluded.severity,
        title = excluded.title,
        message = excluded.message,
        payload_json = excluded.payload_json,
        delivery_status = excluded.delivery_status,
        attempt_count = excluded.attempt_count,
        last_attempt_at = excluded.last_attempt_at,
        next_attempt_at = excluded.next_attempt_at,
        failure_class = excluded.failure_class,
        lease_token = excluded.lease_token,
        lease_expires_at = excluded.lease_expires_at,
        created_at = excluded.created_at,
        delivered_at = excluded.delivered_at,
        last_error = excluded.last_error
    `).run(
      record.id,
      record.exchangeAccountId,
      record.channel,
      record.notificationType,
      record.severity,
      record.title,
      record.message,
      record.payloadJson,
      record.deliveryStatus,
      record.attemptCount,
      record.lastAttemptAt,
      record.nextAttemptAt,
      record.failureClass,
      record.leaseToken,
      record.leaseExpiresAt,
      record.createdAt,
      record.deliveredAt,
      record.lastError,
    );
  }

  async saveOperatorNotificationDeliveryAttempt(
    record: OperatorNotificationDeliveryAttemptRecord,
  ): Promise<void> {
    this.db.prepare(`
      INSERT INTO operator_notification_delivery_attempts (
        id, notification_id, exchange_account_id, attempt_count, lease_token,
        outcome, failure_class, attempted_at, next_attempt_at, delivered_at,
        error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        notification_id = excluded.notification_id,
        exchange_account_id = excluded.exchange_account_id,
        attempt_count = excluded.attempt_count,
        lease_token = excluded.lease_token,
        outcome = excluded.outcome,
        failure_class = excluded.failure_class,
        attempted_at = excluded.attempted_at,
        next_attempt_at = excluded.next_attempt_at,
        delivered_at = excluded.delivered_at,
        error_message = excluded.error_message,
        created_at = excluded.created_at
    `).run(
      record.id,
      record.notificationId,
      record.exchangeAccountId,
      record.attemptCount,
      record.leaseToken,
      record.outcome,
      record.failureClass,
      record.attemptedAt,
      record.nextAttemptAt,
      record.deliveredAt,
      record.errorMessage,
      record.createdAt,
    );
  }

  async claimPendingOperatorNotifications(
    exchangeAccountId: string,
    input: {
      limit?: number;
      dueBefore?: string;
      claimedAt: string;
      leaseToken: string;
      leaseExpiresAt: string;
    },
  ): Promise<ClaimedOperatorNotificationRecord[]> {
    const dueBefore = input.dueBefore ?? null;
    const candidateRows = typeof input.limit === "number"
      ? (this.db.prepare(`
          SELECT id
          FROM operator_notifications
          WHERE exchange_account_id = ?
            AND delivery_status = 'PENDING'
            AND (? IS NULL OR next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND (lease_expires_at IS NULL OR ? IS NULL OR lease_expires_at <= ?)
          ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC, rowid ASC
          LIMIT ?
        `).all(
          exchangeAccountId,
          dueBefore,
          dueBefore,
          dueBefore,
          dueBefore,
          input.limit,
        ) as Array<{ id: string }>)
      : (this.db.prepare(`
          SELECT id
          FROM operator_notifications
          WHERE exchange_account_id = ?
            AND delivery_status = 'PENDING'
            AND (? IS NULL OR next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND (lease_expires_at IS NULL OR ? IS NULL OR lease_expires_at <= ?)
          ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC, rowid ASC
        `).all(
          exchangeAccountId,
          dueBefore,
          dueBefore,
          dueBefore,
          dueBefore,
        ) as Array<{ id: string }>);

    const claimedIds: string[] = [];
    const claimStatement = this.db.prepare(`
      UPDATE operator_notifications
      SET attempt_count = attempt_count + 1,
          last_attempt_at = ?,
          lease_token = ?,
          lease_expires_at = ?
      WHERE id = ?
        AND exchange_account_id = ?
        AND delivery_status = 'PENDING'
        AND (? IS NULL OR next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (lease_expires_at IS NULL OR ? IS NULL OR lease_expires_at <= ?)
    `);

    for (const row of candidateRows) {
      const result = claimStatement.run(
        input.claimedAt,
        input.leaseToken,
        input.leaseExpiresAt,
        row.id,
        exchangeAccountId,
        dueBefore,
        dueBefore,
        dueBefore,
        dueBefore,
      );
      if (result.changes > 0) {
        claimedIds.push(row.id);
      }
    }

    if (claimedIds.length === 0) {
      return [];
    }

    const fetchClaimedStatement = this.db.prepare(`
      SELECT * FROM operator_notifications
      WHERE id = ? AND lease_token = ?
      LIMIT 1
    `);

    return claimedIds
      .map((id) => fetchClaimedStatement.get(id, input.leaseToken) as SqliteOperatorNotificationRow | undefined)
      .filter((row): row is SqliteOperatorNotificationRow => Boolean(row))
      .map(mapOperatorNotificationRow)
      .filter(
        (row): row is ClaimedOperatorNotificationRecord =>
          row.leaseToken !== null && row.leaseExpiresAt !== null && row.lastAttemptAt !== null,
      );
  }

  async compareAndSetOperatorNotificationDeliveryStatus(
    transition: OperatorNotificationDeliveryTransition,
  ): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE operator_notifications
      SET delivery_status = ?, attempt_count = ?, last_attempt_at = ?, next_attempt_at = ?,
          failure_class = ?, lease_token = NULL, lease_expires_at = NULL,
          delivered_at = ?, last_error = ?
      WHERE id = ?
        AND lease_token = ?
    `).run(
      transition.deliveryStatus,
      transition.attemptCount,
      transition.lastAttemptAt,
      transition.nextAttemptAt,
      transition.failureClass,
      transition.deliveredAt,
      transition.lastError,
      transition.id,
      transition.leaseToken,
    );

    return result.changes > 0;
  }

  async listOperatorNotifications(exchangeAccountId: string, limit?: number): Promise<OperatorNotificationRecord[]> {
    const rows = typeof limit === "number"
      ? (this.db.prepare(`
          SELECT * FROM operator_notifications
          WHERE exchange_account_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        `).all(exchangeAccountId, limit) as unknown as SqliteOperatorNotificationRow[])
      : (this.db.prepare(`
          SELECT * FROM operator_notifications
          WHERE exchange_account_id = ?
          ORDER BY created_at DESC, rowid DESC
        `).all(exchangeAccountId) as unknown as SqliteOperatorNotificationRow[]);

    return rows.map(mapOperatorNotificationRow);
  }

  async listOperatorNotificationDeliveryAttempts(
    exchangeAccountId: string,
    limit?: number,
  ): Promise<OperatorNotificationDeliveryAttemptRecord[]> {
    const rows = typeof limit === "number"
      ? (this.db.prepare(`
          SELECT * FROM operator_notification_delivery_attempts
          WHERE exchange_account_id = ?
          ORDER BY attempted_at DESC, rowid DESC
          LIMIT ?
        `).all(exchangeAccountId, limit) as unknown as SqliteOperatorNotificationDeliveryAttemptRow[])
      : (this.db.prepare(`
          SELECT * FROM operator_notification_delivery_attempts
          WHERE exchange_account_id = ?
          ORDER BY attempted_at DESC, rowid DESC
        `).all(exchangeAccountId) as unknown as SqliteOperatorNotificationDeliveryAttemptRow[]);

    return rows.map(mapOperatorNotificationDeliveryAttemptRow);
  }

  async listPendingOperatorNotifications(
    exchangeAccountId: string,
    options?: {
      limit?: number;
      dueBefore?: string;
    },
  ): Promise<OperatorNotificationRecord[]> {
    const dueBefore = options?.dueBefore ?? null;
    const rows = typeof options?.limit === "number"
      ? (this.db.prepare(`
          SELECT * FROM operator_notifications
          WHERE exchange_account_id = ?
            AND delivery_status = 'PENDING'
            AND (? IS NULL OR next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC, rowid ASC
          LIMIT ?
        `).all(exchangeAccountId, dueBefore, dueBefore, options.limit) as unknown as SqliteOperatorNotificationRow[])
      : (this.db.prepare(`
          SELECT * FROM operator_notifications
          WHERE exchange_account_id = ?
            AND delivery_status = 'PENDING'
            AND (? IS NULL OR next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC, rowid ASC
        `).all(exchangeAccountId, dueBefore, dueBefore) as unknown as SqliteOperatorNotificationRow[]);

    return rows.map(mapOperatorNotificationRow);
  }

  private upsertOrder(record: OrderRecord): void {
    this.db.prepare(`
      INSERT INTO orders (
        id, strategy_decision_id, exchange_account_id, market, side, ord_type,
        volume, price, time_in_force, smp_type, identifier, idempotency_key,
        origin, requested_at, upbit_uuid, status, execution_mode,
        exchange_response_json, failure_code, failure_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        strategy_decision_id = excluded.strategy_decision_id,
        exchange_account_id = excluded.exchange_account_id,
        market = excluded.market,
        side = excluded.side,
        ord_type = excluded.ord_type,
        volume = excluded.volume,
        price = excluded.price,
        time_in_force = excluded.time_in_force,
        smp_type = excluded.smp_type,
        identifier = excluded.identifier,
        idempotency_key = excluded.idempotency_key,
        origin = excluded.origin,
        requested_at = excluded.requested_at,
        upbit_uuid = excluded.upbit_uuid,
        status = excluded.status,
        execution_mode = excluded.execution_mode,
        exchange_response_json = excluded.exchange_response_json,
        failure_code = excluded.failure_code,
        failure_message = excluded.failure_message,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.strategyDecisionId,
      record.exchangeAccountId,
      record.market,
      record.side,
      record.ordType,
      record.volume,
      record.price,
      record.timeInForce,
      record.smpType,
      record.identifier,
      record.idempotencyKey,
      record.origin,
      record.requestedAt,
      record.upbitUuid,
      record.status,
      record.executionMode,
      record.exchangeResponseJson,
      record.failureCode,
      record.failureMessage,
      record.createdAt,
      record.updatedAt,
    );
  }
}

export class SqliteOperatorStateStore implements OperatorStateStore {
  constructor(
    private readonly db: import("node:sqlite").DatabaseSync,
    private readonly exchangeAccountId: string,
  ) {}

  async getState(): Promise<ExecutionStateRecord> {
    const row = this.db.prepare(`
      SELECT * FROM execution_state
      WHERE exchange_account_id = ?
      LIMIT 1
    `).get(this.exchangeAccountId) as SqliteExecutionStateRow | undefined;

    if (!row) {
      throw new Error(`Execution state is missing for exchange account ${this.exchangeAccountId}.`);
    }

    return mapExecutionStateRow(row);
  }

  async listTransitions(limit = 20): Promise<ExecutionStateTransitionRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM execution_state_transitions
      WHERE exchange_account_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(this.exchangeAccountId, limit) as unknown as SqliteExecutionStateTransitionRow[];

    return rows.map(mapExecutionStateTransitionRow);
  }

  async pause(reason?: string): Promise<ExecutionStateRecord> {
    const current = await this.getState();
    return this.updateState(
      current,
      {
        systemStatus: current.killSwitchActive ? "KILL_SWITCHED" : "PAUSED",
        pauseReason: reason ?? current.pauseReason,
      },
      "/pause",
      reason ?? current.pauseReason,
    );
  }

  async resume(): Promise<ExecutionStateRecord> {
    const current = await this.getState();
    return this.updateState(
      current,
      {
        systemStatus: resolveResumedSystemStatus(current),
        pauseReason: null,
      },
      "/resume",
      null,
    );
  }

  async activateKillSwitch(reason?: string): Promise<ExecutionStateRecord> {
    return this.updateState(
      await this.getState(),
      {
        killSwitchActive: true,
        systemStatus: "KILL_SWITCHED",
        pauseReason: reason ?? "killswitch_activated",
      },
      "/killswitch",
      reason ?? "killswitch_activated",
    );
  }

  async setExecutionMode(mode: ExecutionStateRecord["executionMode"]): Promise<ExecutionStateRecord> {
    return this.updateState(
      await this.getState(),
      { executionMode: mode },
      "SET_EXECUTION_MODE",
      mode,
    );
  }

  async setLiveExecutionGate(gate: ExecutionStateRecord["liveExecutionGate"]): Promise<ExecutionStateRecord> {
    return this.updateState(
      await this.getState(),
      { liveExecutionGate: gate },
      "SET_LIVE_EXECUTION_GATE",
      gate,
    );
  }

  async markDegraded(reason?: string): Promise<ExecutionStateRecord> {
    const current = await this.getState();
    const degradedReason = reason ?? current.degradedReason ?? "startup_portfolio_drift_detected";
    const degradedAt = current.degradedAt ?? new Date().toISOString();

    return this.updateState(
      current,
      {
        systemStatus: resolveSystemStatusForDegradation(current),
        degradedReason,
        degradedAt,
      },
      "MARK_DEGRADED",
      degradedReason,
    );
  }

  async clearDegraded(reason?: string): Promise<ExecutionStateRecord> {
    const current = await this.getState();
    return this.updateState(
      current,
      {
        systemStatus: current.systemStatus === "DEGRADED" ? "RUNNING" : current.systemStatus,
        degradedReason: null,
        degradedAt: null,
      },
      "CLEAR_DEGRADED",
      reason ?? "startup_recovery_clean",
    );
  }

  private async updateState(
    current: ExecutionStateRecord,
    changes: Partial<
      Pick<
        ExecutionStateRecord,
        | "executionMode"
        | "liveExecutionGate"
        | "systemStatus"
        | "killSwitchActive"
        | "pauseReason"
        | "degradedReason"
        | "degradedAt"
      >
    >,
    command: ExecutionStateTransitionRecord["command"],
    reason: string | null,
  ): Promise<ExecutionStateRecord> {
    const nextState: ExecutionStateRecord = {
      ...current,
      ...changes,
      updatedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      UPDATE execution_state
      SET execution_mode = ?, live_execution_gate = ?, system_status = ?,
          kill_switch_active = ?, pause_reason = ?, degraded_reason = ?, degraded_at = ?, updated_at = ?
      WHERE exchange_account_id = ?
    `).run(
      nextState.executionMode,
      nextState.liveExecutionGate,
      nextState.systemStatus,
      toSqliteBoolean(nextState.killSwitchActive),
      nextState.pauseReason,
      nextState.degradedReason,
      nextState.degradedAt,
      nextState.updatedAt,
      this.exchangeAccountId,
    );

    recordExecutionStateTransition(this.db, {
      id: createId("execution_state_transition"),
      exchangeAccountId: this.exchangeAccountId,
      command,
      fromExecutionMode: current.executionMode,
      toExecutionMode: nextState.executionMode,
      fromLiveExecutionGate: current.liveExecutionGate,
      toLiveExecutionGate: nextState.liveExecutionGate,
      fromSystemStatus: current.systemStatus,
      toSystemStatus: nextState.systemStatus,
      fromKillSwitchActive: current.killSwitchActive,
      toKillSwitchActive: nextState.killSwitchActive,
      reason,
      createdAt: nextState.updatedAt,
    });

    return nextState;
  }
}

function resolveResumedSystemStatus(current: ExecutionStateRecord): ExecutionStateRecord["systemStatus"] {
  if (current.killSwitchActive) {
    return "KILL_SWITCHED";
  }

  if (current.degradedReason || current.degradedAt) {
    return "DEGRADED";
  }

  return "RUNNING";
}

function resolveSystemStatusForDegradation(
  current: ExecutionStateRecord,
): ExecutionStateRecord["systemStatus"] {
  if (current.killSwitchActive || current.systemStatus === "KILL_SWITCHED") {
    return "KILL_SWITCHED";
  }

  if (current.systemStatus === "PAUSED") {
    return "PAUSED";
  }

  return "DEGRADED";
}

function ensureBootstrapRecords(
  db: import("node:sqlite").DatabaseSync,
  input: {
    user: UserRecord;
    exchangeAccount: ExchangeAccountRecord;
    executionState: ExecutionStateRecord;
  },
): boolean {
  db.prepare(`
    INSERT OR IGNORE INTO users (
      id, telegram_user_id, telegram_chat_id, display_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.user.id,
    input.user.telegramUserId,
    input.user.telegramChatId,
    input.user.displayName,
    input.user.createdAt,
    input.user.updatedAt,
  );

  db.prepare(`
    INSERT OR IGNORE INTO exchange_accounts (
      id, user_id, exchange, venue_type, account_label,
      access_key_ref, secret_key_ref, quote_currency, is_primary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.exchangeAccount.id,
    input.exchangeAccount.userId,
    input.exchangeAccount.exchange,
    input.exchangeAccount.venueType,
    input.exchangeAccount.accountLabel,
    input.exchangeAccount.accessKeyRef,
    input.exchangeAccount.secretKeyRef,
    input.exchangeAccount.quoteCurrency,
    toSqliteBoolean(input.exchangeAccount.isPrimary),
    input.exchangeAccount.createdAt,
    input.exchangeAccount.updatedAt,
  );

  const result = db.prepare(`
    INSERT OR IGNORE INTO execution_state (
      id, exchange_account_id, execution_mode, live_execution_gate,
      system_status, kill_switch_active, pause_reason, degraded_reason, degraded_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.executionState.id,
    input.executionState.exchangeAccountId,
    input.executionState.executionMode,
    input.executionState.liveExecutionGate,
    input.executionState.systemStatus,
    toSqliteBoolean(input.executionState.killSwitchActive),
    input.executionState.pauseReason,
    input.executionState.degradedReason,
    input.executionState.degradedAt,
    input.executionState.updatedAt,
  );

  return result.changes > 0;
}

function mapExecutionStateRow(row: SqliteExecutionStateRow): ExecutionStateRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    executionMode: row.execution_mode,
    liveExecutionGate: row.live_execution_gate,
    systemStatus: row.system_status,
    killSwitchActive: fromSqliteBoolean(row.kill_switch_active),
    pauseReason: row.pause_reason,
    degradedReason: row.degraded_reason,
    degradedAt: row.degraded_at,
    updatedAt: row.updated_at,
  };
}

function mapExecutionStateTransitionRow(
  row: SqliteExecutionStateTransitionRow,
): ExecutionStateTransitionRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    command: row.command,
    fromExecutionMode: row.from_execution_mode,
    toExecutionMode: row.to_execution_mode,
    fromLiveExecutionGate: row.from_live_execution_gate,
    toLiveExecutionGate: row.to_live_execution_gate,
    fromSystemStatus: row.from_system_status,
    toSystemStatus: row.to_system_status,
    fromKillSwitchActive:
      row.from_kill_switch_active === null ? null : fromSqliteBoolean(row.from_kill_switch_active),
    toKillSwitchActive: fromSqliteBoolean(row.to_kill_switch_active),
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function mapBalanceSnapshotRow(row: SqliteBalanceSnapshotRow): BalanceSnapshotRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    capturedAt: row.captured_at,
    source: row.source,
    totalKrwValue: row.total_krw_value,
    balancesJson: row.balances_json,
  };
}

function mapPositionSnapshotRow(row: SqlitePositionSnapshotRow): PositionSnapshotRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    capturedAt: row.captured_at,
    source: row.source,
    positionsJson: row.positions_json,
  };
}

function mapOrderRow(row: SqliteOrderRow): OrderRecord {
  return {
    id: row.id,
    strategyDecisionId: row.strategy_decision_id,
    exchangeAccountId: row.exchange_account_id,
    market: row.market,
    side: row.side,
    ordType: row.ord_type,
    volume: row.volume,
    price: row.price,
    timeInForce: row.time_in_force,
    smpType: row.smp_type,
    identifier: row.identifier,
    idempotencyKey: row.idempotency_key,
    origin: row.origin,
    requestedAt: row.requested_at,
    upbitUuid: row.upbit_uuid,
    status: row.status,
    executionMode: row.execution_mode,
    exchangeResponseJson: row.exchange_response_json,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFillRow(row: SqliteFillRow): FillRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    exchangeFillId: row.exchange_fill_id,
    market: row.market,
    side: row.side,
    price: row.price,
    volume: row.volume,
    feeCurrency: row.fee_currency,
    feeAmount: row.fee_amount,
    filledAt: row.filled_at,
    rawPayloadJson: row.raw_payload_json,
  };
}

function mapRiskEventRow(row: SqliteRiskEventRow): RiskEventRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    strategyDecisionId: row.strategy_decision_id,
    orderId: row.order_id,
    level: row.level,
    ruleCode: row.rule_code,
    message: row.message,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

function mapReconciliationRunRow(row: SqliteReconciliationRunRow): ReconciliationRunRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    summaryJson: row.summary_json,
    errorMessage: row.error_message,
  };
}

function mapHistoryRecoveryCheckpointRow(
  row: SqliteHistoryRecoveryCheckpointRow,
): HistoryRecoveryCheckpointRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    market: row.market,
    checkpointType: row.checkpoint_type,
    nextWindowEndAt: row.next_window_end_at,
    updatedAt: row.updated_at,
  };
}

function mapOperatorNotificationRow(row: SqliteOperatorNotificationRow): OperatorNotificationRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    channel: row.channel,
    notificationType: row.notification_type,
    severity: row.severity,
    title: row.title,
    message: row.message,
    payloadJson: row.payload_json,
    deliveryStatus: row.delivery_status,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    failureClass: row.failure_class,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    lastError: row.last_error,
  };
}

function mapOperatorNotificationDeliveryAttemptRow(
  row: SqliteOperatorNotificationDeliveryAttemptRow,
): OperatorNotificationDeliveryAttemptRecord {
  return {
    id: row.id,
    notificationId: row.notification_id,
    exchangeAccountId: row.exchange_account_id,
    attemptCount: row.attempt_count,
    leaseToken: row.lease_token,
    outcome: row.outcome,
    failureClass: row.failure_class,
    attemptedAt: row.attempted_at,
    nextAttemptAt: row.next_attempt_at,
    deliveredAt: row.delivered_at,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

function recordExecutionStateTransition(
  db: import("node:sqlite").DatabaseSync,
  record: ExecutionStateTransitionRecord,
): void {
  db.prepare(`
    INSERT INTO execution_state_transitions (
      id, exchange_account_id, command,
      from_execution_mode, to_execution_mode,
      from_live_execution_gate, to_live_execution_gate,
      from_system_status, to_system_status,
      from_kill_switch_active, to_kill_switch_active,
      reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.exchangeAccountId,
    record.command,
    record.fromExecutionMode,
    record.toExecutionMode,
    record.fromLiveExecutionGate,
    record.toLiveExecutionGate,
    record.fromSystemStatus,
    record.toSystemStatus,
    record.fromKillSwitchActive === null ? null : toSqliteBoolean(record.fromKillSwitchActive),
    toSqliteBoolean(record.toKillSwitchActive),
    record.reason,
    record.createdAt,
  );
}

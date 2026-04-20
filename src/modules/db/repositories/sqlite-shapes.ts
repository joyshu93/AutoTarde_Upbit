import type { JsonValue } from '../types.js';

export type SQLiteBindValue = string | number | null;
export type SQLiteBindings = Record<string, SQLiteBindValue>;

export interface SQLiteRunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface SQLiteSession {
  run(sql: string, bindings?: SQLiteBindings): Promise<SQLiteRunResult>;
  get<T>(sql: string, bindings?: SQLiteBindings): Promise<T | null>;
  all<T>(sql: string, bindings?: SQLiteBindings): Promise<T[]>;
  transaction<T>(work: (session: SQLiteSession) => Promise<T>): Promise<T>;
}

export interface SQLiteStatement {
  name: string;
  sql: string;
}

function statement(name: string, sql: string): SQLiteStatement {
  return { name, sql };
}

export function toSqliteBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function fromSqliteBoolean(value: number): boolean {
  return value !== 0;
}

export function serializeJson(value: JsonValue | null | undefined): string | null {
  return value == null ? null : JSON.stringify(value);
}

export function deserializeJson<T extends JsonValue>(value: string | null): T | null {
  return value == null ? null : (JSON.parse(value) as T);
}

export const sqliteDraftStatements = {
  users: {
    upsert: statement(
      'users.upsert',
      `
      INSERT INTO users (
        id, external_ref, display_name, status, timezone, created_at_ms, updated_at_ms
      ) VALUES (
        :id, :externalRef, :displayName, :status, :timezone, :createdAtMs, :updatedAtMs
      )
      ON CONFLICT(id) DO UPDATE SET
        external_ref = excluded.external_ref,
        display_name = excluded.display_name,
        status = excluded.status,
        timezone = excluded.timezone,
        updated_at_ms = excluded.updated_at_ms;
      `,
    ),
    byId: statement(
      'users.byId',
      `
      SELECT * FROM users WHERE id = :userId LIMIT 1;
      `,
    ),
  },
  exchangeAccounts: {
    upsert: statement(
      'exchangeAccounts.upsert',
      `
      INSERT INTO exchange_accounts (
        id, user_id, venue, account_label, base_currency, access_key_ref, secret_key_ref, passphrase_ref,
        execution_mode, account_status, can_trade, can_withdraw,
        last_connected_at_ms, last_reconciled_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        :id, :userId, :venue, :accountLabel, :baseCurrency, :accessKeyRef, :secretKeyRef, :passphraseRef,
        :executionMode, :accountStatus, :canTrade, :canWithdraw,
        :lastConnectedAtMs, :lastReconciledAtMs, :createdAtMs, :updatedAtMs
      )
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        venue = excluded.venue,
        account_label = excluded.account_label,
        base_currency = excluded.base_currency,
        access_key_ref = excluded.access_key_ref,
        secret_key_ref = excluded.secret_key_ref,
        passphrase_ref = excluded.passphrase_ref,
        execution_mode = excluded.execution_mode,
        account_status = excluded.account_status,
        can_trade = excluded.can_trade,
        can_withdraw = excluded.can_withdraw,
        last_connected_at_ms = excluded.last_connected_at_ms,
        last_reconciled_at_ms = excluded.last_reconciled_at_ms,
        updated_at_ms = excluded.updated_at_ms;
      `,
    ),
    byId: statement(
      'exchangeAccounts.byId',
      `
      SELECT * FROM exchange_accounts WHERE id = :exchangeAccountId LIMIT 1;
      `,
    ),
    tradeEnabled: statement(
      'exchangeAccounts.tradeEnabled',
      `
      SELECT *
      FROM exchange_accounts
      WHERE can_trade = 1
        AND account_status IN ('active', 'paper')
      ORDER BY updated_at_ms DESC;
      `,
    ),
  },
  idempotency: {
    byKey: statement(
      'idempotency.byKey',
      `
      SELECT *
      FROM idempotency_keys
      WHERE scope = :scope
        AND idempotency_key = :idempotencyKey
      LIMIT 1;
      `,
    ),
    insertClaim: statement(
      'idempotency.insertClaim',
      `
      INSERT INTO idempotency_keys (
        scope, idempotency_key, request_hash, status,
        first_seen_at_ms, last_touched_at_ms, expires_at_ms
      ) VALUES (
        :scope, :idempotencyKey, :requestHash, 'in_progress',
        :firstSeenAtMs, :firstSeenAtMs, :expiresAtMs
      );
      `,
    ),
    markCompleted: statement(
      'idempotency.markCompleted',
      `
      UPDATE idempotency_keys
      SET status = 'completed',
          resource_type = :resourceType,
          resource_id = :resourceId,
          response_payload_json = :responsePayloadJson,
          last_touched_at_ms = :completedAtMs
      WHERE scope = :scope
        AND idempotency_key = :idempotencyKey;
      `,
    ),
    markFailed: statement(
      'idempotency.markFailed',
      `
      UPDATE idempotency_keys
      SET status = 'failed',
          response_payload_json = :responsePayloadJson,
          last_touched_at_ms = :failedAtMs
      WHERE scope = :scope
        AND idempotency_key = :idempotencyKey;
      `,
    ),
  },
  executionState: {
    byKey: statement(
      'executionState.byKey',
      `
      SELECT *
      FROM execution_state
      WHERE scope_type = :scopeType
        AND scope_id = :scopeId
        AND state_key = :stateKey
      LIMIT 1;
      `,
    ),
    insertInitial: statement(
      'executionState.insertInitial',
      `
      INSERT INTO execution_state (
        scope_type, scope_id, state_key, version, state_json,
        lease_owner, lease_expires_at_ms, last_heartbeat_at_ms,
        created_at_ms, updated_at_ms
      ) VALUES (
        :scopeType, :scopeId, :stateKey, 0, :stateJson,
        :leaseOwner, :leaseExpiresAtMs, :lastHeartbeatAtMs,
        :nowMs, :nowMs
      );
      `,
    ),
    compareAndSet: statement(
      'executionState.compareAndSet',
      `
      UPDATE execution_state
      SET version = version + 1,
          state_json = :stateJson,
          lease_owner = :leaseOwner,
          lease_expires_at_ms = :leaseExpiresAtMs,
          last_heartbeat_at_ms = :lastHeartbeatAtMs,
          updated_at_ms = :nowMs
      WHERE scope_type = :scopeType
        AND scope_id = :scopeId
        AND state_key = :stateKey
        AND version = :expectedVersion;
      `,
    ),
    acquireLease: statement(
      'executionState.acquireLease',
      `
      UPDATE execution_state
      SET lease_owner = :leaseOwner,
          lease_expires_at_ms = :leaseExpiresAtMs,
          last_heartbeat_at_ms = :nowMs,
          updated_at_ms = :nowMs
      WHERE scope_type = :scopeType
        AND scope_id = :scopeId
        AND state_key = :stateKey
        AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= :nowMs OR lease_owner = :leaseOwner);
      `,
    ),
    releaseLease: statement(
      'executionState.releaseLease',
      `
      UPDATE execution_state
      SET lease_owner = NULL,
          lease_expires_at_ms = NULL,
          last_heartbeat_at_ms = :nowMs,
          updated_at_ms = :nowMs
      WHERE scope_type = :scopeType
        AND scope_id = :scopeId
        AND state_key = :stateKey
        AND lease_owner = :leaseOwner;
      `,
    ),
  },
  strategyDecisions: {
    insert: statement(
      'strategyDecisions.insert',
      `
      INSERT INTO strategy_decisions (
        id, exchange_account_id, strategy_name, strategy_version, market_symbol,
        timeframe, decision_type, side, position_effect, decision_status,
        decision_key, requested_quantity, requested_notional, limit_price, stop_price,
        risk_budget, rationale_json, market_snapshot_json, expires_at_ms,
        decided_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        :id, :exchangeAccountId, :strategyName, :strategyVersion, :marketSymbol,
        :timeframe, :decisionType, :side, :positionEffect, :decisionStatus,
        :decisionKey, :requestedQuantity, :requestedNotional, :limitPrice, :stopPrice,
        :riskBudget, :rationaleJson, :marketSnapshotJson, :expiresAtMs,
        :decidedAtMs, :createdAtMs, :updatedAtMs
      );
      `,
    ),
    save: statement(
      'strategyDecisions.save',
      `
      INSERT INTO strategy_decisions (
        id, exchange_account_id, strategy_name, strategy_version, market_symbol,
        timeframe, decision_type, side, position_effect, decision_status,
        decision_key, requested_quantity, requested_notional, limit_price, stop_price,
        risk_budget, rationale_json, market_snapshot_json, expires_at_ms,
        decided_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        :id, :exchangeAccountId, :strategyName, :strategyVersion, :marketSymbol,
        :timeframe, :decisionType, :side, :positionEffect, :decisionStatus,
        :decisionKey, :requestedQuantity, :requestedNotional, :limitPrice, :stopPrice,
        :riskBudget, :rationaleJson, :marketSnapshotJson, :expiresAtMs,
        :decidedAtMs, :createdAtMs, :updatedAtMs
      )
      ON CONFLICT(id) DO UPDATE SET
        decision_status = excluded.decision_status,
        requested_quantity = excluded.requested_quantity,
        requested_notional = excluded.requested_notional,
        limit_price = excluded.limit_price,
        stop_price = excluded.stop_price,
        risk_budget = excluded.risk_budget,
        rationale_json = excluded.rationale_json,
        market_snapshot_json = excluded.market_snapshot_json,
        expires_at_ms = excluded.expires_at_ms,
        updated_at_ms = excluded.updated_at_ms;
      `,
    ),
    byId: statement(
      'strategyDecisions.byId',
      `
      SELECT * FROM strategy_decisions WHERE id = :decisionId LIMIT 1;
      `,
    ),
    pendingByAccount: statement(
      'strategyDecisions.pendingByAccount',
      `
      SELECT *
      FROM strategy_decisions
      WHERE exchange_account_id = :exchangeAccountId
        AND decision_status IN ('pending', 'approved')
      ORDER BY decided_at_ms ASC
      LIMIT :limit;
      `,
    ),
  },
  snapshots: {
    insertBalance: statement(
      'snapshots.insertBalance',
      `
      INSERT INTO balance_snapshots (
        id, exchange_account_id, capture_id, source, asset_symbol,
        available_amount, locked_amount, total_amount, value_in_base_currency,
        captured_at_ms, created_at_ms
      ) VALUES (
        :id, :exchangeAccountId, :captureId, :source, :assetSymbol,
        :availableAmount, :lockedAmount, :totalAmount, :valueInBaseCurrency,
        :capturedAtMs, :createdAtMs
      );
      `,
    ),
    latestBalanceCapture: statement(
      'snapshots.latestBalanceCapture',
      `
      SELECT capture_id
      FROM balance_snapshots
      WHERE exchange_account_id = :exchangeAccountId
      ORDER BY captured_at_ms DESC, created_at_ms DESC
      LIMIT 1;
      `,
    ),
    balancesByCapture: statement(
      'snapshots.balancesByCapture',
      `
      SELECT *
      FROM balance_snapshots
      WHERE exchange_account_id = :exchangeAccountId
        AND capture_id = :captureId
      ORDER BY asset_symbol ASC;
      `,
    ),
    insertPosition: statement(
      'snapshots.insertPosition',
      `
      INSERT INTO position_snapshots (
        id, exchange_account_id, capture_id, source, market_symbol, side,
        quantity, average_entry_price, mark_price, unrealized_pnl,
        realized_pnl, position_state, captured_at_ms, created_at_ms
      ) VALUES (
        :id, :exchangeAccountId, :captureId, :source, :marketSymbol, :side,
        :quantity, :averageEntryPrice, :markPrice, :unrealizedPnl,
        :realizedPnl, :positionState, :capturedAtMs, :createdAtMs
      );
      `,
    ),
    latestPositionCapture: statement(
      'snapshots.latestPositionCapture',
      `
      SELECT capture_id
      FROM position_snapshots
      WHERE exchange_account_id = :exchangeAccountId
      ORDER BY captured_at_ms DESC, created_at_ms DESC
      LIMIT 1;
      `,
    ),
    positionsByCapture: statement(
      'snapshots.positionsByCapture',
      `
      SELECT *
      FROM position_snapshots
      WHERE exchange_account_id = :exchangeAccountId
        AND capture_id = :captureId
      ORDER BY market_symbol ASC, side ASC;
      `,
    ),
  },
  orders: {
    insert: statement(
      'orders.insert',
      `
      INSERT INTO orders (
        id, exchange_account_id, strategy_decision_id, operator_action_id,
        client_order_id, venue_order_id, idempotency_key, market_symbol,
        order_type, side, time_in_force, post_only, reduce_only,
        requested_quantity, requested_notional, limit_price, stop_price,
        executed_quantity, cumulative_quote_amount, average_fill_price,
        state, state_reason_code, source, submitted_at_ms, last_event_at_ms,
        terminal_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        :id, :exchangeAccountId, :strategyDecisionId, :operatorActionId,
        :clientOrderId, :venueOrderId, :idempotencyKey, :marketSymbol,
        :orderType, :side, :timeInForce, :postOnly, :reduceOnly,
        :requestedQuantity, :requestedNotional, :limitPrice, :stopPrice,
        :executedQuantity, :cumulativeQuoteAmount, :averageFillPrice,
        :state, :stateReasonCode, :source, :submittedAtMs, :lastEventAtMs,
        :terminalAtMs, :createdAtMs, :updatedAtMs
      );
      `,
    ),
    save: statement(
      'orders.save',
      `
      INSERT INTO orders (
        id, exchange_account_id, strategy_decision_id, operator_action_id,
        client_order_id, venue_order_id, idempotency_key, market_symbol,
        order_type, side, time_in_force, post_only, reduce_only,
        requested_quantity, requested_notional, limit_price, stop_price,
        executed_quantity, cumulative_quote_amount, average_fill_price,
        state, state_reason_code, source, submitted_at_ms, last_event_at_ms,
        terminal_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        :id, :exchangeAccountId, :strategyDecisionId, :operatorActionId,
        :clientOrderId, :venueOrderId, :idempotencyKey, :marketSymbol,
        :orderType, :side, :timeInForce, :postOnly, :reduceOnly,
        :requestedQuantity, :requestedNotional, :limitPrice, :stopPrice,
        :executedQuantity, :cumulativeQuoteAmount, :averageFillPrice,
        :state, :stateReasonCode, :source, :submittedAtMs, :lastEventAtMs,
        :terminalAtMs, :createdAtMs, :updatedAtMs
      )
      ON CONFLICT(id) DO UPDATE SET
        strategy_decision_id = excluded.strategy_decision_id,
        operator_action_id = excluded.operator_action_id,
        venue_order_id = excluded.venue_order_id,
        requested_quantity = excluded.requested_quantity,
        requested_notional = excluded.requested_notional,
        limit_price = excluded.limit_price,
        stop_price = excluded.stop_price,
        executed_quantity = excluded.executed_quantity,
        cumulative_quote_amount = excluded.cumulative_quote_amount,
        average_fill_price = excluded.average_fill_price,
        state = excluded.state,
        state_reason_code = excluded.state_reason_code,
        submitted_at_ms = excluded.submitted_at_ms,
        last_event_at_ms = excluded.last_event_at_ms,
        terminal_at_ms = excluded.terminal_at_ms,
        updated_at_ms = excluded.updated_at_ms;
      `,
    ),
    byId: statement(
      'orders.byId',
      `
      SELECT * FROM orders WHERE id = :orderId LIMIT 1;
      `,
    ),
    byClientOrderId: statement(
      'orders.byClientOrderId',
      `
      SELECT *
      FROM orders
      WHERE exchange_account_id = :exchangeAccountId
        AND client_order_id = :clientOrderId
      LIMIT 1;
      `,
    ),
    activeByAccount: statement(
      'orders.activeByAccount',
      `
      SELECT *
      FROM orders
      WHERE exchange_account_id = :exchangeAccountId
        AND state IN ('created', 'submission_pending', 'submitted', 'partially_filled', 'cancel_pending')
      ORDER BY updated_at_ms DESC;
      `,
    ),
    insertEvent: statement(
      'orders.insertEvent',
      `
      INSERT INTO order_events (
        id, order_id, exchange_account_id, source, event_type,
        source_event_id, idempotency_key, previous_state, new_state,
        event_payload_json, occurred_at_ms, created_at_ms
      ) VALUES (
        :id, :orderId, :exchangeAccountId, :source, :eventType,
        :sourceEventId, :idempotencyKey, :previousState, :newState,
        :eventPayloadJson, :occurredAtMs, :createdAtMs
      );
      `,
    ),
    eventsByOrder: statement(
      'orders.eventsByOrder',
      `
      SELECT *
      FROM order_events
      WHERE order_id = :orderId
      ORDER BY occurred_at_ms ASC, created_at_ms ASC;
      `,
    ),
    insertFill: statement(
      'orders.insertFill',
      `
      INSERT INTO fills (
        id, order_id, order_event_id, exchange_account_id, venue_fill_id, venue_trade_id,
        side, market_symbol, fill_price, fill_quantity, quote_quantity,
        fee_amount, fee_asset_symbol, liquidity_role, occurred_at_ms, created_at_ms
      ) VALUES (
        :id, :orderId, :orderEventId, :exchangeAccountId, :venueFillId, :venueTradeId,
        :side, :marketSymbol, :fillPrice, :fillQuantity, :quoteQuantity,
        :feeAmount, :feeAssetSymbol, :liquidityRole, :occurredAtMs, :createdAtMs
      );
      `,
    ),
    fillsByOrder: statement(
      'orders.fillsByOrder',
      `
      SELECT *
      FROM fills
      WHERE order_id = :orderId
      ORDER BY occurred_at_ms ASC, created_at_ms ASC;
      `,
    ),
  },
  reconciliationRuns: {
    upsert: statement(
      'reconciliationRuns.upsert',
      `
      INSERT INTO reconciliation_runs (
        id, exchange_account_id, run_type, trigger_source, status,
        started_at_ms, finished_at_ms, watermark_start_ms, watermark_end_ms,
        drift_detected, actions_taken_json, summary_json,
        error_code, error_message, created_at_ms, updated_at_ms
      ) VALUES (
        :id, :exchangeAccountId, :runType, :triggerSource, :status,
        :startedAtMs, :finishedAtMs, :watermarkStartMs, :watermarkEndMs,
        :driftDetected, :actionsTakenJson, :summaryJson,
        :errorCode, :errorMessage, :createdAtMs, :updatedAtMs
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        finished_at_ms = excluded.finished_at_ms,
        watermark_start_ms = excluded.watermark_start_ms,
        watermark_end_ms = excluded.watermark_end_ms,
        drift_detected = excluded.drift_detected,
        actions_taken_json = excluded.actions_taken_json,
        summary_json = excluded.summary_json,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        updated_at_ms = excluded.updated_at_ms;
      `,
    ),
    byId: statement(
      'reconciliationRuns.byId',
      `
      SELECT * FROM reconciliation_runs WHERE id = :runId LIMIT 1;
      `,
    ),
    recentByAccount: statement(
      'reconciliationRuns.recentByAccount',
      `
      SELECT *
      FROM reconciliation_runs
      WHERE exchange_account_id = :exchangeAccountId
      ORDER BY started_at_ms DESC
      LIMIT :limit;
      `,
    ),
  },
  riskEvents: {
    upsert: statement(
      'riskEvents.upsert',
      `
      INSERT INTO risk_events (
        id, exchange_account_id, order_id, strategy_decision_id, reconciliation_run_id,
        severity, event_type, dedupe_key, status, message, event_payload_json,
        detected_at_ms, acknowledged_at_ms, resolved_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        :id, :exchangeAccountId, :orderId, :strategyDecisionId, :reconciliationRunId,
        :severity, :eventType, :dedupeKey, :status, :message, :eventPayloadJson,
        :detectedAtMs, :acknowledgedAtMs, :resolvedAtMs, :createdAtMs, :updatedAtMs
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        message = excluded.message,
        event_payload_json = excluded.event_payload_json,
        acknowledged_at_ms = excluded.acknowledged_at_ms,
        resolved_at_ms = excluded.resolved_at_ms,
        updated_at_ms = excluded.updated_at_ms;
      `,
    ),
    byId: statement(
      'riskEvents.byId',
      `
      SELECT * FROM risk_events WHERE id = :riskEventId LIMIT 1;
      `,
    ),
    activeByAccount: statement(
      'riskEvents.activeByAccount',
      `
      SELECT *
      FROM risk_events
      WHERE exchange_account_id = :exchangeAccountId
        AND status IN ('open', 'acknowledged', 'suppressed')
      ORDER BY detected_at_ms DESC;
      `,
    ),
  },
  operatorActions: {
    upsert: statement(
      'operatorActions.upsert',
      `
      INSERT INTO operator_actions (
        id, exchange_account_id, target_type, target_id, action_type,
        requested_by_user_id, request_idempotency_key, status, reason,
        command_payload_json, result_payload_json, requested_at_ms,
        applied_at_ms, created_at_ms, updated_at_ms
      ) VALUES (
        :id, :exchangeAccountId, :targetType, :targetId, :actionType,
        :requestedByUserId, :requestIdempotencyKey, :status, :reason,
        :commandPayloadJson, :resultPayloadJson, :requestedAtMs,
        :appliedAtMs, :createdAtMs, :updatedAtMs
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        reason = excluded.reason,
        command_payload_json = excluded.command_payload_json,
        result_payload_json = excluded.result_payload_json,
        applied_at_ms = excluded.applied_at_ms,
        updated_at_ms = excluded.updated_at_ms;
      `,
    ),
    byId: statement(
      'operatorActions.byId',
      `
      SELECT * FROM operator_actions WHERE id = :actionId LIMIT 1;
      `,
    ),
    pendingByAccount: statement(
      'operatorActions.pendingByAccount',
      `
      SELECT *
      FROM operator_actions
      WHERE status IN ('requested', 'approved')
        AND (
          exchange_account_id IS NULL
          OR exchange_account_id = :exchangeAccountId
        )
      ORDER BY requested_at_ms ASC;
      `,
    ),
  },
} as const;

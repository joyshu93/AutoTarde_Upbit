CREATE INDEX IF NOT EXISTS idx_operator_notifications_delivery_status
  ON operator_notifications(exchange_account_id, delivery_status, created_at DESC);

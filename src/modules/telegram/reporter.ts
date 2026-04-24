import type {
  OperatorNotificationRecord,
  OperatorNotificationSeverity,
  OperatorNotificationType,
} from "../../domain/types.js";
import { createId } from "../../shared/ids.js";
import type { ExecutionRepository } from "../db/interfaces.js";
import type { OperatorNotificationDeliveryService } from "./delivery.js";

export interface OperatorNotificationReporter {
  report(input: {
    exchangeAccountId: string;
    notificationType: OperatorNotificationType;
    severity: OperatorNotificationSeverity;
    title: string;
    message: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
}

export class DurableTelegramReporter implements OperatorNotificationReporter {
  constructor(
    private readonly dependencies: {
      repositories: Pick<ExecutionRepository, "saveOperatorNotification">;
      deliveryService?: Pick<OperatorNotificationDeliveryService, "kick">;
      now?: () => string;
    },
  ) {}

  async report(input: {
    exchangeAccountId: string;
    notificationType: OperatorNotificationType;
    severity: OperatorNotificationSeverity;
    title: string;
    message: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    const createdAt = this.dependencies.now?.() ?? new Date().toISOString();
    const record: OperatorNotificationRecord = {
      id: createId("operator_notification"),
      exchangeAccountId: input.exchangeAccountId,
      channel: "TELEGRAM",
      notificationType: input.notificationType,
      severity: input.severity,
      title: input.title,
      message: input.message,
      payloadJson: JSON.stringify(input.payload ?? {}),
      deliveryStatus: "PENDING",
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      failureClass: null,
      leaseToken: null,
      leaseExpiresAt: null,
      createdAt,
      deliveredAt: null,
      lastError: null,
    };

    await this.dependencies.repositories.saveOperatorNotification(record);
    this.dependencies.deliveryService?.kick(input.exchangeAccountId);
  }
}

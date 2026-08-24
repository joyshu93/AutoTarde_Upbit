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
    notificationId?: string;
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
      repositories: Pick<ExecutionRepository, "saveOperatorNotification"> &
        Partial<Pick<ExecutionRepository, "listOperatorNotifications">>;
      deliveryService?: Pick<OperatorNotificationDeliveryService, "kick">;
      now?: () => string;
    },
  ) {}

  async report(input: {
    notificationId?: string;
    exchangeAccountId: string;
    notificationType: OperatorNotificationType;
    severity: OperatorNotificationSeverity;
    title: string;
    message: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    const createdAt = this.dependencies.now?.() ?? new Date().toISOString();
    const record: OperatorNotificationRecord = {
      id: input.notificationId ?? createId("operator_notification"),
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

    const listNotifications = this.dependencies.repositories.listOperatorNotifications;
    if (input.notificationId) {
      if (!listNotifications) {
        throw new Error("Deterministic operator notifications require persisted notification readback.");
      }
      const existing = (await listNotifications.call(
        this.dependencies.repositories,
        input.exchangeAccountId,
      ))
        .find((candidate) => candidate.id === input.notificationId);
      if (existing) {
        assertSameNotificationMaterial(existing, record);
        return;
      }
    }

    try {
      await this.dependencies.repositories.saveOperatorNotification(record);
    } catch (error) {
      if (!input.notificationId || !listNotifications) throw error;
      const existing = (await listNotifications.call(
        this.dependencies.repositories,
        input.exchangeAccountId,
      )).find((candidate) => candidate.id === input.notificationId);
      if (!existing) throw error;
      assertSameNotificationMaterial(existing, record);
      return;
    }
    this.dependencies.deliveryService?.kick(input.exchangeAccountId);
  }
}

function assertSameNotificationMaterial(
  existing: OperatorNotificationRecord,
  expected: OperatorNotificationRecord,
): void {
  if (
    existing.exchangeAccountId !== expected.exchangeAccountId ||
    existing.channel !== expected.channel ||
    existing.notificationType !== expected.notificationType ||
    existing.severity !== expected.severity ||
    existing.title !== expected.title ||
    existing.message !== expected.message ||
    existing.payloadJson !== expected.payloadJson ||
    existing.createdAt !== expected.createdAt
  ) {
    throw new Error(`Conflicting deterministic operator notification ${expected.id}.`);
  }
}

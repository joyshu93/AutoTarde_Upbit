export const KNOWN_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof KNOWN_LOG_LEVELS)[number];

type LogMetadata = Record<string, unknown>;

const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export interface Logger {
  child(scope: string): Logger;
  debug(message: string, metadata?: LogMetadata): void;
  info(message: string, metadata?: LogMetadata): void;
  warn(message: string, metadata?: LogMetadata): void;
  error(message: string, metadata?: LogMetadata): void;
}

export function createLogger(options?: {
  readonly level?: LogLevel;
  readonly scope?: string;
}): Logger {
  const level = options?.level ?? "info";
  const scope = options?.scope;

  const write = (entryLevel: LogLevel, message: string, metadata?: LogMetadata): void => {
    if (LOG_LEVEL_PRIORITY[entryLevel] < LOG_LEVEL_PRIORITY[level]) {
      return;
    }

    const payload: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level: entryLevel,
      message
    };

    if (scope) {
      payload.scope = scope;
    }

    if (metadata && Object.keys(metadata).length > 0) {
      payload.metadata = metadata;
    }

    const line = JSON.stringify(payload);

    if (entryLevel === "error") {
      console.error(line);
      return;
    }

    if (entryLevel === "warn") {
      console.warn(line);
      return;
    }

    console.log(line);
  };

  return {
    child(childScope: string): Logger {
      return createLogger({
        level,
        scope: scope ? `${scope}.${childScope}` : childScope
      });
    },
    debug(message: string, metadata?: LogMetadata): void {
      write("debug", message, metadata);
    },
    info(message: string, metadata?: LogMetadata): void {
      write("info", message, metadata);
    },
    warn(message: string, metadata?: LogMetadata): void {
      write("warn", message, metadata);
    },
    error(message: string, metadata?: LogMetadata): void {
      write("error", message, metadata);
    }
  };
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    value: error
  };
}

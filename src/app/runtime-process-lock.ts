import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

const RUNTIME_LOCK_DOMAIN = "AUTOTRADE_UPBIT_RUNTIME_LOCK_V1";
const PIPE_PREFIX = "\\\\.\\pipe\\autotrade-upbit-runtime-";

export interface RuntimeLockIdentityInput {
  readonly canonicalDatabasePath: string;
  readonly databaseInstanceId: string | null;
  readonly exchangeAccountId: string;
}

export interface RuntimeLockIdentity {
  readonly scopeDigest: string;
}

export type RuntimeProcessLockLossReason = "LISTENER_CLOSED" | "LISTENER_ERROR";

export interface RuntimeProcessLock {
  readonly identity: RuntimeLockIdentity;
  isHeld(): boolean;
  onLost(listener: (reason: RuntimeProcessLockLossReason) => void): () => void;
  release(): Promise<void>;
}

export class RuntimeProcessLockError extends Error {
  constructor(
    readonly code:
      | "RUNTIME_ALREADY_OWNED"
      | "RUNTIME_LOCK_ACQUIRE_FAILED"
      | "UNSUPPORTED_RUNTIME_LOCK_PLATFORM",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeProcessLockError";
  }
}

interface RuntimeLockListener {
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  off(event: "close", listener: () => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  close(callback: (error?: Error) => void): this;
}

export function deriveRuntimeLockIdentity(input: RuntimeLockIdentityInput): RuntimeLockIdentity {
  const canonicalScope = JSON.stringify({
    domain: RUNTIME_LOCK_DOMAIN,
    canonicalDatabasePath: input.canonicalDatabasePath.toUpperCase(),
    databaseInstanceId: input.databaseInstanceId,
    exchangeAccountId: input.exchangeAccountId,
  });
  return {
    scopeDigest: createHash("sha256").update(canonicalScope).digest("hex"),
  };
}

export async function acquireRuntimeProcessLock(identity: RuntimeLockIdentity): Promise<RuntimeProcessLock> {
  if (process.platform !== "win32") {
    throw new RuntimeProcessLockError(
      "UNSUPPORTED_RUNTIME_LOCK_PLATFORM",
      "Runtime process locks are supported only on Windows.",
    );
  }

  const listener = createServer((socket: Socket) => socket.destroy());
  const pipeName = `${PIPE_PREFIX}${identity.scopeDigest}`;
  await bindListener(listener, pipeName);
  return createRuntimeProcessLockForTesting(identity, listener);
}

// This constructor isolates listener-loss behavior so it remains deterministic on non-Windows hosts.
export function createRuntimeProcessLockForTesting(
  identity: RuntimeLockIdentity,
  listener: RuntimeLockListener,
): RuntimeProcessLock {
  return new ListenerRuntimeProcessLock(identity, listener);
}

class ListenerRuntimeProcessLock implements RuntimeProcessLock {
  readonly identity: RuntimeLockIdentity;

  private held = true;
  private listenerClosed = false;
  private releaseInProgress = false;
  private releasePromise: Promise<void> | null = null;
  private readonly lossListeners = new Set<(reason: RuntimeProcessLockLossReason) => void>();

  private readonly handleClose = (): void => {
    this.listenerClosed = true;
    if (!this.releaseInProgress) this.markLost("LISTENER_CLOSED");
  };

  private readonly handleError = (): void => {
    this.markLost("LISTENER_ERROR");
  };

  constructor(identity: RuntimeLockIdentity, private readonly listener: RuntimeLockListener) {
    this.identity = identity;
    listener.on("close", this.handleClose);
    listener.on("error", this.handleError);
  }

  isHeld(): boolean {
    return this.held;
  }

  onLost(listener: (reason: RuntimeProcessLockLossReason) => void): () => void {
    this.lossListeners.add(listener);
    return () => this.lossListeners.delete(listener);
  }

  release(): Promise<void> {
    if (this.releasePromise !== null) return this.releasePromise;

    if (this.listenerClosed) {
      this.releasePromise = Promise.resolve();
      this.detachListenerHandlers();
      return this.releasePromise;
    }

    this.releaseInProgress = true;
    this.releasePromise = new Promise<void>((resolve, reject) => {
      try {
        this.listener.close((error) => {
          this.releaseInProgress = false;
          if (error !== undefined) {
            reject(error);
            return;
          }
          this.held = false;
          this.detachListenerHandlers();
          resolve();
        });
      } catch (error) {
        this.releaseInProgress = false;
        reject(error);
      }
    });
    return this.releasePromise;
  }

  private markLost(reason: RuntimeProcessLockLossReason): void {
    if (!this.held) return;
    this.held = false;
    for (const listener of this.lossListeners) listener(reason);
  }

  private detachListenerHandlers(): void {
    this.listener.off("close", this.handleClose);
    this.listener.off("error", this.handleError);
  }
}

async function bindListener(listener: Server, pipeName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      listener.off("listening", onListening);
      reject(new RuntimeProcessLockError(
        error.code === "EADDRINUSE" ? "RUNTIME_ALREADY_OWNED" : "RUNTIME_LOCK_ACQUIRE_FAILED",
        error.code === "EADDRINUSE"
          ? "Another runtime already owns this scope."
          : "Runtime process lock acquisition failed.",
      ));
    };
    const onListening = (): void => {
      listener.off("error", onError);
      resolve();
    };
    listener.once("error", onError);
    listener.once("listening", onListening);
    listener.listen(pipeName);
  });
}

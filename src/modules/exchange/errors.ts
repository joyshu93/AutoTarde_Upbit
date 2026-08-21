export type ExchangeOrderSubmissionErrorKind = "DEFINITIVE_REJECTION" | "UNCERTAIN";

export interface ExchangeOrderSubmissionErrorOptions {
  kind: ExchangeOrderSubmissionErrorKind;
  status: number | null;
  exchangeCode: string | null;
  exchangeName: string | null;
  responseReceived: boolean;
}

export class ExchangeOrderSubmissionError extends Error {
  readonly kind: ExchangeOrderSubmissionErrorKind;
  readonly status: number | null;
  readonly exchangeCode: string | null;
  readonly exchangeName: string | null;
  readonly responseReceived: boolean;

  constructor(options: ExchangeOrderSubmissionErrorOptions) {
    super(
      options.kind === "DEFINITIVE_REJECTION"
        ? "Upbit definitively rejected the order submission."
        : "Upbit order submission outcome is uncertain and requires recovery.",
    );
    this.name = "ExchangeOrderSubmissionError";
    this.kind = options.kind;
    this.status = options.status;
    this.exchangeCode = options.exchangeCode;
    this.exchangeName = options.exchangeName;
    this.responseReceived = options.responseReceived;
  }
}

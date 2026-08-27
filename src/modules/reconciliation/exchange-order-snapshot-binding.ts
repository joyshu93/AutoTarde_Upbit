import type {
  OrderRecord,
  OrderSide,
  OrderType,
  SupportedMarket,
  TimeInForce,
  UpbitSelfMatchPrevention,
} from "../../domain/types.js";
import type { ExchangeFillSnapshot, ExchangeOrderSnapshot } from "../exchange/interfaces.js";
import { canonicalizeUpbitOrderDecimal } from "../exchange/upbit/order-decimals.js";

export interface ExchangeOrderLookupIdentity {
  uuid?: string;
  identifier?: string;
}

export class ExchangeOrderSnapshotBindingError extends Error {
  constructor() {
    super("Exchange order snapshot is not exactly bound to the lookup and local order intent.");
    this.name = "ExchangeOrderSnapshotBindingError";
  }
}

export function bindExchangeOrderSnapshot(input: {
  candidate: unknown;
  query: ExchangeOrderLookupIdentity;
  order: OrderRecord;
}): ExchangeOrderSnapshot {
  try {
    return projectAndValidateSnapshot(input);
  } catch (error) {
    if (error instanceof ExchangeOrderSnapshotBindingError) throw error;
    throw new ExchangeOrderSnapshotBindingError();
  }
}

function projectAndValidateSnapshot(input: {
  candidate: unknown;
  query: ExchangeOrderLookupIdentity;
  order: OrderRecord;
}): ExchangeOrderSnapshot {
  const descriptors = plainDataDescriptors(input.candidate, "exchange order snapshot");
  const uuid = nonEmptyString(dataValue(descriptors, "uuid"));
  const identifier = nullableString(dataValue(descriptors, "identifier"));
  const market = supportedMarket(dataValue(descriptors, "market"));
  const side = orderSide(dataValue(descriptors, "side"));
  const ordType = orderType(dataValue(descriptors, "ordType"));
  const state = nonEmptyString(dataValue(descriptors, "state"));
  const price = nullableDecimal(dataValue(descriptors, "price"), "exchange snapshot price");
  const volume = nullableDecimal(dataValue(descriptors, "volume"), "exchange snapshot volume");
  const timeInForce = timeInForceValue(optionalDataValue(descriptors, "timeInForce"));
  const smpType = smpTypeValue(optionalDataValue(descriptors, "smpType"));
  const remainingVolume = nullableDecimal(
    dataValue(descriptors, "remainingVolume"),
    "exchange snapshot remainingVolume",
  );
  const executedVolume = nullableDecimal(
    dataValue(descriptors, "executedVolume"),
    "exchange snapshot executedVolume",
  );
  const paidFee = nullableDecimal(dataValue(descriptors, "paidFee"), "exchange snapshot paidFee");
  const createdAt = nonEmptyString(dataValue(descriptors, "createdAt"));
  const fills = projectFills(dataValue(descriptors, "fills"));
  const raw = cloneJsonValue(dataValue(descriptors, "raw"), new WeakSet<object>());

  if (
    (input.query.uuid !== undefined && uuid !== input.query.uuid) ||
    (input.query.identifier !== undefined && identifier !== input.query.identifier) ||
    identifier !== input.order.identifier ||
    (input.order.upbitUuid !== null && uuid !== input.order.upbitUuid) ||
    market !== input.order.market ||
    side !== input.order.side ||
    ordType !== input.order.ordType ||
    !sameOrderIntentDecimal(price, input.order.price, "order price", side, ordType, "price") ||
    !sameOrderIntentDecimal(volume, input.order.volume, "order volume", side, ordType, "volume") ||
    timeInForce !== input.order.timeInForce ||
    smpType !== input.order.smpType
  ) {
    throw new ExchangeOrderSnapshotBindingError();
  }

  return Object.freeze({
    uuid,
    identifier,
    market,
    side,
    ordType,
    state,
    price,
    volume,
    timeInForce,
    smpType,
    remainingVolume,
    executedVolume,
    paidFee,
    createdAt,
    fills,
    raw,
  });
}

function plainDataDescriptors(value: unknown, label: string): PropertyDescriptorMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${label} cannot contain symbol fields.`);
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label} fields must be enumerable own data properties.`);
    }
  }
  return descriptors;
}

function dataValue(descriptors: PropertyDescriptorMap, key: string): unknown {
  const descriptor = descriptors[key];
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
    throw new Error(`Exchange snapshot ${key} must be an enumerable own data property.`);
  }
  return descriptor.value;
}

function optionalDataValue(descriptors: PropertyDescriptorMap, key: string): unknown {
  const descriptor = descriptors[key];
  if (!descriptor) return null;
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    throw new Error(`Exchange snapshot ${key} must be an enumerable own data property.`);
  }
  return descriptor.value ?? null;
}

function projectFills(value: unknown): ExchangeFillSnapshot[] {
  if (!Array.isArray(value)) throw new Error("Exchange snapshot fills must be an array.");
  const fills: ExchangeFillSnapshot[] = [];
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error("Exchange snapshot fills must be a dense data-property array.");
    }
    const fillDescriptors = plainDataDescriptors(descriptor.value, "exchange fill snapshot");
    fills.push(Object.freeze({
      tradeUuid: nullableString(dataValue(fillDescriptors, "tradeUuid")),
      side: orderSide(dataValue(fillDescriptors, "side")),
      price: decimal(dataValue(fillDescriptors, "price"), "exchange fill price"),
      volume: decimal(dataValue(fillDescriptors, "volume"), "exchange fill volume"),
      funds: nullableDecimal(dataValue(fillDescriptors, "funds"), "exchange fill funds"),
      fee: nullableDecimal(dataValue(fillDescriptors, "fee"), "exchange fill fee"),
      createdAt: nullableString(dataValue(fillDescriptors, "createdAt")),
      raw: cloneJsonValue(dataValue(fillDescriptors, "raw"), new WeakSet<object>()),
    }));
  }
  return Object.freeze(fills) as unknown as ExchangeFillSnapshot[];
}

function cloneJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Exchange snapshot raw JSON numbers must be finite.");
    return value;
  }
  if (typeof value !== "object") throw new Error("Exchange snapshot raw material must be JSON-compatible.");
  if (seen.has(value)) throw new Error("Exchange snapshot raw material cannot be cyclic.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
      const lengthDescriptor = descriptors.length;
      if (
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value)
      ) {
        throw new Error("Exchange snapshot raw array length is invalid.");
      }
      const result: unknown[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
          throw new Error("Exchange snapshot raw arrays must be dense data-property arrays.");
        }
        result.push(cloneJsonValue(descriptor.value, seen));
      }
      if (Reflect.ownKeys(value).some((key) => key !== "length" && !/^\d+$/.test(String(key)))) {
        throw new Error("Exchange snapshot raw arrays cannot contain custom fields.");
      }
      return Object.freeze(result);
    }
    const descriptors = plainDataDescriptors(value, "exchange snapshot raw object");
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(descriptors)) {
      result[key] = cloneJsonValue(dataValue(descriptors, key), seen);
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
}

function sameNullableDecimal(left: string | null, right: string | null, label: string): boolean {
  if (left === null || right === null) return left === right;
  return normalizeNonNegativeDecimal(left, `exchange ${label}`) ===
    normalizeNonNegativeDecimal(right, `local ${label}`);
}

function sameOrderIntentDecimal(
  left: string | null,
  right: string | null,
  label: string,
  side: OrderSide,
  ordType: OrderType,
  field: "price" | "volume",
): boolean {
  if (left === null || right === null) return left === right;
  const usesUpbitEightDecimalCanonicalization =
    (side === "bid" && ordType === "price" && field === "price") ||
    (side === "ask" && ordType === "market" && field === "volume");
  if (!usesUpbitEightDecimalCanonicalization) {
    return sameNullableDecimal(left, right, label);
  }
  return canonicalizeUpbitOrderDecimal(left, `exchange ${label}`) ===
    canonicalizeUpbitOrderDecimal(right, `local ${label}`);
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a non-negative decimal string.`);
  normalizeNonNegativeDecimal(value, label);
  return value;
}

function nullableDecimal(value: unknown, label: string): string | null {
  return value === null ? null : decimal(value, label);
}

function normalizeNonNegativeDecimal(value: string, label: string): string {
  if (!/^\d+(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${label} must be a non-negative decimal string.`);
  }
  const [integerPart = "0", fractionalPart = ""] = value.split(".");
  const integer = integerPart.replace(/^0+(?=\d)/u, "");
  const fractional = fractionalPart.replace(/0+$/u, "");
  return fractional.length > 0 ? `${integer}.${fractional}` : integer;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Expected a non-empty string.");
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Expected a nullable string.");
  return value;
}

function supportedMarket(value: unknown): SupportedMarket {
  if (value !== "KRW-BTC" && value !== "KRW-ETH") throw new Error("Unsupported exchange market.");
  return value;
}

function orderSide(value: unknown): OrderSide {
  if (value !== "bid" && value !== "ask") throw new Error("Unsupported exchange order side.");
  return value;
}

function orderType(value: unknown): OrderType {
  if (value !== "limit" && value !== "price" && value !== "market" && value !== "best") {
    throw new Error("Unsupported exchange order type.");
  }
  return value;
}

function timeInForceValue(value: unknown): TimeInForce | null {
  if (value === null) return null;
  if (value !== "ioc" && value !== "fok" && value !== "post_only") {
    throw new Error("Unsupported exchange time in force.");
  }
  return value;
}

function smpTypeValue(value: unknown): UpbitSelfMatchPrevention | null {
  if (value === null) return null;
  if (value !== "cancel_maker" && value !== "cancel_taker" && value !== "reduce") {
    throw new Error("Unsupported exchange SMP type.");
  }
  return value;
}

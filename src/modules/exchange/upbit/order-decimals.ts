const UPBIT_ORDER_DECIMAL_PLACES = 8;

export function canonicalizeUpbitOrderDecimal(value: string, label: string): string {
  if (!/^\d+(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${label} must be a non-negative decimal string.`);
  }

  const [integerPart = "0", fractionalPart = ""] = value.split(".");
  const integer = integerPart.replace(/^0+(?=\d)/u, "");
  const fractional = fractionalPart.slice(0, UPBIT_ORDER_DECIMAL_PLACES).replace(/0+$/u, "");
  return fractional.length > 0 ? `${integer}.${fractional}` : integer;
}

export function serializeUpbitOrderDecimal(value: number, label: string): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
  return canonicalizeUpbitOrderDecimal(String(value), label);
}

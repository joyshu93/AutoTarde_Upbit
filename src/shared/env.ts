export function readBoolean(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue = false
): boolean {
  const rawValue = env[key];

  if (rawValue === undefined || rawValue.trim() === "") {
    return defaultValue;
  }

  const normalized = rawValue.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Expected ${key} to be a boolean-compatible value.`);
}

export function readCsv(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: readonly string[] = []
): readonly string[] {
  const rawValue = env[key];

  if (rawValue === undefined || rawValue.trim() === "") {
    return defaultValue;
  }

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function readEnum<const TValues extends readonly string[]>(
  env: NodeJS.ProcessEnv,
  key: string,
  allowedValues: TValues,
  defaultValue: TValues[number]
): TValues[number] {
  const rawValue = env[key];

  if (rawValue === undefined || rawValue.trim() === "") {
    return defaultValue;
  }

  const normalized = rawValue.trim();

  if ((allowedValues as readonly string[]).includes(normalized)) {
    return normalized as TValues[number];
  }

  throw new Error(`Expected ${key} to be one of: ${allowedValues.join(", ")}`);
}

export function readInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
  bounds?: {
    readonly min?: number;
    readonly max?: number;
  }
): number {
  const rawValue = env[key];

  if (rawValue === undefined || rawValue.trim() === "") {
    return defaultValue;
  }

  const normalized = rawValue.trim();

  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`Expected ${key} to be an integer.`);
  }

  const parsed = Number.parseInt(normalized, 10);

  if (!Number.isInteger(parsed)) {
    throw new Error(`Expected ${key} to be an integer.`);
  }

  if (bounds?.min !== undefined && parsed < bounds.min) {
    throw new Error(`Expected ${key} to be >= ${bounds.min}.`);
  }

  if (bounds?.max !== undefined && parsed > bounds.max) {
    throw new Error(`Expected ${key} to be <= ${bounds.max}.`);
  }

  return parsed;
}

export function readOptionalInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  bounds?: {
    readonly min?: number;
    readonly max?: number;
  }
): number | null {
  const rawValue = env[key];

  if (rawValue === undefined || rawValue.trim() === "") {
    return null;
  }

  const normalized = rawValue.trim();

  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`Expected ${key} to be an integer.`);
  }

  const parsed = Number.parseInt(normalized, 10);

  if (bounds?.min !== undefined && parsed < bounds.min) {
    throw new Error(`Expected ${key} to be >= ${bounds.min}.`);
  }

  if (bounds?.max !== undefined && parsed > bounds.max) {
    throw new Error(`Expected ${key} to be <= ${bounds.max}.`);
  }

  return parsed;
}

export function readOptionalString(env: NodeJS.ProcessEnv, key: string): string | null {
  const rawValue = env[key];

  if (rawValue === undefined || rawValue.trim() === "") {
    return null;
  }

  return rawValue.trim();
}

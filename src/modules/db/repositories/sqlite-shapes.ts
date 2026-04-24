export type SqliteBindValue = string | number | null;

export function toSqliteBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function fromSqliteBoolean(value: number): boolean {
  return value !== 0;
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

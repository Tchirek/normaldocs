export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export async function readJsonRecord(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ValidationError('json_required');
  }
  if (!isRecord(value)) throw new ValidationError('json_object_required');
  return value;
}

export function stringField(record: Record<string, unknown>, key: string, min = 0, max = 10_000): string {
  const value = record[key];
  if (typeof value !== 'string') throw new ValidationError(`${key}_required`);
  const text = value.trim();
  if (text.length < min) throw new ValidationError(`${key}_too_short`);
  if (text.length > max) throw new ValidationError(`${key}_too_long`);
  return text;
}

export function optionalStringField(record: Record<string, unknown>, key: string, max = 10_000): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError(`${key}_invalid`);
  return value.trim().slice(0, max);
}

export function numberField(record: Record<string, unknown>, key: string, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number {
  const value = record[key];
  let parsed: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) parsed = value;
  if (typeof value === 'string' && value.trim()) {
    const fromString = Number(value);
    if (Number.isFinite(fromString)) parsed = fromString;
  }
  if (parsed === null) throw new ValidationError(`${key}_required`);
  if (parsed < min || parsed > max) throw new ValidationError(`${key}_out_of_range`);
  return parsed;
}

export function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') throw new ValidationError(`${key}_required`);
  return value;
}

export function stringArrayField(record: Record<string, unknown>, key: string, limit = 16): string[] | null {
  const value = record[key];
  if (!Array.isArray(value)) return null;
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
    .slice(0, limit);
}

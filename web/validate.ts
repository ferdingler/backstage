/** API errors and input checks shared by route handlers and domain modules. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
export type Json = Record<string, unknown>;
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}
export function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "INVALID_BODY", "Expected a JSON object.");
  return value as Json;
}
export function fields(
  value: Json,
  required: string[],
  optional: string[] = [],
) {
  if (
    required.some((k) => !(k in value)) ||
    Object.keys(value).some((k) => ![...required, ...optional].includes(k))
  )
    fail(400, "INVALID_FIELDS", "Missing or unsupported request fields.");
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !idPattern.test(value))
    fail(400, "INVALID_ID", "Invalid identifier.");
  return value;
}
export function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(400, "INVALID_TEXT", `Enter between 1 and ${max} characters.`);
  return value;
}
export function boolean(value: unknown): boolean {
  if (typeof value !== "boolean")
    fail(400, "INVALID_VALUE", "Expected true or false.");
  return value;
}
export function integer(value: unknown, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  )
    fail(400, "INVALID_VALUE", "Invalid integer.");
  return value;
}

/**
 * Key-order-insensitive JSON comparison for the humanize stage's changed
 * flag: the humanizer may reorder object keys without changing the payload,
 * and the journal must not record a rewrite that did not happen.
 */

/**
 * Stable JSON text: object keys sorted recursively, array order kept.
 * Values beyond JSON's domain (undefined, functions) serialize as `null`,
 * matching JSON.stringify's array/object treatment.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

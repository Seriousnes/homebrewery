// Structural JSON equality. PostgreSQL's jsonb stores object keys in its own order (shortest
// first), so a document that went through the server compares equal only when key order is
// ignored. undefined members count as missing (JSON.stringify drops them too).

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    // NaN never reaches JSON; numbers, strings and booleans compare by value.
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], other[i])) return false;
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || !jsonEqual(left[key], right[key])) return false;
  }
  return true;
}

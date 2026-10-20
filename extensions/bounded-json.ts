// Shared by the transport and browser. Never stringify an unchecked source.
// Work/copies stop at the budget; accessors, cycles and exotic objects fail closed.
const encoder = new TextEncoder();
export const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

export function boundedJson<T>(source: T, limit: number): { value: T; bytes: number } | null {
  let remaining = limit;
  const ancestors = new Set<object>();
  const spend = (bytes: number) => {
    remaining -= bytes;
    if (remaining < 0) throw new Error("budget");
  };
  const string = (value: string) => {
    if (value.length > remaining) throw new Error("budget");
    spend(jsonBytes(value));
    return value;
  };
  const clone = (value: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error("depth");
    if (value === undefined) return undefined;
    if (typeof value === "string") return string(value);
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      spend(jsonBytes(value));
      return value;
    }
    if (typeof value !== "object" || ancestors.has(value)) throw new Error("unsupported");
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error("unsupported");
    ancestors.add(value);
    spend(2);
    try {
      if (array) {
        if (value.length > remaining) throw new Error("budget");
        const result: unknown[] = [];
        for (const child of value) {
          if (result.length) spend(1);
          result.push(clone(child === undefined ? null : child, depth + 1));
        }
        return result;
      }
      const result: Record<string, unknown> = {};
      let count = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("accessor");
        if (descriptor.value === undefined) continue;
        if (count++) spend(1);
        string(key);
        spend(1);
        Object.defineProperty(result, key, { value: clone(descriptor.value, depth + 1), enumerable: true });
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };
  try {
    return { value: clone(source, 0) as T, bytes: limit - remaining };
  } catch {
    return null;
  }
}

/** Prefix by serialized UTF-8 bytes, never splitting a surrogate pair. */
export function jsonTextPrefix(text: string, limit: number): string {
  let end = 0;
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const size =
      code < 32
        ? [8, 9, 10, 12, 13].includes(code)
          ? 2
          : 6
        : code === 34 || code === 92
          ? 2
          : code < 128
            ? 1
            : code < 2048
              ? 2
              : code >= 0xd800 && code <= 0xdfff
                ? 6
                : code <= 0xffff
                  ? 3
                  : 4;
    if (bytes + size > limit) break;
    bytes += size;
    end += char.length;
  }
  // Detach a truncated prefix from a potentially enormous backing string. Both
  // serialization and the copy are bounded, and unpaired surrogates survive.
  return end === text.length ? text : JSON.parse(JSON.stringify(text.slice(0, end)));
}

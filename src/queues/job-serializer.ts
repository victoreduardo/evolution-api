const BUFFER_MARKER = '__u8__';

export function toJobSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [BUFFER_MARKER]: Buffer.from(value).toString('base64') };
  }

  if (Array.isArray(value)) {
    return value.map(toJobSafe);
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJobSafe(val);
    }
    return out;
  }

  return value;
}

export function fromJobSafe(value: unknown): any {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj[BUFFER_MARKER] === 'string' && Object.keys(obj).length === 1) {
      // Buffer.from(...), not `new Uint8Array(...)`: Buffer *is* a Uint8Array, but some
      // downstream code (e.g. Baileys' getStream, used when sending raw audio/media buffers)
      // does a strict Buffer.isBuffer() check and only takes the fast Buffer-shaped path,
      // otherwise falling through to a `.url`/`.stream` branch and crashing on undefined.
      return Buffer.from(obj[BUFFER_MARKER] as string, 'base64');
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      out[key] = fromJobSafe(val);
    }
    return out;
  }

  if (Array.isArray(value)) {
    return value.map(fromJobSafe);
  }

  return value;
}

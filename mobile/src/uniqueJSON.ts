/** Callers bound bytes before decoding. Reject ambiguous duplicate decoded keys. */
export function parseUniqueJSON(raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  const objects: Set<string>[] = [];
  for (let offset = 0; offset < raw.length; offset++) {
    if (raw[offset] === '{') objects.push(new Set());
    else if (raw[offset] === '}') objects.pop();
    else if (raw[offset] === '"') {
      const start = offset++;
      while (offset < raw.length && raw[offset] !== '"') {
        offset += raw[offset] === '\\' ? 2 : 1;
      }
      let next = offset + 1;
      while (/[\t\n\r ]/.test(raw[next] ?? 'x')) next++;
      if (raw[next] === ':') {
        const key: string = JSON.parse(raw.slice(start, offset + 1));
        const keys = objects[objects.length - 1];
        if (!keys || keys.has(key)) throw new Error('Duplicate JSON key');
        keys.add(key);
      }
    }
  }
  return value;
}

/** Fetch with byte-level progress (counts decoded bytes, so totals are uncompressed sizes). */
export async function fetchBytes(url: URL, onChunk: (n: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url.pathname}: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    onChunk(value.length);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

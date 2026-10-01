import {
  CHECKPOINT_LIMIT,
  CHECKPOINT_META_LIMIT,
  hex,
  sha256,
  u32,
  type Boundary,
  type DigestBoundary,
  type CoreState,
} from "./multiplayer.ts";

export interface StreamPosition {
  eventSeq: number;
  chainHash: string;
}
interface Meta extends StreamPosition {
  version: 1;
  descriptor: string;
  nextFrame: number;
  states: { size: number; schema: number; digest: string }[];
}
const enc = new TextEncoder(),
  dec = new TextDecoder("utf-8", { fatal: true });
const hash = (s: unknown, n: number): s is string =>
  typeof s === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
function position(p: StreamPosition) {
  if (
    !Number.isInteger(p.eventSeq) ||
    p.eventSeq < -1 ||
    p.eventSeq > 0xffffffff ||
    !hash(p.chainHash, 16)
  )
    throw new Error("invalid stream position");
}
const bytesOf = (h: string) => Uint8Array.from(h.match(/../g)!, (v) => parseInt(v, 16));
/** Agreement digest is over ordered CORE-OWNED causal digests, bound to descriptor and canonical stream position. */
export async function boundaryDigest(descriptor: string, b: DigestBoundary, p: StreamPosition) {
  position(p);
  return hex(
    await sha256(
      enc.encode(
        JSON.stringify({
          domain: "chiptoy-bundle/1",
          descriptor,
          nextFrame: b.nextFrame,
          eventSeq: p.eventSeq,
          chainHash: p.chainHash,
          states: b.states.map((s) => [s.schema, hex(s.digest)]),
        }),
      ),
    ),
  );
}
export async function encodeCheckpoint(descriptor: string, b: Boundary, p: StreamPosition) {
  position(p);
  if (
    !hash(descriptor, 64) ||
    !u32(b.nextFrame) ||
    !b.states.length ||
    b.states.length > 4 ||
    b.states.some((s) => !u32(s.schema) || s.digest.length !== 32 || !s.bytes.length)
  )
    throw new Error("invalid checkpoint boundary");
  const meta: Meta = {
    version: 1,
    descriptor,
    nextFrame: b.nextFrame,
    ...p,
    states: b.states.map((s) => ({
      size: s.bytes.length,
      schema: s.schema,
      digest: hex(s.digest),
    })),
  };
  const text = enc.encode(JSON.stringify(meta)),
    size = 8 + text.length + b.states.reduce((n, s) => n + s.bytes.length, 0);
  if (text.length > CHECKPOINT_META_LIMIT || size > CHECKPOINT_LIMIT)
    throw new Error("checkpoint exceeds byte limit");
  const payload = new Uint8Array(size);
  payload.set([0x43, 0x54, 0x4d, 0x50]);
  new DataView(payload.buffer).setUint32(4, text.length, true);
  payload.set(text, 8);
  let at = 8 + text.length;
  for (const s of b.states) {
    payload.set(s.bytes, at);
    at += s.bytes.length;
  }
  return {
    payload,
    payloadHash: hex(await sha256(payload)),
    bundleDigest: await boundaryDigest(descriptor, b, p),
    nextFrame: b.nextFrame,
    ...p,
  };
}
/** Hash proves byte integrity, not trust in a producer. Room certification is a separate upper-layer decision. */
export async function decodeCheckpoint(
  payload: Uint8Array,
  expected: {
    descriptor: string;
    payloadHash: string;
    bundleDigest: string;
    consoles: number;
  } & StreamPosition,
) {
  if (
    !(payload instanceof Uint8Array) ||
    payload.length < 8 ||
    payload.length > CHECKPOINT_LIMIT ||
    ![0x43, 0x54, 0x4d, 0x50].every((v, i) => payload[i] === v)
  )
    throw new Error("invalid checkpoint envelope");
  const bytes = payload.slice();
  if (!hash(expected.payloadHash, 64) || hex(await sha256(bytes)) !== expected.payloadHash)
    throw new Error("checkpoint payload hash mismatch");
  const n = new DataView(bytes.buffer).getUint32(4, true);
  if (!n || n > CHECKPOINT_META_LIMIT || n + 8 > bytes.length)
    throw new Error("invalid checkpoint metadata length");
  let m: Meta;
  try {
    m = JSON.parse(dec.decode(bytes.subarray(8, 8 + n)));
  } catch {
    throw new Error("invalid checkpoint metadata");
  }
  if (
    !m ||
    m.version !== 1 ||
    m.descriptor !== expected.descriptor ||
    !u32(m.nextFrame) ||
    !Array.isArray(m.states) ||
    m.states.length !== expected.consoles ||
    m.states.length < 1 ||
    m.states.length > 4
  )
    throw new Error("checkpoint descriptor/topology mismatch");
  position(m);
  if (m.eventSeq !== expected.eventSeq || m.chainHash !== expected.chainHash)
    throw new Error("checkpoint stream position mismatch");
  let at = 8 + n;
  const states: CoreState[] = [];
  for (const s of m.states) {
    if (
      !s ||
      !Number.isInteger(s.size) ||
      s.size < 1 ||
      !u32(s.schema) ||
      !hash(s.digest, 64) ||
      at + s.size > bytes.length
    )
      throw new Error("invalid checkpoint core lengths/schema");
    states.push({
      bytes: bytes.slice(at, at + s.size),
      schema: s.schema,
      digest: bytesOf(s.digest),
    });
    at += s.size;
  }
  if (at !== bytes.length) throw new Error("checkpoint trailing bytes");
  const boundary = { nextFrame: m.nextFrame, states };
  if ((await boundaryDigest(m.descriptor, boundary, m)) !== expected.bundleDigest)
    throw new Error("checkpoint bundle digest mismatch");
  return boundary;
}

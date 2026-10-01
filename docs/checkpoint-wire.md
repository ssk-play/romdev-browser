# Checkpoint wire contract

The room upload travels over a separate authenticated HTTP connection, outside
input delivery. Compression/decompression runs off the emulation/input worker's
critical path, with bounded output and a low upload rate. This document defines
the wire format; hosts implement their own protocol types without importing this
package. Server certification does not replace consumer native restore validation.

The body is an identity or gzip encoding of the complete CTMP bundle, at most
1 MiB both encoded and uncompressed. `rawBytes` is the **whole** uncompressed
envelope length, including eight prefix bytes and JSON metadata; it is not the
sum of the native state sizes. `payloadHash` is SHA-256 of that whole uncompressed
envelope, independent of compression. A transport-byte hash may be separate.

The `x-checkpoint` JSON metadata carries:

- `epoch`, `afterFrame`, `eventSeq`, `chain`, `descriptor`, `bundleDigest`;
- `payloadHash`, `codec: "identity" | "gzip"`, `rawBytes`;
- ordered `consoles: [{slot, core, schema, bytes, digest}]`. Shared screen has
  one canonical slot `255`; player-views have the descriptor's sorted occupied
  slots. `digest` is a 64-character lowercase hex core-owned causal digest.

`eventSeq` is the last committed membership event through `afterFrame`, or `-1`
if there is none. `chain` is the room's immutable chain through that frame. The
inner format calls it `chainHash`; they must be identical. The inner
`nextFrame` must be `afterFrame + 1`. Capture only a complete corrected boundary
whose frame is committed and chosen by the fixed checkpoint/state-check schedule.

The raw CTMP layout is four ASCII bytes `CTMP`, LE32 JSON byte length, UTF-8 JSON
(at most 4096 bytes), followed by each complete native state in canonical order:

```json
{"version":1,"descriptor":"<sha256>","nextFrame":300,"eventSeq":-1,"chainHash":"<16 hex>","states":[{"size":96861,"schema":1195507970,"digest":"<64 hex>"}]}
```

The room bounds decompression before reading the envelope, rejects trailing
bytes, and validates all outer/inner positions, ordered lengths, schemas and
digests. The descriptor binds ROM hash, exact worker build, config and ordered
native schemas; M3/M4a must pin/admit this identity before accepting producer
metadata. Core/slot labels come from that descriptor, not from a producer's
unchecked claim. The raw length must equal `8 + metadataBytes + sum(state.size)`.

`bundleDigest` is SHA-256 of UTF-8 `JSON.stringify` with this **exact key order**:

```text
{domain:"chiptoy-bundle/1",descriptor,nextFrame,eventSeq,chainHash,
 states:[[schema,lowercaseHexCoreDigest], ...]}
```

This same stream-position-bound digest is reported in `StateCheck` for that
frame. The room certifies only when its recorded eligible replicas agree on it;
a producer cannot select a different descriptor, position or digest by upload.
The server can verify this wire envelope without running native cores, but
cannot prove that native bytes reproduce their claimed causal digest. Every
consumer restores all consoles, recomputes native causal digests, and rejects
or retires failed bundles as specified by the transactional restore contract.

Client HTTP compression/retention and upload scheduling are M4c client work.
The M2 worker currently emits/accepts bounded uncompressed CTMP; it does not open
HTTP connections or perform room certification.

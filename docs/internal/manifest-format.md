# roost manifest format spec v1

| field | value |
|---|---|
| **status** | approved |
| **schema version** | 1 (`schemaVersion: 2` per oci convention) |
| **mediaType** | `application/vnd.owlette.manifest.v1+json` |
| **last updated** | 2026-04-19 |
| **owner** | roost (project distribution v2) |
| **scope** | normative for all v2 uploads, downloads, gc, and rollback paths |

> **as shipped:** this is the spec as approved on 2026-04-19, kept as written. the code renamed manifest to version in 2.10.0 and departs from this shape: the mediaType is `application/vnd.owlette.version.v1+json`; `config` is `{}`, with author, timestamps, totals and `parentVersionId` on the firestore version doc (`sites/{siteId}/roosts/{roostId}/versions/{versionId}`); a file entry carries only `path`, `size` and `chunks`; `files` must be non-empty; the version id is the sha-256 of the body's sorted-key json, not a ulid; the roost doc's pointer fields are `currentVersionId`, `previousVersionId` and `versionUrl`; and `POST /api/roosts/{roostId}/versions` checks shape and chunk presence at finalize, while the agent's `sync_version.py` enforces paths and sizes. where the two differ, the code is the reference: `web/lib/chunking.ts`, `web/app/api/roosts/[roostId]/versions/route.ts`, `agent/src/sync_version.py`.

> the manifest is the **authoritative file list** for an upload. every chunk reference here is what the agent will fetch, verify, and assemble. nothing else in the system is allowed to disagree with the manifest — if firestore and the manifest conflict, the manifest wins.

---

## goals

- **single source of truth** for the contents of a synced folder at a given version.
- **content-addressed**: every chunk identified by its sha-256 — the same bytes uploaded twice produce the same hash and are deduplicated automatically.
- **immutable**: a manifest is never mutated after publish. new versions create new manifests; the firestore pointer swap is the only mutation.
- **lineage-preserving**: each manifest names its parent, so the full history of a folder is a linked list walkable by any client with read access.
- **verifiable end-to-end**: the agent can compute every byte's hash and confirm the manifest matches the bytes on disk.
- **schema-evolvable**: derived from oci image manifest v1.1 so future fields can be added without breaking older clients.
- **toolable**: oci-derived shape means existing image-spec tooling (validators, diff tools, registries) can be adapted with minimal effort.

## non-goals

- **not a filesystem snapshot**. no permissions, ownership, xattrs, or hardlinks are preserved. windows acl is reset by the agent at extraction time.
- **not a backup format**. no full-history payload, no dedup catalog. the manifest references chunks; the chunks live in r2.
- **not signed in v1**. v3 will add tuf-style signing with gcp kms. for v1 we rely on tls + firebase auth + signed urls.
- **not compressed in v1**. the manifest itself is plain utf-8 json. see [open questions](#open-questions).
- **no cross-folder reuse references**. each manifest is self-contained — even if two folders share chunks, the manifests independently list them.
- **no encryption metadata**. r2 server-side encryption is implicit; cmek is v3.

---

## format choice rationale

### why oci image manifest v1.1

we evaluated three options:

| option | pros | cons |
|---|---|---|
| **plain custom json** | simplest, no dependencies | no prior art, every tool needs to be built from scratch, schema evolution is ad-hoc |
| **oci image manifest v1.1** | mature spec, schema-versioning baked in, broad tooling ecosystem (cosign, oras, crane), reuses concepts (digest, mediaType, layers, annotations) the team already understands | overhead of fields we don't use; readers must understand it's not a real container image |
| **bittorrent / dat / ipfs car** | content-addressed by design | designed for p2p discovery, not centralized publish; metadata model doesn't fit per-file granularity |

**decision**: derive from oci image manifest v1.1. the schema-versioning discipline alone (`schemaVersion` + `mediaType`) is worth the marginal complexity, and the field shapes (`config` blob, layered content, `annotations` map) map cleanly onto our model.

### what we kept from oci

- top-level `schemaVersion: 2` (matches oci v1.1 — all spec-conformant manifests use 2).
- top-level `mediaType` discriminator.
- `config` object holding manifest-level metadata.
- `annotations` map for arbitrary, non-normative metadata.

### what we changed

- **custom mediaType**: `application/vnd.owlette.manifest.v1+json`. the `vnd.owlette` segment makes it unambiguous that this is not a container image; the `+json` suffix follows rfc 6839.
- **`files` array** replaces oci's `layers`. layers in oci are tar.gz blobs; our content is per-file with per-chunk granularity. semantics differ enough that reusing the field name would mislead readers.
- **`chunks` per file** rather than per-blob digest. oci treats each layer as one digest; we need per-chunk addressing for partial-update semantics.
- **no `subject` / referrers api**. v3 may revisit if we want signed attestations.

### oci spec reference

upstream: https://github.com/opencontainers/image-spec/blob/main/manifest.md (v1.1.0). when reading that doc, mentally substitute:

| oci field | roost equivalent |
|---|---|
| `config.digest` | implicit — config is inline, not blob-referenced |
| `layers[]` | `files[]` |
| `layers[].digest` | `files[].chunks[].hash` (multiple per file) |
| `layers[].size` | `files[].chunks[].size` |
| `subject` | not present in v1 |

---

## schema

### top-level

```json
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.owlette.manifest.v1+json",
  "config": { /* see config schema */ },
  "files": [ /* see file entry schema */ ],
  "annotations": { /* optional string→string map */ }
}
```

| field | type | required | notes |
|---|---|---|---|
| `schemaVersion` | int | yes | must be exactly `2`. matches oci convention. bumped only on breaking changes. |
| `mediaType` | string | yes | must be exactly `application/vnd.owlette.manifest.v1+json`. |
| `config` | object | yes | manifest-level metadata. see below. |
| `files` | array | yes | every file in the upload. may be empty (empty manifest = "this folder is now empty"). |
| `annotations` | object | no | non-normative metadata. clients must ignore unknown keys. |

### config

```json
{
  "name": "string",
  "createdAt": "rfc3339-utc-timestamp",
  "createdBy": "uid-or-owk-key-id",
  "siteId": "string",
  "folderId": "string",
  "parentManifestId": "string-or-null",
  "totalSize": 0,
  "totalFiles": 0
}
```

| field | type | required | notes |
|---|---|---|---|
| `name` | string | yes | human-readable name for the upload (e.g. project name + version label). 1-256 chars. |
| `createdAt` | string | yes | rfc 3339 utc, with `Z` suffix. example: `2026-04-19T18:42:11Z`. server-issued; never trust client clocks. |
| `createdBy` | string | yes | firebase uid for ui-driven uploads, or `owk_<key-id-prefix>` for api uploads. never include the full api key. |
| `siteId` | string | yes | owlette site id. must match the storage path. |
| `folderId` | string | yes | folder id within the site. immutable per manifest lineage. |
| `parentManifestId` | string \| null | yes | id of the previous manifest in this folder's history; `null` only for the very first manifest. forms an immutable linked list. |
| `totalSize` | int | yes | sum of `files[].size` in bytes. denormalised for fast ui display without parsing the array. |
| `totalFiles` | int | yes | length of `files`. denormalised. |

### file entry

```json
{
  "path": "relative/posix/path.toe",
  "size": 12345678,
  "mode": 33188,
  "mtime": "2026-04-19T18:40:02Z",
  "chunks": [
    { "hash": "<64 hex>", "size": 4194304 },
    { "hash": "<64 hex>", "size": 1234567 }
  ]
}
```

| field | type | required | notes |
|---|---|---|---|
| `path` | string | yes | posix path relative to the folder root. see [path constraints](#path-constraints). |
| `size` | int | yes | file size in bytes. must equal `sum(chunks[].size)`. |
| `mode` | int | yes | unix mode bits (e.g. `33188` = `0100644`). on windows the agent ignores everything except a future "executable" bit. recorded for cross-platform forward compatibility. |
| `mtime` | string | yes | rfc 3339 utc. last-modified time as captured at upload. informational only — atomic deploy uses content hash, not mtime. |
| `chunks` | array | yes | ordered list of chunks; concatenating their bytes in order reproduces the file. empty `chunks: []` is only valid when `size: 0` (zero-byte file). |

### chunk

| field | type | required | notes |
|---|---|---|---|
| `hash` | string | yes | lowercase hex sha-256, exactly 64 chars. matches `^[0-9a-f]{64}$`. |
| `size` | int | yes | byte length of this chunk. exactly `4194304` (4 mib) for every chunk except the last in a file. last chunk may be `1..4194304`. |

### annotations

```json
{
  "annotations": {
    "com.owlette.uploadClient": "web/uppy@5.0.1",
    "com.owlette.touchdesigner.version": "2023.11600",
    "com.owlette.tags": "preview,interactive",
    "com.owlette.notes": "first cut, audio still tba"
  }
}
```

- keys are reverse-dns prefixed strings, max 255 chars.
- values are utf-8 strings, max 4 kib each.
- combined `annotations` payload is capped at 64 kib by the validator.
- the official `com.owlette.*` namespace is reserved; future fields may be promoted out of annotations into the schema proper.
- clients must ignore unknown keys. annotations are never load-bearing — they exist for ui display and tooling hints only.

---

## constraints

### path constraints

paths in `files[].path` must:

- use posix forward slashes (`/`). the manifest builder converts windows backslashes at upload time.
- be **relative** to the folder root. no leading `/`.
- contain no `..` segment, in any position.
- contain no `.` as a path segment (single dot).
- contain no null bytes (`\x00`), no carriage returns or newlines.
- be normalised: no consecutive slashes (`a//b`), no trailing slash.
- be valid utf-8, nfc-normalised.
- be unique within the manifest (case-sensitively). two entries with the same `path` is a hard validation error.
- be \<= 1024 bytes when utf-8 encoded.

windows-reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`) are **allowed** in the manifest — the agent's atomic deploy code is responsible for deciding what to do on a windows target. the manifest format is platform-agnostic.

filenames containing characters illegal on windows (`<`, `>`, `:`, `"`, `|`, `?`, `*`) are allowed in the manifest but the agent will reject the upload at extraction time. the dashboard shows a pre-upload warning.

### hash constraints

- algorithm: **sha-256** only in v1.
- encoding: lowercase hex, exactly 64 chars. no `sha256:` prefix (we never mix algorithms in v1, so the prefix is noise; if v2 of this schema adds blake3, we will add an algorithm discriminator at that time).
- the hash is over the **raw bytes** of the chunk as stored in r2. no compression or encoding.

### chunk constraints

- fixed size: **4 mib (4 194 304 bytes)** for every chunk except the last in each file.
- last chunk per file may be `1..4194304` bytes.
- a zero-byte file has `chunks: []` and `size: 0`. the empty chunk is never stored; r2 has no object for it.
- chunks are ordered by file offset. concatenation in order reproduces the file. no gaps, no overlaps.

content-defined chunking (fastcdc / rabin) is explicitly deferred to v3. fixed chunks were chosen to keep the browser uploader and the agent extractor in lock-step (one implementation per side, not two).

### lineage constraints

- `parentManifestId` is the id of the immediately previous manifest for this `folderId`. it is **never null** for any manifest after the first.
- the chain is immutable: once a manifest exists in r2, it is never rewritten or deleted by the publish path. (gc deletes only orphaned chunks, never manifests.)
- rollback to an older version copies the older manifest's chunks pointer-swap-style — the older manifest stays in place and is not duplicated. the new "current" pointer references the older manifest id directly.
- **no merging, no branching**. the lineage is strictly linear per folder. concurrent publish attempts serialise via the firestore compare-and-swap on `currentManifestId`; the loser retries with the new parent.

### size constraints

- single manifest payload: hard cap **32 mib** uncompressed json. for our 500 gb / 4 mib chunk math (~125 000 chunks ≈ 10 mib raw json) this leaves headroom. a folder genuinely larger than the cap must be split into multiple synced folders.
- single file: no schema-level cap, but tier limits apply (see plan: `pricing tiers`). the validator does not enforce tier caps — that is the upload api's job.

---

## storage location

manifests always live in **r2**, never in firestore. the math forces this: a 500 gb upload at 4 mib chunks produces ~125 000 chunk entries × ~80 bytes/entry ≈ 10 mb json, which exceeds firestore's 1 mib document limit by an order of magnitude.

### r2 path

```
project-manifests/{siteId}/{folderId}/{manifestId}.json
```

| segment | source |
|---|---|
| `project-manifests` | fixed bucket prefix; distinct from `project-content/` (chunks). |
| `{siteId}` | the owlette site that owns the folder. |
| `{folderId}` | folder id within the site. |
| `{manifestId}` | server-generated ulid (lexicographic + time-ordered) at finalize time. example: `01HW8Z3VKQXG7M0F5T2EJ1RA9P`. |

### firestore pointer

firestore stores **only the pointer** at:

```
sites/{siteId}/roosts/{roostId}
```

with these fields (excerpt):

| field | type | notes |
|---|---|---|
| `currentManifestId` | string | the `manifestId` currently active for this folder. |
| `previousManifestId` | string \| null | the previous active manifest, used for one-click rollback. set atomically with `currentManifestId` updates. null only for the first publish. |
| `manifestUrl` | string | full r2 url to the current manifest, denormalised so the dashboard avoids a second lookup. |
| `updatedAt` | timestamp | server timestamp on every pointer change. |
| `updatedBy` | string | uid or `owk_<prefix>` of whoever performed the swap. |

the pointer swap is a firestore transaction with compare-and-swap on `currentManifestId` — concurrent publishers serialise; the loser refetches the new parent and rebuilds (or aborts).

### chunk path (for reference)

chunks are stored separately at:

```
project-content/{siteId}/{hash[0:2]}/{hash}
```

per-tenant `siteId` prefix gives isolation by default. the `{hash[0:2]}` shard avoids hot prefixes in r2's keyspace. chunk paths never appear inside the manifest — the agent constructs them from `siteId` (known from the firestore pointer) and `hash` (from the manifest).

---

## example manifest

a small touchdesigner project: one `.toe` (5 mib → 2 chunks) and one `.tox` palette (3 mib → 1 chunk). 3 chunks total.

```json
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.owlette.manifest.v1+json",
  "config": {
    "name": "lobby_screen_v3",
    "createdAt": "2026-04-19T18:42:11Z",
    "createdBy": "BqL0pNkQ3wXfM6vC2sR8tA1eF7hJ",
    "siteId": "site_acme_lobby",
    "folderId": "folder_lobby_main",
    "parentManifestId": "01HW8Z3VKQXG7M0F5T2EJ1RA9P",
    "totalSize": 8388608,
    "totalFiles": 2
  },
  "files": [
    {
      "path": "lobby_screen.toe",
      "size": 5242880,
      "mode": 33188,
      "mtime": "2026-04-19T18:39:47Z",
      "chunks": [
        {
          "hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          "size": 4194304
        },
        {
          "hash": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
          "size": 1048576
        }
      ]
    },
    {
      "path": "palettes/audio_reactive.tox",
      "size": 3145728,
      "mode": 33188,
      "mtime": "2026-04-15T11:02:18Z",
      "chunks": [
        {
          "hash": "fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9",
          "size": 3145728
        }
      ]
    }
  ],
  "annotations": {
    "com.owlette.uploadClient": "web/uppy@5.0.1",
    "com.owlette.touchdesigner.version": "2023.11600",
    "com.owlette.notes": "swapped lighting palette to audio-reactive variant"
  }
}
```

notes on the example:

- `parentManifestId` references the prior publish; the rollback ui can walk back through this chain.
- `totalSize` (`8388608`) equals `5242880 + 3145728` — validators will recompute and reject mismatches.
- `mode 33188` = `0o100644` = regular file, owner rw, group/other r. windows agent ignores it.
- the path `palettes/audio_reactive.tox` shows a nested directory; the manifest format does not list directories explicitly — they are implied by file paths.

---

## versioning + migration

### `schemaVersion` semantics

the top-level `schemaVersion: 2` is **fixed for the entire v1 spec lifetime**. it matches oci's choice; oci has not bumped past 2 since 2017. we follow the same convention: bump `schemaVersion` only when the on-the-wire shape becomes incompatible with existing clients.

### `mediaType` is the real version discriminator

real versioning happens via the `mediaType` field. the current value is:

```
application/vnd.owlette.manifest.v1+json
```

future versions will mint new mediatypes:

```
application/vnd.owlette.manifest.v2+json
```

agents and validators dispatch on `mediaType`. an agent that only knows v1 must reject anything else cleanly — never silently best-effort parse a future version.

### evolution rules

| change type | how |
|---|---|
| **additive optional field** | add to the schema, mark optional, ship. existing manifests remain valid; older clients ignore the field via the "ignore unknown" rule. mediaType stays v1. |
| **additive required field** | breaking. mint v2 mediaType. existing clients reject v2 cleanly. publish path can write both v1 and v2 during transition window. |
| **changing field semantics** | breaking. mint v2 mediaType. **never reuse a field name with new meaning under the v1 mediaType** — that breaks backward compatibility silently. |
| **removing a field** | breaking. mint v2. |
| **changing hash algorithm** | breaking. v2 will introduce an algorithm discriminator (e.g. `"hash": "sha256:abc..."` or a per-chunk `algorithm` field). |
| **changing chunk size policy** | breaking only if existing manifests become invalid. v3's content-defined chunking is a new mediaType. |

### compatibility window

when v2 ships:

- publish path emits v2 by default. older agents (\<= last v1-only release) continue to receive v1 manifests for a configurable transition window (currently planned: 90 days).
- after the window, dashboard surfaces a warning for any agent that has not upgraded.
- after 180 days, the v1 publish path is removed.
- v1 manifests already in r2 are **never rewritten**. older manifests in lineage chains stay v1 forever; that is intentional. the agent must read both versions during rollback.

### unknown-field rule

clients reading a v1 manifest **must ignore** any unknown top-level field, any unknown key in `config`, and any unknown key in a file entry. this is what enables additive evolution within v1. however, unknown fields inside a `chunk` entry are **not** ignored — chunk shape is load-bearing for hashing and verification, and any unknown key there is a hard parse error.

---

## validation

validation happens in three places. all three are strict by default. these checks enforce schema-level invariants (shape, hashes, sizes, paths); the **runtime** security constraints that complement them (per-file `destination_allowlist`, realpath, symlink rejection, decompression-ratio cap, acl) are owned by [`docs/internal/threat-model.md`](./threat-model.md) — specifically baseline B6 and the "path traversal on assembly" attack surface.

### 1. cloud function on finalize

after the upload session ends, a firebase cloud function (`functions/src/chunkVerify.ts` and the manifest-finalize path) validates the manifest **before** writing the firestore pointer. failures here mean the upload is rejected and the orphaned chunks are gc'd within 30 days.

mandatory checks:

- `schemaVersion === 2` and `mediaType` matches exactly.
- all required fields present, types correct.
- `config.totalSize === sum(files[].size)`.
- `config.totalFiles === files.length`.
- `config.parentManifestId` resolves to an existing manifest in this folder (or is null only if folder has no prior manifest).
- `config.siteId` and `config.folderId` match the request context (auth-derived, not trusted from manifest).
- every `files[].path` passes [path constraints](#path-constraints).
- every `files[].size === sum(chunks[].size)`.
- every chunk hash matches `^[0-9a-f]{64}$`.
- every chunk size is `4194304` except the last per file, which is in `1..4194304`.
- every chunk hash exists in `project-content/{siteId}/{hash[0:2]}/{hash}` (head request, not full download).
- annotations payload is \<= 64 kib total.

failures emit rfc 7807 problem+json with `type: https://owlette.app/problems/manifest-invalid` and a `errors` array describing each field-level issue.

### 2. agent on download

before the agent begins fetching chunks, it validates the manifest with the same rules as the cloud function (with the exception of the chunk-existence check — that is implicit in the download itself; a missing chunk surfaces as a 404). this defends against any tampering or corruption between r2 and the agent.

additionally the agent re-verifies each chunk's sha-256 as it is written to the local content store. mismatches abort the publish, mark the chunk corrupt in `sync_state.py`, and trigger a re-fetch.

### 3. ci / dev-tooling

`web/scripts/validate-manifest.ts` (planned; lands with wave 2a finalisation) accepts a manifest path and runs the same validator against it. used in tests and as a pre-commit hook on any manifest fixture committed to the repo.

### no lenient mode

there is no "best effort" or "warn but accept" mode. invalid manifests are rejected. this is the same discipline oci applies and the only way to keep the lineage trustworthy.

---

## open questions

these are explicitly **open** at v1 publish time and may be resolved before or after the spec leaves draft. none of them block the rest of wave 1 from proceeding.

### compression of the manifest itself

10 mib of json compresses to roughly 800 kib with gzip. cloudflare r2 supports `Content-Encoding: gzip` natively, and browsers / `aiohttp` handle it transparently. the open question is whether to:

- (a) store manifests gzipped at rest (`{manifestId}.json.gz`), trading minor download speedup for slightly more complex tooling, **or**
- (b) store plain json and rely on r2's transit-time compression headers, **or**
- (c) defer compression entirely and revisit if manifests trend toward the 32 mib cap.

current lean: (b) — set `Content-Encoding: gzip` at write time, store the gzipped bytes, present the path with `.json` extension. transparent to all readers. decision must be locked before the first beta upload.

### file modes on windows

`mode` is captured at upload time in the browser's manifest builder. on windows there is no meaningful posix mode — the value reported by the browser will typically be the default the file api fabricates. we have three options:

- record whatever the browser gives us (current behavior in the schema).
- omit `mode` on windows uploads and treat it as optional (schema change — would require the field to be optional, which weakens cross-platform consistency).
- always set `mode: 33188` on windows uploads (loses information, but information is meaningless anyway).

current lean: keep as captured; agent ignores. revisit if any user surfaces a real use case for windows mode bits.

### canonical json + manifest hashing

we do **not** currently hash the manifest itself — the firestore pointer references it by `manifestId` (a server-issued ulid), not by content hash. arguments for hashing:

- detects in-place tampering of the r2 object (currently we trust r2's integrity and the signed-url chain).
- makes the manifest itself content-addressed, simplifying v3 signing (sign the hash, not the bytes).

if we adopt manifest hashing, we **must** canonicalize the json first (otherwise whitespace variation breaks reproducibility). proposed canonicalization: rfc 8785 jcs (json canonicalization scheme) — sorted keys, no whitespace, fixed number formatting. the publish path serialises with jcs; readers verify the hash by canonicalizing on receive.

current lean: defer to v3 (signing). adding it in v1 is small, but unused state is technical debt.

### per-file content-type / mime hints

annotations could carry mime types for downstream consumers (web preview, virus scan dispatch). currently out of scope; revisit when the dashboard preview feature is scheduled.

### symlink representation

the manifest format has no symlink entry type. v1 explicitly rejects symlinks at upload time (security — see `docs/internal/threat-model.md`). if a future requirement adds symlink support, it will be a new file `type` field requiring a `mediaType` bump.

### empty folder representation

the manifest does not list directories — they are implied by file paths. a folder containing zero files cannot be represented as anything other than an empty `files: []`. for projects that genuinely require an empty subdirectory, the workaround is to include a `.gitkeep`-style placeholder file. revisit if real users hit this.

---

## change log

| date | change | author |
|---|---|---|
| 2026-04-19 | initial draft, approved at session end. landed in `feature/distribution-v2`. | wave 1.9 |

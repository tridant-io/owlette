# roost stores content-addressed chunks on Cloudflare R2 behind immutable versions

Project distribution v1 sent each machine one project URL to download and unzip in a single shot, with no resume and no rollback. roost replaced it in 2.10.0 with fixed 4 MiB chunks named by their SHA-256 on Cloudflare R2, chosen over S3 and GCS for free egress, the one cost that grows with every machine a project fans out to. Each upload becomes an immutable version, and a Firestore pointer on the roost is the only mutable head, so rollback is a pointer flip and unchanged files are never uploaded or downloaded twice.

## Considered options

- Content-defined chunking (FastCDC): deferred, because fixed chunks keep the browser uploader and the agent assembler to one implementation each.
- A plain custom JSON version format: rejected for one derived from the OCI image manifest v1.1, for its `schemaVersion` and `mediaType` discipline (`docs/internal/manifest-format.md`).

## Consequences

- R2 is roost's only object store: an R2 outage stops new syncs, while machines keep running the files they have.
- Version content never changes after publish; only its description can be edited.

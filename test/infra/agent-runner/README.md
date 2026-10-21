# Containerised agent runner

This runner builds a Python 3.11 Linux container that imports and tests the
roost agent sync modules without a Windows host. It copies the existing agent
source and tests and runs pytest against the sync unit modules.

The runner is intentionally scoped to the sync engine:

- `sync_state.py`
- `sync_version.py`
- `sync_downloader.py`
- `sync_assembler.py`
- `sync_commands.py` for the `sync_pull` command handler

`owlette_service.py` is not an entrypoint target. It is the Windows service
host and imports real pywin32 service APIs at module load.

## Build and run

From the repository root:

```bash
docker compose -f test/infra/docker-compose.yml up --build agent-runner
```

This uses Docker Compose v2/BuildKit named build contexts so the runner can
build from `test/infra/agent-runner/` while copying only `agent/src`,
`agent/tests`, `agent/VERSION`, and `agent/requirements.txt` from the repo root.

The same command also starts the S3 stand-in (versitygw) and waits for the
bucket initialiser before running pytest. The agent container sees it at:

```text
http://s3:9000
```

## Adding test modules

The default test command lives in `test/infra/agent-runner/Dockerfile` as the
`CMD` array. Add new modules in dependency order so failures are easy to
attribute. The recommended order is:

```text
agent/tests/unit/test_sync_state.py
agent/tests/unit/test_sync_version.py
agent/tests/unit/test_sync_downloader.py
agent/tests/unit/test_sync_assembler.py
agent/tests/unit/test_sync_commands.py
test/infra/agent-runner/tests/test_sync_pipeline_minio.py
```

After adding a module, rebuild and run:

```bash
docker compose -f test/infra/docker-compose.yml up --build agent-runner
```

## Known limitations

- The repo does not currently contain `agent/src/sync_pull.py`; `sync_pull` is
  implemented as `_handle_sync_pull` in `agent/src/sync_commands.py`.
- `firebase_client.py` is not a runner entrypoint target, but it does import on
  Linux: it pulls in `shared_utils`, `hardware_profile` and `config_sync` at
  module load and reaches `display_manager`, `nvapi_display` and
  `registry_utils` only inside the display and hardware methods that use them.
- `test_sync_pipeline_minio.py` uses the stand-in for manifest/chunk HTTP fetches and
  mocks Firestore at the Python level. The existing sync modules do not need a
  live Firestore emulator until the CI suite tests web-issued commands or
  `firebase_client` reporting directly.
- No production agent code is changed by this runner.

## CI consumption

CI does not build this image. `.github/workflows/agent-tests.yml` runs the same
module set as the `CMD` above on its ubuntu runner directly —
`agent/requirements.txt` installs on Linux unmodified now, which was the whole
reason this rig existed — and uses `test/infra/docker-compose.yml` for the
stand-in alone:

```bash
docker compose -f test/infra/docker-compose.yml up -d --wait s3
docker compose -f test/infra/docker-compose.yml run --rm init-buckets

export PYTHONPATH=agent/src
export OWLETTE_DATA_ROOT=/tmp/owlette-data
export OWLETTE_R2_ENDPOINT=http://localhost:9000
python -m pytest \
  agent/tests/unit/test_sync_state.py \
  agent/tests/unit/test_sync_version.py \
  agent/tests/unit/test_sync_downloader.py \
  agent/tests/unit/test_sync_assembler.py \
  agent/tests/unit/test_sync_commands.py \
  test/infra/agent-runner/tests/test_sync_pipeline_minio.py -q
```

The remaining `OWLETTE_R2_*` values match the test module defaults, so those
three exports are the whole local setup. The container stays the reproducible
rig: it pins the interpreter and the dependency set, so `up --build
agent-runner` reproduces a clean Linux run without touching the developer
machine's environment.

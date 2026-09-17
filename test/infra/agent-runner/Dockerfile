# syntax=docker/dockerfile:1.6

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OWLETTE_DATA_ROOT=/tmp/owlette-data

WORKDIR /app

# The compose service builds with context ./agent-runner and a named repo
# context so the Dockerfile can copy only the files it needs from the repo
# root without sending agent/build or the rest of the monorepo as the primary
# build context.
COPY --from=repo agent/requirements.txt /tmp/agent-requirements.txt
COPY requirements.txt /tmp/agent-runner-requirements.txt

# agent/requirements.txt installs unmodified: the Windows-only packages
# (pywin32, wmi, HardwareMonitor, pythonnet) carry sys_platform markers, so pip
# skips them on Linux and the rig no longer has to rewrite the file.
RUN pip install --no-cache-dir --disable-pip-version-check \
        -r /tmp/agent-requirements.txt \
        -r /tmp/agent-runner-requirements.txt

COPY --from=repo agent/src/ /app/agent/src/
COPY --from=repo agent/tests/ /app/agent/tests/
COPY --from=repo agent/VERSION /app/agent/VERSION
COPY tests/ /app/test/infra/agent-runner/tests/

ENV PYTHONPATH=/app/agent/src:/app

CMD ["python", "-m", "pytest", "agent/tests/unit/test_sync_state.py", "agent/tests/unit/test_sync_version.py", "agent/tests/unit/test_sync_downloader.py", "agent/tests/unit/test_sync_assembler.py", "agent/tests/unit/test_sync_commands.py", "test/infra/agent-runner/tests/test_sync_pipeline_minio.py", "-v"]

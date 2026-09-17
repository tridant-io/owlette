"""Machine identity is persisted, and the token key is bound to the machine alone.

The hostname seeds `config/machine_id` once and is never consulted for identity
again: a rename must not fork the Firestore document, and — now that the Fernet
key has dropped its hostname term — must not brick the token store either. A
store written under the previous derivation is re-encrypted on first load, with
the original bytes retained alongside for a rollback inside this minor.
"""

import base64
import builtins
import errno
import hashlib
import json
import logging
import os
import platform
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet

import osadapter
import secure_storage
import shared_utils

# Stands in for MachineGuid / IOPlatformUUID / /etc/machine-id, so the
# derivation under test is the test's to control on every CI leg.
MACHINE_BINDING = b'9f2c1d7a-4b80-4f3e-9c11-machine-binding'

RETAINED_NAME = secure_storage.TOKEN_FILE_NAME + secure_storage.PRE_MIGRATION_SUFFIX


@pytest.fixture(autouse=True)
def data_root(tmp_path, monkeypatch):
    """The data root and the in-process identity cache, sandboxed for one test."""
    monkeypatch.setenv(osadapter.DATA_ROOT_ENV, str(tmp_path))
    monkeypatch.setattr(shared_utils, '_machine_id', None)
    return tmp_path


@pytest.fixture
def machine_binding(monkeypatch):
    """A fixed machine binding behind the real `osadapter` seam — no arm for the
    platform the suite happens to be running on is needed."""
    monkeypatch.setattr(osadapter, '_adapter', SimpleNamespace(
        key_material=lambda: MACHINE_BINDING,
        stable_machine_id=lambda: MACHINE_BINDING.decode(),
    ))


def _pre_migration_cipher() -> Fernet:
    """The cipher the derivation this replaced produced: the machine binding,
    the hostname, and the fixed suffix. Spelled out rather than taken from
    secure_storage, so the migration is tested against the old format and not
    against a mirror of the code that reads it."""
    material = MACHINE_BINDING + b':' + platform.node().encode('utf-8') + b':owlette-agent'
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(material).digest()))


def _pre_migration_blob(payload: dict) -> bytes:
    """A token store as that derivation wrote it."""
    return _pre_migration_cipher().encrypt(json.dumps(payload).encode('utf-8'))


def _intercept_token_writes(monkeypatch, on_write):
    """Hand `on_write(name, fd, blob, real_write)` every write to a token file.

    The writer is exercised as it ships — the failure shapes below start after
    `os.open` has succeeded, which a stub standing in for `_write_token_file`
    cannot produce. Descriptors opened elsewhere keep the real `os.write`.
    """
    real_open, real_write = os.open, os.write
    watched = {}

    def tracking_open(path, *args, **kwargs):
        fd = real_open(path, *args, **kwargs)
        watched[fd] = os.path.basename(str(path))
        return fd

    def intercepting_write(fd, blob):
        if fd not in watched:
            return real_write(fd, blob)
        return on_write(watched[fd], fd, blob, real_write)

    monkeypatch.setattr(secure_storage.os, 'open', tracking_open)
    monkeypatch.setattr(secure_storage.os, 'write', intercepting_write)


def test_the_identity_is_seeded_from_the_hostname(data_root, monkeypatch):
    monkeypatch.setattr(shared_utils, 'get_hostname', lambda: 'KIOSK-01')

    assert shared_utils.get_machine_id() == 'KIOSK-01'
    assert (data_root / 'config' / 'machine_id').read_text(encoding='utf-8') == 'KIOSK-01'


def test_an_existing_identity_is_read_rather_than_reseeded(data_root, monkeypatch):
    """The upgrade path: a machine already registered keeps the document it has."""
    (data_root / 'config').mkdir()
    (data_root / 'config' / 'machine_id').write_text('REGISTERED-01', encoding='utf-8')
    monkeypatch.setattr(shared_utils, 'get_hostname', lambda: 'KIOSK-01')

    assert shared_utils.get_machine_id() == 'REGISTERED-01'


def test_an_empty_identity_file_is_reseeded(data_root, monkeypatch):
    """A machine killed between creating the file and writing it leaves an empty
    one. Reading that as "no identity yet" would put the hostname back in the
    identity's place, and the next rename would fork the document after all."""
    (data_root / 'config').mkdir()
    id_file = data_root / 'config' / 'machine_id'
    id_file.write_text('', encoding='utf-8')
    monkeypatch.setattr(shared_utils, 'get_hostname', lambda: 'KIOSK-01')

    assert shared_utils.get_machine_id() == 'KIOSK-01'
    assert id_file.read_text(encoding='utf-8') == 'KIOSK-01'

    monkeypatch.setattr(shared_utils, '_machine_id', None)
    monkeypatch.setattr(shared_utils, 'get_hostname', lambda: 'KIOSK-01-RENAMED')

    assert shared_utils.get_machine_id() == 'KIOSK-01'


def test_an_unreadable_identity_file_is_never_reseeded(data_root, monkeypatch):
    """A sharing violation is not an absent identity: seeding over one would
    re-key a registered machine's document."""
    (data_root / 'config').mkdir()
    id_file = data_root / 'config' / 'machine_id'
    id_file.write_text('REGISTERED-01', encoding='utf-8')
    monkeypatch.setattr(shared_utils, 'get_hostname', lambda: 'KIOSK-01')

    real_open = builtins.open

    def refusing_open(file, *args, **kwargs):
        if str(file) == str(id_file):
            raise PermissionError(13, 'Permission denied')
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(builtins, 'open', refusing_open)

    assert shared_utils.get_machine_id() == 'KIOSK-01'
    assert id_file.read_text(encoding='utf-8') == 'REGISTERED-01'

    # And the hostname stood in for that call alone. Keeping it would leave the
    # process addressing a document the machine's token does not cover: every
    # write denied, and the refresh that follows answered 403 — which clears the
    # credentials outright.
    monkeypatch.setattr(builtins, 'open', real_open)

    assert shared_utils.get_machine_id() == 'REGISTERED-01'


def test_a_rename_leaves_the_persisted_identity_alone(data_root, monkeypatch):
    monkeypatch.setattr(shared_utils, 'get_hostname', lambda: 'KIOSK-01')
    seeded = shared_utils.get_machine_id()

    # A restart after the machine was renamed.
    monkeypatch.setattr(shared_utils, '_machine_id', None)
    monkeypatch.setattr(shared_utils, 'get_hostname', lambda: 'KIOSK-01-RENAMED')

    assert shared_utils.get_machine_id() == seeded == 'KIOSK-01'


def test_a_rename_leaves_the_token_store_readable(data_root, machine_binding, monkeypatch):
    """The derivation this replaced mixed in `platform.node()`, so a DHCP-driven
    macOS rename bricked the store. Nothing but the machine binding keys it now."""
    assert secure_storage.SecureStorage(data_root).save_refresh_token('refresh-abc') is True

    monkeypatch.setattr(platform, 'node', lambda: 'renamed-host.local')

    assert secure_storage.SecureStorage(data_root).get_refresh_token() == 'refresh-abc'
    assert not (data_root / RETAINED_NAME).exists()


def test_a_pre_migration_store_is_re_encrypted_exactly_once(data_root, machine_binding, monkeypatch):
    token_file = data_root / secure_storage.TOKEN_FILE_NAME
    original = _pre_migration_blob({'refresh_token': 'refresh-abc', 'site_id': 'site-1'})
    token_file.write_bytes(original)

    written = []
    real_write = secure_storage._write_token_file

    def recording_write(path, blob):
        written.append(path.name)
        real_write(path, blob)

    monkeypatch.setattr(secure_storage, '_write_token_file', recording_write)

    storage = secure_storage.SecureStorage(data_root)

    assert storage.get_refresh_token() == 'refresh-abc'
    assert written == [RETAINED_NAME, secure_storage.TOKEN_FILE_NAME]
    assert (data_root / RETAINED_NAME).read_bytes() == original

    rewritten = token_file.read_bytes()
    assert rewritten != original

    # Every later read, in this process and the next, decrypts under the new key.
    assert storage.get_site_id() == 'site-1'
    assert secure_storage.SecureStorage(data_root).get_site_id() == 'site-1'
    assert token_file.read_bytes() == rewritten
    assert written == [RETAINED_NAME, secure_storage.TOKEN_FILE_NAME]


def test_a_failed_re_encrypt_leaves_the_original_store_intact(data_root, machine_binding, monkeypatch):
    token_file = data_root / secure_storage.TOKEN_FILE_NAME
    original = _pre_migration_blob({'refresh_token': 'refresh-abc'})
    token_file.write_bytes(original)

    refused = []
    real_write = secure_storage._write_token_file

    def failing_write(path, blob):
        if path.name == secure_storage.TOKEN_FILE_NAME:
            refused.append(path.name)
            raise PermissionError(13, 'Permission denied')
        real_write(path, blob)

    monkeypatch.setattr(secure_storage, '_write_token_file', failing_write)

    storage = secure_storage.SecureStorage(data_root)

    assert storage.get_refresh_token() == 'refresh-abc'
    assert token_file.read_bytes() == original
    assert (data_root / RETAINED_NAME).read_bytes() == original
    assert refused == [secure_storage.TOKEN_FILE_NAME] * 2  # the write, and one retry


def test_a_short_write_is_finished_rather_than_reported_as_a_rewrite(
        data_root, machine_binding, monkeypatch):
    """A full disk answers write(2) with a short count and no error. Taking that
    count on trust would call a store missing its tail re-encrypted, and the
    next process to open it finds credentials it cannot decrypt under either
    key."""
    token_file = data_root / secure_storage.TOKEN_FILE_NAME
    original = _pre_migration_blob({'refresh_token': 'refresh-abc', 'site_id': 'site-1'})
    token_file.write_bytes(original)

    _intercept_token_writes(
        monkeypatch,
        lambda name, fd, blob, real_write: real_write(fd, blob[:16]),
    )

    storage = secure_storage.SecureStorage(data_root)

    assert storage.get_refresh_token() == 'refresh-abc'
    assert (data_root / RETAINED_NAME).read_bytes() == original
    assert token_file.read_bytes() != original
    # Whole under the new key: the next process reads it without the migration.
    assert secure_storage.SecureStorage(data_root).get_site_id() == 'site-1'


def test_a_rewrite_that_fails_mid_write_says_what_is_on_disk(
        data_root, machine_binding, monkeypatch, caplog):
    """`_write_token_file` truncates at the open, so a write that fails after it
    leaves the store short — not "left under the previous key", which reads as
    no action needed. A restart before the next save then comes up
    unauthenticated with nothing in the log that pointed at the copy."""
    token_file = data_root / secure_storage.TOKEN_FILE_NAME
    original = _pre_migration_blob({'refresh_token': 'refresh-abc', 'site_id': 'site-1'})
    token_file.write_bytes(original)

    def out_of_space(name, fd, blob, real_write):
        if name == secure_storage.TOKEN_FILE_NAME:
            raise OSError(errno.ENOSPC, 'No space left on device')
        return real_write(fd, blob)

    _intercept_token_writes(monkeypatch, out_of_space)

    with caplog.at_level(logging.ERROR):
        storage = secure_storage.SecureStorage(data_root)
        assert storage.get_refresh_token() == 'refresh-abc'

    assert token_file.read_bytes() == b''
    assert (data_root / RETAINED_NAME).read_bytes() == original
    assert 'could not be rewritten' in caplog.text
    assert RETAINED_NAME in caplog.text


def test_a_failed_re_encrypt_keeps_every_later_read_working(data_root, machine_binding, monkeypatch):
    """The store is still under the previous key, so it must keep reading under
    it. Reading it as empty would let the next save write a payload with no
    refresh token in it — destroying on disk what the failed rewrite spared."""
    token_file = data_root / secure_storage.TOKEN_FILE_NAME
    token_file.write_bytes(_pre_migration_blob({'refresh_token': 'refresh-abc',
                                                'site_id': 'site-1'}))

    real_write = secure_storage._write_token_file
    attempts = []
    locked = True

    def failing_write(path, blob):
        attempts.append(path.name)
        if locked and path.name == secure_storage.TOKEN_FILE_NAME:
            raise PermissionError(13, 'Permission denied')
        real_write(path, blob)

    monkeypatch.setattr(secure_storage, '_write_token_file', failing_write)
    storage = secure_storage.SecureStorage(data_root)

    assert storage.get_refresh_token() == 'refresh-abc'
    migration = [RETAINED_NAME] + [secure_storage.TOKEN_FILE_NAME] * 2  # the write, and one retry
    assert attempts == migration

    assert storage.get_refresh_token() == 'refresh-abc'
    assert storage.get_site_id() == 'site-1'
    assert storage.is_configured() is True
    # Read under the cipher that read it the first time, not re-migrated per getter.
    assert attempts == migration

    # The lock clears an hour later; caching an access token must not drop what
    # was already in the store.
    locked = False
    assert storage.save_access_token('access-abc', 1.0) is True

    reopened = secure_storage.SecureStorage(data_root)
    assert reopened.get_refresh_token() == 'refresh-abc'
    assert reopened.get_site_id() == 'site-1'


def test_an_unreadable_store_is_never_healed_from_the_retained_copy(
        data_root, machine_binding, caplog):
    """The retained copy is the store as it stood at the migration and is never
    refreshed, so the refresh token in it was rotated away within the hour.
    Promoting it would put that dead credential back over the live store, the
    server would answer 403, and a 403 clears the store AND the copy — turning a
    rollback still sitting on disk into a site visit. It is named, not used."""
    token_file = data_root / secure_storage.TOKEN_FILE_NAME
    retained = data_root / RETAINED_NAME
    stale = _pre_migration_blob({'refresh_token': 'rotated-away', 'site_id': 'site-1'})
    retained.write_bytes(stale)
    token_file.write_bytes(b'')

    with caplog.at_level(logging.WARNING):
        storage = secure_storage.SecureStorage(data_root)
        assert storage.get_refresh_token() is None
        assert storage.get_site_id() is None

    assert token_file.read_bytes() == b''
    assert retained.read_bytes() == stale
    # Named once, not once per getter.
    assert caplog.text.count(RETAINED_NAME) == 1


def test_a_cortex_key_provisioned_before_the_change_still_decrypts(
        data_root, machine_binding, monkeypatch):
    """config.json survives an upgrade, and the Cortex LLM key in it is held
    under the same cipher as the token store — so it migrates with it, or every
    provisioned machine runs hoot keyless until an operator re-provisions."""
    import owlette_cortex

    storage = secure_storage.SecureStorage(data_root)
    provisioned = _pre_migration_cipher().encrypt(b'sk-ant-provisioned').decode('utf-8')

    monkeypatch.setattr(secure_storage, 'get_storage', lambda: storage)
    monkeypatch.setattr(shared_utils, 'read_config',
                        lambda *a, **k: {'cortex': {'apiKeyEncrypted': provisioned,
                                                    'model': 'claude-opus-5'}})
    writes = []
    monkeypatch.setattr(shared_utils, 'write_config',
                        lambda keys, value: writes.append((keys, value)))

    config = {'cortex': {'apiKeyEncrypted': provisioned, 'enabled': True}}
    assert owlette_cortex.get_cortex_api_key(config) == 'sk-ant-provisioned'

    # And it is rewritten under the new key, so no later rename can take it.
    (keys, value), = writes
    assert keys == ['cortex']
    assert value['model'] == 'claude-opus-5'
    assert storage.decrypt_value(value['apiKeyEncrypted']) == ('sk-ant-provisioned', False)


def test_a_store_that_cannot_be_retained_stays_on_the_previous_key(
        data_root, machine_binding, monkeypatch):
    """The retained copy is written first, so a failure there costs nothing — and
    the saves that follow must not quietly finish the migration the retain could
    not start. A store under the new key with no copy beside it is a machine the
    hotfix rollback has nothing to rename."""
    token_file = data_root / secure_storage.TOKEN_FILE_NAME
    original = _pre_migration_blob({'refresh_token': 'refresh-abc'})
    token_file.write_bytes(original)

    real_write = secure_storage._write_token_file
    locked = True

    def failing_write(path, blob):
        if locked:
            raise PermissionError(13, 'Permission denied')
        real_write(path, blob)

    monkeypatch.setattr(secure_storage, '_write_token_file', failing_write)

    storage = secure_storage.SecureStorage(data_root)

    assert storage.get_refresh_token() == 'refresh-abc'
    assert token_file.read_bytes() == original
    assert not (data_root / RETAINED_NAME).exists()
    # No copy to fall back on, so the cipher that read the store is what keeps
    # every later read — and the next save — whole.
    assert storage.get_refresh_token() == 'refresh-abc'
    assert storage.has_refresh_token() is True

    # The disk frees up an hour later. Caching an access token must leave the
    # store where a pre-migration agent can still read it.
    locked = False
    assert storage.save_access_token('access-abc', 1.0) is True
    assert json.loads(_pre_migration_cipher().decrypt(token_file.read_bytes())) == {
        'refresh_token': 'refresh-abc',
        'access_token': 'access-abc',
        'token_expiry': 1.0,
    }

    # And the next run retries the migration from the start.
    reopened = secure_storage.SecureStorage(data_root)
    assert reopened.get_refresh_token() == 'refresh-abc'
    retained = _pre_migration_cipher().decrypt((data_root / RETAINED_NAME).read_bytes())
    assert json.loads(retained)['refresh_token'] == 'refresh-abc'


def test_a_half_written_retained_copy_is_not_mistaken_for_one(
        data_root, machine_binding, monkeypatch):
    """`_write_token_file` truncates before it writes, so a write that dies
    part way leaves a file behind. A store under the new key with only that
    beside it is a machine the hotfix rollback has nothing to rename, so the
    unusable copy is dropped and the store stays on the previous key."""
    token_file = data_root / secure_storage.TOKEN_FILE_NAME
    original = _pre_migration_blob({'refresh_token': 'refresh-abc'})
    token_file.write_bytes(original)

    real_write = secure_storage._write_token_file

    def truncating_write(path, blob):
        if path.name.endswith(secure_storage.PRE_MIGRATION_SUFFIX):
            real_write(path, b'')
            raise OSError(28, 'No space left on device')
        real_write(path, blob)

    monkeypatch.setattr(secure_storage, '_write_token_file', truncating_write)

    storage = secure_storage.SecureStorage(data_root)

    assert storage.get_refresh_token() == 'refresh-abc'
    assert not (data_root / RETAINED_NAME).exists()
    assert token_file.read_bytes() == original

    # The next save must stay where a pre-migration agent can still read it.
    monkeypatch.setattr(secure_storage, '_write_token_file', real_write)
    assert storage.save_access_token('access-abc', 1.0) is True
    assert json.loads(_pre_migration_cipher().decrypt(token_file.read_bytes())) == {
        'refresh_token': 'refresh-abc',
        'access_token': 'access-abc',
        'token_expiry': 1.0,
    }


def test_the_token_file_is_written_owner_only_off_windows(data_root, machine_binding, monkeypatch):
    """The daemons run at umask 022 inside a group-traversable root, so the mode
    is handed to os.open and then set outright. Only the calls can be asserted
    here; the mode a real POSIX file lands with is a CI-leg check."""
    token_file = str(data_root / secure_storage.TOKEN_FILE_NAME)
    opened = []
    chmodded = []
    real_open = os.open

    def recording_open(path, flags, mode=0o777, **kwargs):
        if path == token_file:
            opened.append((path, flags, mode))
        return real_open(path, flags, mode, **kwargs)

    storage = secure_storage.SecureStorage(data_root)

    monkeypatch.setattr(os, 'name', 'posix')
    monkeypatch.setattr(os, 'open', recording_open)
    monkeypatch.setattr(os, 'chmod', lambda path, mode: chmodded.append((path, mode)))

    assert storage.save_refresh_token('refresh-abc') is True

    (path, flags, mode), = opened
    assert path == token_file
    assert mode == 0o600
    assert flags & os.O_WRONLY
    assert flags & os.O_CREAT
    assert flags & os.O_TRUNC
    nofollow = getattr(os, 'O_NOFOLLOW', 0)
    assert flags & nofollow == nofollow
    assert chmodded == [(token_file, 0o600)]


@pytest.mark.skipif(os.name == 'nt', reason='Windows has no O_NOFOLLOW')
def test_the_token_file_refuses_a_symlink_on_posix():
    """A symlink planted at the path must not redirect the write."""
    assert secure_storage._TOKEN_FILE_FLAGS & os.O_NOFOLLOW

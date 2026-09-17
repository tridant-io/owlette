"""
Secure Token Storage for Owlette Agent

This module provides secure storage for OAuth tokens using encrypted files.
Tokens are encrypted with a machine-specific key and stored in config directory.

Security Features:
- Tokens encrypted using Fernet symmetric encryption
- Encryption key derived from machine UUID (machine-specific)
- Stored in hidden config file with restrictive permissions
- Automatic cleanup of expired tokens

Usage:
    storage = SecureStorage()
    storage.save_refresh_token("abc123...")
    token = storage.get_refresh_token()
    storage.clear_tokens()  # Remove all stored tokens
"""

import os
import json
import logging
import platform
from pathlib import Path
from typing import Optional
from cryptography.fernet import Fernet, InvalidToken
import base64
import hashlib
import osadapter
import shared_utils

logger = logging.getLogger(__name__)

TOKEN_FILE_NAME = ".tokens.enc"  # Hidden file in config directory
PRE_MIGRATION_SUFFIX = ".v1"  # The copy kept across a key-derivation change

# The token file is written through os.open rather than open(): the POSIX
# daemons run at umask 022 inside a group-traversable data root, where a plain
# open() would leave the store readable by every account on the machine.
# O_NOFOLLOW refuses a symlink planted at the path; Windows has neither flag,
# and O_BINARY there keeps os.write byte-exact.
_TOKEN_FILE_FLAGS = (
    os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
)
_TOKEN_FILE_MODE = 0o600

_KEY_SUFFIX = b':owlette-agent'

_FILE_ATTRIBUTE_HIDDEN = 0x02
_FILE_ATTRIBUTE_ARCHIVE = 0x20
_FILE_ATTRIBUTE_NORMAL = 0x80


def _cipher(key_material: bytes) -> Fernet:
    """The Fernet cipher a given key material derives."""
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(key_material).digest()))


def _key_material() -> bytes:
    """Machine-bound and nothing else: MachineGuid, IOPlatformUUID, machine-id."""
    return osadapter.key_material() + _KEY_SUFFIX


def _pre_migration_key_material() -> bytes:
    """The derivation this replaced, which mixed in the hostname — a rename or a
    fresh DHCP lease moved it out from under the store."""
    return osadapter.key_material() + b':' + platform.node().encode('utf-8') + _KEY_SUFFIX


def _machine_fingerprint() -> str:
    """The machine id as a short hash — enough to correlate two log lines, never
    enough to reconstruct the key derived from it."""
    return hashlib.sha256(osadapter.stable_machine_id().encode('utf-8')).hexdigest()[:8]


def _set_windows_attributes(path: Path, attributes: int) -> None:
    """Set Windows file attributes; a no-op when the file is not there yet."""
    if not path.exists():
        return
    import ctypes
    ctypes.windll.kernel32.SetFileAttributesW(str(path), attributes)


def _write_token_file(path: Path, blob: bytes) -> None:
    """Write `blob` to `path`, owner-only and hidden on Windows.

    Raises OSError when the file cannot be opened, or when anything short of
    every byte of `blob` reaches it.
    """
    if os.name == 'nt':
        # A hidden file cannot be reopened for writing.
        _set_windows_attributes(path, _FILE_ATTRIBUTE_NORMAL)

    fd = os.open(str(path), _TOKEN_FILE_FLAGS, _TOKEN_FILE_MODE)
    try:
        # os.write is one write(2): a full disk answers with a short count
        # rather than an error, and O_TRUNC has already emptied the file — so
        # a count taken on trust turns a store missing its tail into a
        # successful write.
        written = 0
        while written < len(blob):
            count = os.write(fd, blob[written:])
            if count <= 0:
                raise OSError(f"{path.name}: the write stalled at {written} of {len(blob)} bytes")
            written += count
    finally:
        os.close(fd)

    if os.name == 'nt':
        # +archive keeps the file writable next time.
        _set_windows_attributes(path, _FILE_ATTRIBUTE_HIDDEN | _FILE_ATTRIBUTE_ARCHIVE)
    else:
        # os.open subtracts the umask from the mode it is handed.
        os.chmod(str(path), _TOKEN_FILE_MODE)


class SecureStorage:
    """
    Secure storage for agent authentication tokens.

    Uses encrypted file storage with machine-specific encryption key.
    Tokens stored in C:\\ProgramData\\Owlette\\.tokens.enc (hidden file).
    """

    def __init__(self, config_dir: Optional[Path] = None):
        """
        Initialize secure storage.

        Args:
            config_dir: Directory for token file (default: C:\\ProgramData\\Owlette)
        """
        if config_dir is None:
            # The data root: reachable by both regular users and SYSTEM.
            config_dir = Path(shared_utils.get_data_path())

        self.config_dir = Path(config_dir)
        self.token_file = self.config_dir / TOKEN_FILE_NAME
        self._migration_attempted = False
        self._pre_migration_fernet: Optional[Fernet] = None
        self._retained_notice_logged = False
        self._fernet = self._get_cipher()
        logger.debug(f"SecureStorage initialized: {self.token_file}")

    def _get_cipher(self) -> Fernet:
        """Get Fernet cipher with machine-specific key."""
        try:
            return _cipher(_key_material())
        except Exception as e:
            logger.error(f"Failed to generate encryption key: {e}")
            raise

    def _retained_file(self) -> Path:
        """The copy kept alongside the store across the key-derivation change."""
        return self.token_file.with_name(self.token_file.name + PRE_MIGRATION_SUFFIX)

    def _read_file(self, path: Path) -> bytes:
        """The file's bytes, empty when it is missing or cannot be read."""
        try:
            with open(path, 'rb') as f:
                return f.read()
        except FileNotFoundError:
            return b''
        except OSError as e:
            logger.error(f"Failed to read {path.name}: {e}")
            return b''

    def _rewrite_store(self, decrypted_data: bytes) -> bool:
        """Write the store under the current key, with a single retry."""
        for attempt in (1, 2):
            try:
                _write_token_file(self.token_file, self._fernet.encrypt(decrypted_data))
                return True
            except OSError as e:
                logger.error(f"Token store re-encrypt attempt {attempt} failed: {e}")
        return False

    def _migrate_token_file(self, encrypted_data: bytes) -> Optional[bytes]:
        """Re-encrypt a store written under the pre-migration key derivation.

        The original bytes are kept alongside as `.tokens.enc.v1` before the
        rewrite — a pre-migration agent cannot read the rewritten file, and the
        copy is what a rollback within this minor reads. A rewrite that cannot
        be made leaves the store as the failed write left it — whole under the
        old key when the file could not be opened, short when the write itself
        failed — which is why the copy is written first. The cipher that read
        the store is kept either way, so later reads in this process resolve:
        an empty read would otherwise let the next save write a payload with no
        refresh token in it.

        Returns the decrypted bytes, or None when this is not a pre-migration
        store. The rewrite is attempted once per process.
        """
        if self._pre_migration_fernet is not None:
            try:
                return self._pre_migration_fernet.decrypt(encrypted_data)
            except InvalidToken:
                return None

        if self._migration_attempted:
            return None
        self._migration_attempted = True

        pre_migration_fernet = _cipher(_pre_migration_key_material())
        try:
            decrypted_data = pre_migration_fernet.decrypt(encrypted_data)
        except InvalidToken:
            return None

        logger.info(
            f"Token store predates the machine-bound key — re-encrypting "
            f"(machine {_machine_fingerprint()})"
        )

        retained = self._retained_file()
        if not self._retain_previous_store(retained, encrypted_data):
            logger.error(
                "Failed to retain the previous token store — leaving it "
                "under the previous key"
            )
            self._pre_migration_fernet = pre_migration_fernet
            return decrypted_data

        if self._rewrite_store(decrypted_data):
            logger.info(f"Token store re-encrypted; previous copy retained at {retained.name}")
            return decrypted_data

        logger.error(
            f"Token store could not be rewritten — what is on disk may be short; "
            f"{retained.name} is the copy to restore"
        )
        self._pre_migration_fernet = pre_migration_fernet
        return decrypted_data

    def _retain_previous_store(self, retained: Path, encrypted_data: bytes) -> bool:
        """Keep the store as it stands beside the one about to replace it.

        Read back before it counts: `_write_token_file` truncates before it
        writes, so a failed or short write still leaves a file, and
        `_writer_fernet` reads any file there as a usable copy and moves the
        store to the new key on the next save. A copy that cannot be proved is
        removed, so that check only ever sees a whole one.
        """
        try:
            _write_token_file(retained, encrypted_data)
            if self._read_file(retained) == encrypted_data:
                return True
            logger.error(f"{retained.name} was written short")
        except OSError as e:
            logger.error(f"Could not write {retained.name}: {e}")
        try:
            retained.unlink(missing_ok=True)
        except OSError as e:
            logger.error(f"Could not remove the unusable {retained.name}: {e}")
        return False

    def _note_retained_copy(self) -> None:
        """Say so, once, when a store that cannot be read has a copy beside it.

        The copy is the store as it stood at the migration and is never
        refreshed, so promoting it would put back a refresh token the server has
        since rotated away — which comes back 401/403, and that clears the
        credentials outright, this copy included. Restoring it is the runbook's
        rename, made deliberately.
        """
        retained = self._retained_file()
        if self._retained_notice_logged or not retained.exists():
            return

        self._retained_notice_logged = True
        logger.warning(
            f"Token store unreadable; the pre-migration copy {retained.name} is "
            f"still on disk (machine {_machine_fingerprint()}) — restoring it is "
            f"the rollback step in the hotfix runbook"
        )

    def _load_data(self) -> dict:
        """Load and decrypt token data from file."""
        try:
            encrypted_data = self._read_file(self.token_file)

            decrypted_data = None
            if encrypted_data:
                try:
                    decrypted_data = self._fernet.decrypt(encrypted_data)
                except InvalidToken:
                    decrypted_data = self._migrate_token_file(encrypted_data)

            if decrypted_data is None:
                self._note_retained_copy()
                return {}

            return json.loads(decrypted_data.decode('utf-8'))

        except Exception as e:
            logger.error(f"Failed to load token data: {e}")
            return {}

    def _writer_fernet(self) -> Fernet:
        """The cipher the store is written under.

        A migration that could not keep the previous copy leaves the store on
        the previous derivation, and a save under the new key would be the thing
        that finally takes the rollback away — the runbook's rename needs a file
        a pre-migration agent can read. The migration is retried from the start
        on the next run.
        """
        if self._pre_migration_fernet is not None and not self._retained_file().exists():
            return self._pre_migration_fernet
        return self._fernet

    def _save_data(self, data: dict) -> bool:
        """Encrypt and save token data to file."""
        try:
            self.config_dir.mkdir(parents=True, exist_ok=True)
            logger.debug(f"Saving token data to {self.token_file}")

            json_data = json.dumps(data).encode('utf-8')
            encrypted_data = self._writer_fernet().encrypt(json_data)
            logger.debug(f"Data encrypted, size: {len(encrypted_data)} bytes")

            _write_token_file(self.token_file, encrypted_data)

            logger.debug("Token data saved successfully")
            return True

        except Exception as e:
            logger.error(f"Failed to save token data: {e}")
            import traceback
            logger.error(f"Traceback: {traceback.format_exc()}")
            return False

    def encrypt_value(self, value: str) -> str:
        """Encrypt a value held outside the token store — the Cortex API key in
        config.json — under this machine's key."""
        return self._fernet.encrypt(value.encode('utf-8')).decode('utf-8')

    def decrypt_value(self, value: str) -> tuple[str, bool]:
        """Decrypt a value written by encrypt_value.

        Returns (plaintext, stale): `stale` is True when only the pre-migration
        derivation read it, and its holder should re-encrypt it before a rename
        puts it out of reach. Raises InvalidToken when neither derivation reads
        it.
        """
        data = value.encode('utf-8')
        try:
            return self._fernet.decrypt(data).decode('utf-8'), False
        except InvalidToken:
            return _cipher(_pre_migration_key_material()).decrypt(data).decode('utf-8'), True

    def save_refresh_token(self, token: str) -> bool:
        """
        Save refresh token to secure storage.

        Args:
            token: Refresh token from OAuth exchange

        Returns:
            True if saved successfully, False otherwise
        """
        try:
            data = self._load_data()
            data['refresh_token'] = token
            success = self._save_data(data)

            if success:
                logger.info("Refresh token saved to encrypted file")
            return success

        except Exception as e:
            logger.error(f"Failed to save refresh token: {e}")
            return False

    def get_refresh_token(self) -> Optional[str]:
        """
        Retrieve refresh token from secure storage.

        Returns:
            Refresh token if found, None otherwise
        """
        try:
            data = self._load_data()
            token = data.get('refresh_token')

            if token:
                logger.debug("Refresh token retrieved from encrypted file")
            else:
                logger.debug("No refresh token found in encrypted file")

            return token

        except Exception as e:
            logger.error(f"Failed to retrieve refresh token: {e}")
            return None

    def save_access_token(self, token: str, expiry_timestamp: float) -> bool:
        """
        Save access token and expiry to secure storage (cache).

        Args:
            token: Access token (Firebase custom token)
            expiry_timestamp: Unix timestamp when token expires

        Returns:
            True if saved successfully, False otherwise
        """
        try:
            data = self._load_data()
            data['access_token'] = token
            data['token_expiry'] = expiry_timestamp
            success = self._save_data(data)

            if success:
                logger.debug("Access token cached in encrypted file")
            return success

        except Exception as e:
            logger.error(f"Failed to cache access token: {e}")
            return False

    def get_access_token(self) -> tuple[Optional[str], Optional[float]]:
        """
        Retrieve cached access token and expiry from secure storage.

        Returns:
            Tuple of (access_token, expiry_timestamp). Both None if not found.
        """
        try:
            data = self._load_data()
            token = data.get('access_token')
            expiry = data.get('token_expiry')

            if token and expiry:
                logger.debug("Access token retrieved from cache")
                return (token, float(expiry))
            else:
                logger.debug("No cached access token found")
                return (None, None)

        except Exception as e:
            logger.error(f"Failed to retrieve access token: {e}")
            return (None, None)

    def save_site_id(self, site_id: str) -> bool:
        """
        Save site ID to secure storage.

        Args:
            site_id: Site ID from OAuth exchange

        Returns:
            True if saved successfully, False otherwise
        """
        try:
            data = self._load_data()
            data['site_id'] = site_id
            success = self._save_data(data)

            if success:
                logger.info(f"Site ID saved to encrypted file: {site_id}")
            return success

        except Exception as e:
            logger.error(f"Failed to save site ID: {e}")
            return False

    def get_site_id(self) -> Optional[str]:
        """
        Retrieve site ID from secure storage.

        Returns:
            Site ID if found, None otherwise
        """
        try:
            data = self._load_data()
            site_id = data.get('site_id')

            if site_id:
                logger.debug(f"Site ID retrieved from encrypted file: {site_id}")
            else:
                logger.debug("No site ID found in encrypted file")

            return site_id

        except Exception as e:
            logger.error(f"Failed to retrieve site ID: {e}")
            return None

    def clear_tokens(self) -> bool:
        """
        Clear all stored tokens from secure storage.

        This should be called when:
        - User wants to reconfigure the agent
        - Tokens are revoked by admin
        - Machine is being decommissioned

        Returns:
            True if cleared successfully, False otherwise
        """
        try:
            removed = False
            for path in (
                self.token_file,
                self.token_file.with_name(self.token_file.name + PRE_MIGRATION_SUFFIX),
            ):
                if path.exists():
                    path.unlink()
                    removed = True
            if removed:
                logger.info("All tokens cleared from encrypted file")
            return True

        except Exception as e:
            logger.error(f"Failed to clear tokens: {e}")
            return False

    def has_refresh_token(self) -> bool:
        """
        Check if a refresh token exists in storage.

        Returns:
            True if refresh token exists, False otherwise
        """
        token = self.get_refresh_token()
        return token is not None and len(token) > 0

    def is_configured(self) -> bool:
        """
        Check if agent is configured with valid credentials.

        Returns:
            True if both refresh token and site ID are stored, False otherwise
        """
        has_token = self.has_refresh_token()
        has_site = self.get_site_id() is not None
        return has_token and has_site


_storage_instance = None


def get_storage() -> SecureStorage:
    """
    Get singleton SecureStorage instance.

    Returns:
        SecureStorage instance
    """
    global _storage_instance
    if _storage_instance is None:
        _storage_instance = SecureStorage()
    return _storage_instance

"""
Secure Token Storage for Owlette Agent

This module provides secure storage for OAuth tokens using encrypted files.
Tokens are encrypted with a machine-specific key and stored in config directory.

Security Features:
- Tokens encrypted using Fernet symmetric encryption
- Encryption key derived from machine UUID (machine-specific)
- Stored in a hidden file that every save creates anew, carrying a protected
  DACL set before its first byte, and puts in place with one atomic replace
- Automatic cleanup of expired tokens

Usage:
    storage = SecureStorage()
    storage.save_refresh_token("abc123...")
    token = storage.get_refresh_token()
    storage.clear_tokens()  # Remove all stored tokens
"""

import os
import glob
import json
import logging
import secrets
import stat
from pathlib import Path
from typing import Optional
from cryptography.fernet import Fernet
import base64
import hashlib
import acl_hardening
import shared_utils

logger = logging.getLogger(__name__)

TOKEN_FILE_NAME = ".tokens.enc"  # Hidden file in config directory

FILE_ATTRIBUTE_HIDDEN = 0x02
FILE_ATTRIBUTE_ARCHIVE = 0x20


def _writer_user_sid():
    """This process's account SID, or None when the process runs as SYSTEM or
    its token cannot be read."""
    try:
        import win32api
        import win32security
        token = win32security.OpenProcessToken(
            win32api.GetCurrentProcess(), win32security.TOKEN_QUERY
        )
        try:
            sid = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
        finally:
            token.Close()
        if win32security.ConvertSidToStringSid(sid) == 'S-1-5-18':
            return None
        return sid
    except Exception as e:
        logger.debug(f"Could not read this process's account SID: {e}")
        return None


def _token_file_spec() -> list:
    """The token file's DACL: SYSTEM and Administrators full control, and
    modify for the writing account when that is a user, otherwise for the
    active console user, or for no one when there is none.

    The ACEs come from the ``.tokens.enc`` entry of ``acl_hardening.SPECS``, the
    table the service's start-up repair uses. A user writer grants itself
    because pairing saves three times in a row and, from an RDP session, finds
    no console user: granting anyone else would lock it out after the first
    save. That never exceeds what the writer could grant itself, since setting
    a DACL needs WRITE_DAC on the file.

    Raises ``AclApplyError`` when the table holds no entry for the token file,
    so a save that has no DACL to write writes nothing.
    """
    template = next(
        (entry.aces for entry in acl_hardening.SPECS
         if os.path.basename(entry.path) == TOKEN_FILE_NAME),
        None,
    )
    if template is None:
        raise acl_hardening.AclApplyError(
            f"the hardening table holds no {TOKEN_FILE_NAME} entry"
        )
    grantee = _writer_user_sid()
    if grantee is None:
        grantee = acl_hardening.console_user_sid()
    if grantee is None:
        logger.debug(
            "No console user session: the token file DACL is SYSTEM and "
            "Administrators only until the service adds the console user at "
            "its next start"
        )
    return acl_hardening._resolve_spec(template, grantee)


def _set_token_attributes(path: str) -> None:
    """Give ``path`` the attributes the token file carries: hidden, and archive
    so a backup still sees it change.

    Set before the replace, because a rename gives the new file the attributes
    of the file being renamed, not of the one it lands on. Non-fatal: the DACL
    is what limits the store to the principals in its spec, and a save that
    reached this point has already written a file carrying it.
    """
    import ctypes
    if not ctypes.windll.kernel32.SetFileAttributesW(
        str(path), FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_ARCHIVE,
    ):
        logger.warning(
            f"Could not set the token file's attributes: {ctypes.WinError()}"
        )


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
            # ProgramData: reachable by both regular users and SYSTEM.
            program_data = os.environ.get('PROGRAMDATA', 'C:\\ProgramData')
            config_dir = Path(program_data) / "Owlette"

        self.config_dir = Path(config_dir)
        self.token_file = self.config_dir / TOKEN_FILE_NAME
        self._fernet = self._get_cipher()
        logger.debug(f"SecureStorage initialized: {self.token_file}")

    def _get_cipher(self) -> Fernet:
        """Get Fernet cipher with machine-specific key."""
        try:
            import platform

            # MachineGuid is stable across reboots and user contexts, unlike
            # uuid.getnode(), whose MAC changes with adapter enumeration order.
            machine_id = self._get_machine_guid()
            hostname = platform.node()

            key_material = f"{machine_id}:{hostname}:owlette-agent".encode()
            key_hash = hashlib.sha256(key_material).digest()
            key = base64.urlsafe_b64encode(key_hash)

            return Fernet(key)
        except Exception as e:
            logger.error(f"Failed to generate encryption key: {e}")
            raise

    def _get_machine_guid(self) -> str:
        """
        Get Windows MachineGuid from registry.

        This is a stable identifier that:
        - Doesn't change after reboots
        - Is accessible to both regular users and SYSTEM account
        - Is unique per Windows installation

        Falls back to uuid.getnode() if registry read fails.
        """
        try:
            import winreg
            key = winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"SOFTWARE\Microsoft\Cryptography"
            )
            machine_guid = winreg.QueryValueEx(key, "MachineGuid")[0]
            winreg.CloseKey(key)

            if machine_guid:
                logger.debug(f"Using Windows MachineGuid for encryption key")
                return machine_guid
        except Exception as e:
            logger.warning(f"Failed to read MachineGuid from registry: {e}")

        # Non-Windows fallback; less stable.
        import uuid
        logger.warning("Falling back to uuid.getnode() for encryption key")
        return str(uuid.getnode())

    def _new_temp_file(self) -> str:
        """A name for the file a save writes before it replaces the store.

        Random per save, so the name a save is about to create is not one
        anything could be holding already.
        """
        return f"{self.token_file}.{secrets.token_hex(4)}.tmp"

    def _leftover_temp_files(self) -> list:
        """The temp files saves have left behind, by the shape of their names."""
        return glob.glob(glob.escape(str(self.token_file)) + '.*.tmp')

    def _is_plain_token_file(self) -> bool:
        """True when the token path holds a plain file.

        A directory, or a symlink or junction standing in for the file, is not
        followed and not opened: the path is read as holding no store. The type
        comes from ``os.lstat``, which reports the path itself.
        """
        try:
            st = os.lstat(self.token_file)
        except (FileNotFoundError, NotADirectoryError):
            return False
        except OSError as e:
            logger.warning(f"Could not read the token file's type: {e}")
            return False

        reparse = getattr(st, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
        if stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode) or reparse:
            logger.warning(
                f"{self.token_file} is not a plain file; reading no stored tokens"
            )
            return False
        return True

    def _load_data(self) -> dict:
        """Load and decrypt token data from file."""
        if not self._is_plain_token_file():
            return {}

        try:
            with open(self.token_file, 'rb') as f:
                encrypted_data = f.read()

            if not encrypted_data:
                return {}

            decrypted_data = self._fernet.decrypt(encrypted_data)
            return json.loads(decrypted_data.decode('utf-8'))

        except Exception as e:
            logger.error(f"Failed to load token data: {e}")
            return {}

    def _save_data(self, data: dict) -> bool:
        """Encrypt and save token data to file."""
        try:
            self.config_dir.mkdir(parents=True, exist_ok=True)
            logger.debug(f"Saving token data to {self.token_file}")

            json_data = json.dumps(data).encode('utf-8')
            encrypted_data = self._fernet.encrypt(json_data)
            logger.debug(f"Data encrypted, size: {len(encrypted_data)} bytes")

            if os.name == 'nt':
                self._replace_token_file(encrypted_data)
            else:
                with open(self.token_file, 'wb') as f:
                    f.write(encrypted_data)

            logger.debug("Token data saved successfully")
            return True

        except Exception as e:
            logger.error(f"Failed to save token data: {e}")
            logger.debug("Token save failed", exc_info=True)
            return False

    def _replace_token_file(self, payload: bytes) -> None:
        """Write ``payload`` to a file this call creates, then make that file
        the token store.

        The bytes only ever land in a file created by this call through
        ``shared_utils``' protected writer: created new, under a name of this
        save's own, in the store's own directory, so the file is never one
        something else made; its DACL (``_token_file_spec``) set on the creating
        handle before the first byte; and nothing shared while that handle is
        open. ``os.replace`` then makes it the store in one step, carrying its
        attributes and its DACL, so a reader sees either the previous store or
        this one. A failure to create the file or to set its DACL raises with
        the temp file removed and the previous store untouched.
        """
        spec = _token_file_spec()
        temp_path = self._new_temp_file()

        try:
            shared_utils._write_new_file_with_dacl(
                temp_path, payload, spec, dacl_first=True,
            )
            _set_token_attributes(temp_path)
            os.replace(temp_path, self.token_file)
        except Exception:
            try:
                os.remove(temp_path)
            except OSError:
                pass
            raise

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
            if self.token_file.exists():
                self.token_file.unlink()
                logger.info("All tokens cleared from encrypted file")
            # a save stopped between its write and its replace leaves its temp
            # file behind; clearing the store clears those copies of it too.
            for leftover in self._leftover_temp_files():
                os.remove(leftover)
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

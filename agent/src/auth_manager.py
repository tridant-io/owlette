"""
Authentication Manager for Owlette Agent.

Registration-code exchange, access-token lifecycle (cache / expiry / auto-refresh), and
encrypted token storage.

Two tokens: a 1-hour Firebase custom access token for Firestore REST calls, and a
long-lived (30d) refresh token. Tokens are never logged, not even at DEBUG. Storage is
machine-key encrypted at C:\\ProgramData\\Owlette\\.tokens.enc.
"""

import base64
import requests
import time
import logging
import json
import threading
from typing import Optional, Dict, Any, Callable

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from secure_storage import SecureStorage, get_storage
import shared_utils

logger = logging.getLogger(__name__)

TOKEN_REFRESH_BUFFER_SECONDS = 5 * 60

# Transport-level failures (no HTTP response at all) retry on this fixed cadence instead
# of escalating the exponential ladder reserved for HTTP error responses.
TOKEN_REFRESH_NETWORK_RETRY_SECONDS = 10

# Wrap version emitted by web/lib/deviceCodeCrypto.ts. Bump in lockstep
# if the crypto parameters ever change.
DEVICE_CODE_WRAP_VERSION = 'v1'
_DEVICE_CODE_HKDF_INFO = b'owlette-device-code-v1'
_DEVICE_CODE_KEY_LENGTH = 32  # AES-256
_DEVICE_CODE_IV_LENGTH = 12   # AES-GCM standard nonce
_DEVICE_CODE_TAG_LENGTH = 16  # AES-GCM authentication tag


def _derive_device_code_key(device_code: str, doc_id: str) -> bytes:
    """
    Per-document AES-256 key for unwrapping a device-code credential bundle.

    Must match `deriveDeviceCodeKey` in web/lib/deviceCodeCrypto.ts: HKDF-SHA256, IKM =
    deviceCode, salt = pair phrase (doc id), info = 'owlette-device-code-v1'.
    """
    if not device_code:
        raise AuthenticationError('device code required for credential decryption')
    if not doc_id:
        raise AuthenticationError('doc id required for credential decryption')
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=_DEVICE_CODE_KEY_LENGTH,
        salt=doc_id.encode('utf-8'),
        info=_DEVICE_CODE_HKDF_INFO,
    )
    return hkdf.derive(device_code.encode('utf-8'))


def _decrypt_device_code_credentials(
    encrypted_blob: str,
    device_code: str,
    doc_id: str,
) -> Dict[str, Any]:
    """
    Decrypt a v1 device-code `encryptedCredentials` blob: base64(iv || authTag || ciphertext).

    HKDF inputs are pinned to web/lib/deviceCodeCrypto.ts; a wrong device code or tampered
    ciphertext raises InvalidTag, rewrapped as AuthenticationError.
    """
    try:
        raw = base64.b64decode(encrypted_blob, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise AuthenticationError(f'malformed encrypted credentials: {exc}')

    minimum = _DEVICE_CODE_IV_LENGTH + _DEVICE_CODE_TAG_LENGTH + 1
    if len(raw) < minimum:
        raise AuthenticationError('encrypted credentials blob too short')

    iv = raw[:_DEVICE_CODE_IV_LENGTH]
    auth_tag = raw[_DEVICE_CODE_IV_LENGTH:_DEVICE_CODE_IV_LENGTH + _DEVICE_CODE_TAG_LENGTH]
    ciphertext = raw[_DEVICE_CODE_IV_LENGTH + _DEVICE_CODE_TAG_LENGTH:]

    key = _derive_device_code_key(device_code, doc_id)
    aesgcm = AESGCM(key)
    # AESGCM.decrypt expects ciphertext || tag concatenated.
    try:
        plaintext = aesgcm.decrypt(iv, ciphertext + auth_tag, None)
    except Exception as exc:  # InvalidTag and friends
        raise AuthenticationError(f'failed to decrypt credentials: {exc}')

    try:
        return json.loads(plaintext.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AuthenticationError(f'decrypted credentials are not valid json: {exc}')


class AuthenticationError(Exception):
    """Raised when authentication fails."""
    pass


class TokenRefreshError(Exception):
    """Raised when token refresh fails."""
    pass


class TokenRefreshNetworkError(TokenRefreshError):
    """
    Refresh failed at the transport layer — no HTTP response (unreachable host, DNS,
    connect/read timeout).

    Subclasses TokenRefreshError so existing handlers still catch it; retry schedulers use
    TOKEN_REFRESH_NETWORK_RETRY_SECONDS instead of doubling the server-error backoff.
    """
    pass


class AuthManager:
    """
    Token exchange, refresh, and encrypted storage in
    C:\\ProgramData\\Owlette\\.tokens.enc (SYSTEM-readable).
    """

    def __init__(
        self,
        api_base: Optional[str] = None,
        machine_id: Optional[str] = None,
        storage: Optional[SecureStorage] = None,
    ):
        """api_base must be an owlette API base; machine_id defaults to the hostname, storage to the singleton."""
        if not api_base:
            raise ValueError("api_base is required for AuthManager initialization")
        self.api_base = api_base.rstrip('/')
        # every token request goes to api_base
        if not shared_utils.is_owlette_api_base(self.api_base):
            raise ValueError(f"api_base {self.api_base!r} is not an owlette API base")
        self.machine_id = machine_id or shared_utils.get_hostname()
        self.storage = storage or get_storage()

        self._access_token: Optional[str] = None
        self._token_expiry: Optional[float] = None
        self._site_id: Optional[str] = None

        self._last_refresh_attempt: Optional[float] = None
        self._refresh_backoff_seconds: float = 60  # Start with 1 minute
        self._max_backoff_seconds: float = 300  # Max 5 minutes
        self._consecutive_failures: int = 0  # Track consecutive HTTP-error failures
        self._backoff_logged: bool = False  # Track if we've logged backoff message
        self._last_failure_was_network: bool = False  # Last failure was transport-level

        # Serialises refresh across threads.
        self._refresh_lock = threading.Lock()

        self._load_cached_tokens()

        logger.debug(f"AuthManager initialized: machine={self.machine_id}, api={self.api_base}")

    def _load_cached_tokens(self):
        """Load cached access token and site ID from secure storage."""
        try:
            access_token, expiry = self.storage.get_access_token()
            if access_token and expiry:
                self._access_token = access_token
                self._token_expiry = expiry
                logger.debug("Cached access token loaded")

            site_id = self.storage.get_site_id()
            if site_id:
                self._site_id = site_id
                logger.debug(f"Site ID loaded: {site_id}")

        except Exception as e:
            logger.warning(f"Failed to load cached tokens: {e}")

    def _persist_credentials(self, access_token: Optional[str], refresh_token: Optional[str],
                             expires_in: float, site_id: Optional[str]) -> None:
        """Validate a token triple, write it to encrypted storage, and cache it on self."""
        if not access_token or not refresh_token or not site_id:
            raise AuthenticationError("Invalid response from server (missing tokens)")

        expiry_timestamp = time.time() + expires_in

        success_refresh = self.storage.save_refresh_token(refresh_token)
        success_access = self.storage.save_access_token(access_token, expiry_timestamp)
        success_site = self.storage.save_site_id(site_id)

        if not success_refresh or not success_access or not success_site:
            raise AuthenticationError("Failed to save tokens to encrypted file")

        self._access_token = access_token
        self._token_expiry = expiry_timestamp
        self._site_id = site_id

    def exchange_registration_code(self, registration_code: str, machine_id: Optional[str] = None) -> bool:
        """
        Exchange the installer's single-use registration code for access + refresh tokens.

        Raises AuthenticationError on failure.
        """
        machine_id = machine_id or self.machine_id

        try:
            logger.info("Exchanging registration code for tokens...")

            url = f"{self.api_base}/agent/auth/exchange"
            logger.debug(f"Exchange URL: {url}")
            logger.debug(f"Machine ID: {machine_id}")

            from pathlib import Path
            import shared_utils
            debug_log = Path(shared_utils.get_data_path('logs/oauth_debug.log'))
            with open(debug_log, 'a') as f:
                f.write(f"Calling URL: {url}\n")

            response = requests.post(
                url,
                json={
                    'registrationCode': registration_code,
                    'machineId': machine_id,
                    'version': shared_utils.APP_VERSION,
                },
                timeout=30,
            )
            logger.debug(f"Exchange response status: {response.status_code}")

            # Log response to debug file (omit body — may contain tokens)
            with open(debug_log, 'a') as f:
                f.write(f"Response Status: {response.status_code}\n")
                f.write(f"Response Headers: {dict(response.headers)}\n\n")

            if response.status_code != 200:
                try:
                    error_msg = response.json().get('error', 'Unknown error')
                except (ValueError, json.JSONDecodeError):
                    error_msg = f"HTTP {response.status_code}: {response.text[:200]}"
                logger.error(f"Token exchange failed: {error_msg}")
                raise AuthenticationError(f"Token exchange failed: {error_msg}")

            try:
                data = response.json()
            except (ValueError, json.JSONDecodeError) as e:
                logger.error(f"Invalid JSON response from server: {response.text[:200]}")
                raise AuthenticationError(f"Invalid JSON response from server: {e}")

            access_token = data.get('accessToken')
            refresh_token = data.get('refreshToken')
            expires_in = data.get('expiresIn', 3600)
            site_id = data.get('siteId')

            self._persist_credentials(access_token, refresh_token, expires_in, site_id)

            # Never log the tokens themselves.
            logger.info(
                f"Authentication successful: site={site_id}, " +
                f"token_expires_in={expires_in}s"
            )

            return True

        except requests.exceptions.RequestException as e:
            logger.error(f"Network error during token exchange: {e}")
            raise AuthenticationError(f"Network error: {e}")
        except Exception as e:
            logger.error(f"Unexpected error during token exchange: {e}")
            raise AuthenticationError(f"Unexpected error: {e}")

    def request_device_code(self) -> dict:
        """
        Request a new device code (pairing phrase).

        Returns: pairPhrase, deviceCode, verificationUri, pairingUrl, expiresIn, interval.
        Raises AuthenticationError on failure.
        """
        try:
            url = f"{self.api_base}/agent/auth/device-code"
            response = requests.post(
                url,
                json={
                    'machineId': self.machine_id,
                    'version': shared_utils.APP_VERSION,
                },
                timeout=30,
            )

            if response.status_code != 200:
                try:
                    error_msg = response.json().get('error', 'Unknown error')
                except (ValueError, json.JSONDecodeError):
                    error_msg = f"HTTP {response.status_code}: {response.text[:200]}"
                raise AuthenticationError(f"Device code request failed: {error_msg}")

            return response.json()

        except requests.exceptions.RequestException as e:
            raise AuthenticationError(f"Network error requesting device code: {e}")

    def poll_device_code(self, device_code: str, interval: int = 5, timeout: int = 600,
                         should_cancel: Optional[Callable[[], bool]] = None) -> bool:
        """
        Poll the server for device code authorization.

        Blocks until authorized, expired, cancelled, or timed out. Called from
        configure_site.py and the GUI Join Site flow.

        `should_cancel` is polled in small slices between attempts so a Cancel button
        aborts promptly instead of waiting out `timeout`; returns False when it fires.
        Returns True once tokens are stored. Raises AuthenticationError on failure/expiry.
        """
        url = f"{self.api_base}/agent/auth/device-code/poll"
        start_time = time.time()

        def _cancelled() -> bool:
            return bool(should_cancel and should_cancel())

        def _wait(seconds: float) -> None:
            # Slice the sleep so a cancel is honored within ~0.25s, not a whole interval.
            deadline = time.time() + seconds
            while True:
                remaining = deadline - time.time()
                if remaining <= 0 or _cancelled():
                    return
                time.sleep(min(0.25, remaining))

        while time.time() - start_time < timeout:
            if _cancelled():
                logger.info("Device code polling cancelled by caller")
                return False
            try:
                response = requests.post(
                    url,
                    json={'deviceCode': device_code},
                    timeout=15,
                )

                if response.status_code == 202:
                    _wait(interval)
                    continue

                if response.status_code == 200:
                    # Two accepted shapes: v1 { wrapVersion, encryptedCredentials, phrase }
                    # (preferred — no plaintext on the wire), and the legacy plaintext
                    # { accessToken, refreshToken, expiresIn, siteId }, kept so codes
                    # authorised before the deploy still resolve.
                    data = response.json()

                    if data.get('wrapVersion') == DEVICE_CODE_WRAP_VERSION:
                        encrypted_blob = data.get('encryptedCredentials')
                        phrase = data.get('phrase')
                        if not encrypted_blob or not phrase:
                            raise AuthenticationError(
                                'Invalid v1 response (missing encryptedCredentials or phrase)'
                            )
                        bundle = _decrypt_device_code_credentials(
                            encrypted_blob, device_code, phrase
                        )
                        access_token = bundle.get('accessToken')
                        refresh_token = bundle.get('refreshToken')
                        expires_in = bundle.get('expiresIn', 3600)
                        site_id = bundle.get('siteId')
                    else:
                        access_token = data.get('accessToken')
                        refresh_token = data.get('refreshToken')
                        expires_in = data.get('expiresIn', 3600)
                        site_id = data.get('siteId')

                    self._persist_credentials(access_token, refresh_token, expires_in, site_id)

                    logger.info(f"Device code authorized: site={site_id}")
                    return True

                if response.status_code == 410:
                    raise AuthenticationError("Pairing phrase expired. Please try again.")

                try:
                    error_msg = response.json().get('error', 'Unknown error')
                except (ValueError, json.JSONDecodeError):
                    error_msg = f"HTTP {response.status_code}"
                raise AuthenticationError(f"Device code poll failed: {error_msg}")

            except requests.exceptions.RequestException as e:
                logger.warning(f"Network error during poll (retrying): {e}")
                _wait(interval)
                continue

        raise AuthenticationError("Timed out waiting for authorization")

    def refresh_access_token(self) -> bool:
        """
        Mint a new access token from the stored refresh token. Custom tokens last 1 hour;
        get_valid_token() calls this automatically. Raises TokenRefreshError on failure.
        """
        try:
            logger.debug("Refreshing access token...")

            refresh_token = self.storage.get_refresh_token()
            if not refresh_token:
                raise TokenRefreshError("No refresh token found in storage")

            url = f"{self.api_base}/agent/auth/refresh"
            response = requests.post(
                url,
                json={
                    'refreshToken': refresh_token,
                    'machineId': self.machine_id,
                },
                headers={
                    'User-Agent': f'Owlette-Agent/{shared_utils.APP_VERSION} (Windows; {self.machine_id})',
                    'X-Owlette-Agent-Version': shared_utils.APP_VERSION,
                    'Content-Type': 'application/json',
                },
                timeout=30,
            )

            if response.status_code != 200:
                self._consecutive_failures += 1

                try:
                    error_msg = response.json().get('error', 'Unknown error')
                except (ValueError, json.JSONDecodeError):
                    error_msg = f"HTTP {response.status_code}: {response.text[:200]}"

                if response.status_code in [401, 403]:
                    error_type = "Authentication failed (invalid/expired tokens)"
                    logger.warning("Refresh token invalid/expired, clearing storage")
                    self.storage.clear_tokens()
                elif response.status_code == 429:
                    error_type = "Rate limited by server"
                elif response.status_code == 500:
                    # 3+ consecutive 500s usually means Cloudflare is blocking us.
                    if self._consecutive_failures >= 3:
                        error_type = "Server error (likely Cloudflare rate limiting/blocking)"
                    else:
                        error_type = "Server error (transient)"
                else:
                    error_type = f"HTTP {response.status_code}"

                logger.error(f"Token refresh failed: {error_type} - {error_msg}")
                raise TokenRefreshError(f"Token refresh failed: {error_msg}")

            try:
                data = response.json()
            except (ValueError, json.JSONDecodeError) as e:
                logger.error(f"Invalid JSON response from server: {response.text[:200]}")
                raise TokenRefreshError(f"Invalid JSON response from server: {e}")
            access_token = data.get('accessToken')
            expires_in = data.get('expiresIn', 3600)
            # The server rotates the refresh token on every refresh, with a 5-minute grace
            # window on the old one. Persist the new token or we lose auth ~5 min after the
            # first rotation. Optional field: older servers don't rotate.
            new_refresh_token = data.get('refreshToken')

            if not access_token:
                raise TokenRefreshError("Invalid response from server (missing token)")

            expiry_timestamp = time.time() + expires_in

            # Persist the rotated refresh token BEFORE the access token: if the access-token
            # save fails, the next refresh still works off the new token (and the old one is
            # inside its grace window).
            if new_refresh_token:
                save_ok = self.storage.save_refresh_token(new_refresh_token)
                if not save_ok:
                    logger.warning(
                        "Token refresh: server rotated refresh token but persist failed; "
                        "next refresh may fail after grace window expires"
                    )

            self.storage.save_access_token(access_token, expiry_timestamp)

            self._access_token = access_token
            self._token_expiry = expiry_timestamp

            # INFO only on the failure -> success transition; steady state stays at DEBUG.
            was_failing = self._consecutive_failures > 0 or self._last_failure_was_network

            self._consecutive_failures = 0
            self._refresh_backoff_seconds = 60  # Reset backoff to 1 minute
            self._last_failure_was_network = False

            if was_failing:
                logger.info(f"Token refresh recovered after failures, expires_in={expires_in}s")
            else:
                logger.debug(f"Token refreshed successfully, expires_in={expires_in}s")

            return True

        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            # Never reached a server. Routine on cold boot before the NIC has a route, so
            # INFO rather than ERROR, and the caller retries on the fixed short cadence.
            logger.info(f"Token refresh unreachable (transport error, no HTTP response): {e}")
            raise TokenRefreshNetworkError(f"Network error: {e}")
        except requests.exceptions.RequestException as e:
            logger.error(f"Network error during token refresh: {e}")
            raise TokenRefreshError(f"Network error: {e}")
        except TokenRefreshError:
            raise
        except Exception as e:
            logger.error(f"Unexpected error during token refresh: {e}")
            raise TokenRefreshError(f"Unexpected error: {e}")

    def get_valid_token(self) -> str:
        """
        Return a valid access token, refreshing inside the buffer window. Call before every
        Firestore request. Raises AuthenticationError when re-auth is needed,
        TokenRefreshError when the refresh itself fails.
        """
        if not self._access_token or not self._token_expiry:
            self._load_cached_tokens()

        if self._token_expiry:
            time_until_expiry = self._token_expiry - time.time()

            if time_until_expiry <= TOKEN_REFRESH_BUFFER_SECONDS:
                with self._refresh_lock:
                    # Re-check after acquiring lock — another thread may have refreshed
                    time_until_expiry = self._token_expiry - time.time()
                    if time_until_expiry > TOKEN_REFRESH_BUFFER_SECONDS:
                        return self._access_token

                    if self._last_refresh_attempt:
                        time_since_last_attempt = time.time() - self._last_refresh_attempt
                        # Only HTTP error responses escalate the exponential ladder.
                        retry_after = (
                            TOKEN_REFRESH_NETWORK_RETRY_SECONDS
                            if self._last_failure_was_network
                            else self._refresh_backoff_seconds
                        )
                        if time_since_last_attempt < retry_after:
                            # Log once per backoff period, not once per call.
                            retry_in = int(retry_after - time_since_last_attempt)
                            if not self._backoff_logged:
                                if self._last_failure_was_network:
                                    logger.debug(
                                        f"Token refresh waiting for network (retry in {retry_in}s)"
                                    )
                                else:
                                    logger.warning(
                                        f"Token refresh in backoff (waiting {int(retry_after)}s, "
                                        f"{self._consecutive_failures} consecutive failures)"
                                    )
                                self._backoff_logged = True
                            # A near-expiry token beats spamming the server.
                            if self._access_token and time_until_expiry > 0:
                                return self._access_token
                            raise TokenRefreshError(
                                f"Token expired and refresh in backoff period (retry in {retry_in}s)"
                            )

                    # New attempt: re-arm the once-per-backoff log.
                    self._backoff_logged = False
                    logger.debug(
                        f"Token expires in {int(time_until_expiry)}s (< {TOKEN_REFRESH_BUFFER_SECONDS}s buffer), triggering refresh..."
                    )
                    try:
                        self._last_refresh_attempt = time.time()
                        self.refresh_access_token()
                        logger.debug("Token refresh completed successfully")
                    except TokenRefreshError as e:
                        if isinstance(e, TokenRefreshNetworkError):
                            # No HTTP response: fixed short cadence, server ladder untouched.
                            self._last_failure_was_network = True
                            logger.info(
                                "Token refresh failed: transport error (no HTTP response), "
                                f"retrying in {int(TOKEN_REFRESH_NETWORK_RETRY_SECONDS)}s "
                                f"(server backoff held at {int(self._refresh_backoff_seconds)}s)"
                            )
                        else:
                            # Server answered with an error: double the backoff.
                            self._last_failure_was_network = False
                            self._refresh_backoff_seconds = min(
                                self._refresh_backoff_seconds * 2,
                                self._max_backoff_seconds
                            )
                            logger.error(
                                f"Token refresh failed: server error, increasing backoff to "
                                f"{int(self._refresh_backoff_seconds)}s "
                                f"({self._consecutive_failures} consecutive failures)"
                            )
                        # Still-valid token beats failing the caller.
                        if self._access_token and time_until_expiry > 0:
                            logger.warning("Using expiring token due to refresh failure")
                            return self._access_token
                        raise

        if not self._access_token:
            raise AuthenticationError(
                "No valid access token available. Please re-authenticate."
            )

        return self._access_token

    def is_authenticated(self) -> bool:
        """True when a refresh token exists in storage."""
        return self.storage.has_refresh_token()

    def get_site_id(self) -> Optional[str]:
        """Site ID this agent is authorized for, or None."""
        if not self._site_id:
            self._site_id = self.storage.get_site_id()
        return self._site_id

    def get_token_info(self) -> Dict[str, Any]:
        """Current token state, for debugging/monitoring."""
        if self._token_expiry:
            time_until_expiry = max(0, self._token_expiry - time.time())
            is_expired = time_until_expiry <= 0
        else:
            time_until_expiry = None
            is_expired = True

        return {
            'has_access_token': self._access_token is not None,
            'has_refresh_token': self.storage.has_refresh_token(),
            'is_expired': is_expired,
            'time_until_expiry_seconds': int(time_until_expiry) if time_until_expiry else None,
            'site_id': self._site_id,
            'machine_id': self.machine_id,
            'api_base': self.api_base,
        }


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )

    auth = AuthManager(api_base="https://dev.owlette.app/api")

    registration_code = "test_code_12345"  # normally supplied by the installer
    try:
        auth.exchange_registration_code(registration_code)
        print("Authentication successful!")
    except AuthenticationError as e:
        print(f"Authentication failed: {e}")

    try:
        token = auth.get_valid_token()
        print("Got valid token successfully")
    except (AuthenticationError, TokenRefreshError) as e:
        print(f"Failed to get token: {e}")

    info = auth.get_token_info()
    print(f"Token info: {info}")

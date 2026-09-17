"""
Firestore REST API v1 client for the Owlette agent — the Admin SDK is never used
here (custom-token auth, not service-account credentials).

Unlike the Admin SDK this client is SUBJECT TO Firestore security rules; every
operation is scoped to the authenticated user's permissions.

https://firebase.google.com/docs/firestore/reference/rest
"""

import hashlib
import os
import requests
import json
import re
import time
import threading
import logging
from typing import Dict, Any, Optional, Callable, List
from datetime import datetime
from urllib.parse import quote

logger = logging.getLogger(__name__)

# Firestore REST API base URL
FIRESTORE_API_BASE = "https://firestore.googleapis.com/v1"


def resolve_api_base() -> str:
    """The Firestore REST root this process talks to.

    Production is always {@link FIRESTORE_API_BASE}. When FIRESTORE_EMULATOR_HOST
    is set — the variable the Firebase CLI exports for every other SDK, and which
    no installed agent ever has — the same /v1 surface is served over plain HTTP
    by the local emulator, so point at that instead. Document paths, request
    bodies and ID-token auth are identical; only the origin changes.

    Read per call rather than captured at import so a test can set the variable
    without reloading the module.
    """
    host = (os.environ.get('FIRESTORE_EMULATOR_HOST') or '').strip()
    if not host:
        return FIRESTORE_API_BASE
    # The emulator advertises itself bare ("127.0.0.1:8080"); tolerate a scheme
    # having been included anyway rather than emitting "http://http://…".
    if host.startswith('http://') or host.startswith('https://'):
        return f"{host.rstrip('/')}/v1"
    return f"http://{host}/v1"

# Special value for server timestamp
SERVER_TIMESTAMP = "SERVER_TIMESTAMP"

# Per-request HTTP timeout. Generous by default because the agent runs on links
# that stall; see set_request_timeout() for the shutdown path, which cannot
# afford it.
DEFAULT_REQUEST_TIMEOUT = 30

def timestamp_to_ms(value) -> int:
    """Convert a Firestore timestamp value to epoch milliseconds.

    Handles all formats returned by the REST API or written by web clients:
      - int/float: assumed to be epoch milliseconds already
      - ISO 8601 string: parsed to epoch ms (Firestore REST returns this for Timestamp fields)
      - None or unrecognised: returns 0
    """
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            # Firestore returns e.g. 2026-04-02T14:30:00.123456Z — strip Z, parse UTC.
            cleaned = value.rstrip('Z')
            dt = datetime.fromisoformat(cleaned)
            return int(dt.timestamp() * 1000)
        except (ValueError, OSError):
            return 0
    return 0


# Special sentinel value for deleting fields (compatible with firebase_admin SDK)
class _DeleteFieldSentinel:
    """Sentinel class to mark fields for deletion (matches firebase_admin.firestore.DELETE_FIELD)"""
    def __repr__(self):
        return "DELETE_FIELD"

DELETE_FIELD = _DeleteFieldSentinel()


class FirestoreRestClient:
    """
    Firestore REST API client using custom token authentication.

    This client provides methods for CRUD operations, real-time listeners,
    and batch writes - matching the interface of firebase_admin SDK.
    """

    def __init__(self, project_id: str, auth_manager):
        """Initialize the client for `project_id` (e.g. "owlette-dev-3838a")."""
        self.project_id = project_id
        self.auth_manager = auth_manager
        # Resolved once, here, and used by EVERY request path — the ":commit" and
        # ":batchWrite" endpoints append to base_url rather than re-deriving from
        # the module constant, so there is exactly one seam to redirect.
        self.api_base = resolve_api_base()
        self.base_url = f"{self.api_base}/projects/{project_id}/databases/(default)/documents"
        self.request_timeout = DEFAULT_REQUEST_TIMEOUT

        # HTTP session for connection pooling
        self.session = requests.Session()
        self.session.headers.update({
            'Content-Type': 'application/json',
        })

        logger.debug(f"FirestoreRestClient initialized: project={project_id}")

    def set_request_timeout(self, seconds: float):
        """Change the per-request HTTP timeout for every subsequent call.

        Used by the shutdown path, where the OS window is shorter than the
        default timeout and a stalled request costs more than a skipped write.
        """
        self.request_timeout = seconds
        logger.debug(f"Firestore request timeout set to {seconds}s")

    def close(self):
        """Release the Session's pooled sockets. Idempotent; drop the reference
        afterwards and build a new client if one is needed."""
        sess = getattr(self, 'session', None)
        if sess is not None:
            try:
                sess.close()
            except Exception as e:
                logger.debug(f"Session close failed (ignored): {e}")

    def _get_auth_headers(self) -> Dict[str, str]:
        """Authorization header carrying a fresh access token."""
        token = self.auth_manager.get_valid_token()
        return {
            'Authorization': f'Bearer {token}',
        }

    def _to_firestore_value(self, value: Any) -> Dict[str, Any]:
        """Convert a Python value to Firestore REST format.

        e.g. 42 → {'integerValue': '42'}, True → {'booleanValue': True}.
        """
        if value is None:
            return {'nullValue': None}
        elif isinstance(value, _DeleteFieldSentinel):
            return None  # Signal to caller to handle as deletion
        elif value == SERVER_TIMESTAMP:
            # Should have been pulled out by _extract_server_timestamps(); if it
            # reaches here, fall back to client time.
            logger.warning("SERVER_TIMESTAMP not extracted before conversion - using client time as fallback")
            return {'timestampValue': datetime.utcnow().isoformat() + 'Z'}
        elif isinstance(value, bool):
            return {'booleanValue': value}
        elif isinstance(value, int):
            return {'integerValue': str(value)}
        elif isinstance(value, float):
            return {'doubleValue': value}
        elif isinstance(value, str):
            return {'stringValue': value}
        elif isinstance(value, dict):
            fields = {k: self._to_firestore_value(v) for k, v in value.items()}
            return {'mapValue': {'fields': fields}}
        elif isinstance(value, list):
            values = [self._to_firestore_value(item) for item in value]
            return {'arrayValue': {'values': values}}
        elif isinstance(value, datetime):
            return {'timestampValue': value.isoformat() + 'Z'}
        else:
            return {'stringValue': str(value)}

    def _from_firestore_value(self, firestore_value: Dict[str, Any]) -> Any:
        """Convert a Firestore REST value object to a Python value."""
        if 'nullValue' in firestore_value:
            return None
        elif 'booleanValue' in firestore_value:
            return firestore_value['booleanValue']
        elif 'integerValue' in firestore_value:
            return int(firestore_value['integerValue'])
        elif 'doubleValue' in firestore_value:
            return firestore_value['doubleValue']
        elif 'stringValue' in firestore_value:
            return firestore_value['stringValue']
        elif 'timestampValue' in firestore_value:
            return firestore_value['timestampValue']  # ISO 8601 string
        elif 'mapValue' in firestore_value:
            fields = firestore_value['mapValue'].get('fields', {})
            return {k: self._from_firestore_value(v) for k, v in fields.items()}
        elif 'arrayValue' in firestore_value:
            values = firestore_value['arrayValue'].get('values', [])
            return [self._from_firestore_value(item) for item in values]
        else:
            return None

    def _to_firestore_document(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Convert a Python dict into a Firestore document (`{'fields': …}`)."""
        fields = {k: self._to_firestore_value(v) for k, v in data.items()}
        return {'fields': fields}

    def _extract_server_timestamps(self, data: Dict[str, Any], prefix: str = ""):
        """
        Extract SERVER_TIMESTAMP sentinel values from a data dict.

        Returns:
            (cleaned_data, timestamp_field_paths) where cleaned_data has
            SERVER_TIMESTAMP entries removed and timestamp_field_paths is
            a list of escaped dotted field paths for use in fieldTransforms.
        """
        cleaned = {}
        field_paths = []

        for key, value in data.items():
            escaped_key = key if re.match(r'^[a-zA-Z_][a-zA-Z_0-9]*$', key) else f'`{key}`'
            field_path = f"{prefix}.{escaped_key}" if prefix else escaped_key

            if value == SERVER_TIMESTAMP:
                field_paths.append(field_path)
            elif isinstance(value, dict):
                nested_cleaned, nested_paths = self._extract_server_timestamps(value, field_path)
                if nested_cleaned:
                    cleaned[key] = nested_cleaned
                field_paths.extend(nested_paths)
            else:
                cleaned[key] = value

        return cleaned, field_paths

    def _build_field_transforms(self, field_paths: List[str]) -> List[Dict[str, str]]:
        """Build Firestore fieldTransforms for server timestamps."""
        return [
            {'fieldPath': path, 'setToServerValue': 'REQUEST_TIME'}
            for path in field_paths
        ]

    def _flatten_field_paths(self, data: Dict[str, Any], prefix: str = ""):
        """Yield all leaf field paths from a nested dict (for updateMask).
        Field names with special characters are backtick-escaped."""
        for key, value in data.items():
            escaped_key = key if re.match(r'^[a-zA-Z_][a-zA-Z_0-9]*$', key) else f'`{key}`'
            field_path = f"{prefix}.{escaped_key}" if prefix else escaped_key
            if isinstance(value, dict):
                yield from self._flatten_field_paths(value, field_path)
            else:
                yield field_path

    def _commit_write(self, path: str, cleaned_data: Dict[str, Any],
                      field_transforms: List[Dict[str, str]],
                      update_mask_paths: Optional[List[str]] = None):
        """
        Write a document via the :commit endpoint (supports fieldTransforms).

        Used instead of PATCH when SERVER_TIMESTAMP fields are present,
        since PATCH does not support updateTransforms.
        """
        url = f"{self.base_url}:commit"
        doc_name = f"projects/{self.project_id}/databases/(default)/documents/{path}"

        write_entry = {
            'update': {
                'name': doc_name,
                **self._to_firestore_document(cleaned_data)
            },
            'updateTransforms': field_transforms
        }

        if update_mask_paths is not None:
            write_entry['updateMask'] = {'fieldPaths': update_mask_paths}

        response = self.session.post(
            url,
            json={'writes': [write_entry]},
            headers=self._get_auth_headers(),
            timeout=self.request_timeout
        )
        response.raise_for_status()

    def _from_firestore_document(self, firestore_doc: Dict[str, Any]) -> Dict[str, Any]:
        """
        Convert Firestore document to Python dict.

        Args:
            firestore_doc: Firestore document with 'fields' object

        Returns:
            Python dictionary
        """
        if 'fields' not in firestore_doc:
            return {}

        return {k: self._from_firestore_value(v) for k, v in firestore_doc['fields'].items()}

    def get_document(self, path: str, _suppress_logging: bool = False) -> Optional[Dict[str, Any]]:
        """
        Get a Firestore document.

        Args:
            path: Document path (e.g., 'sites/abc/machines/DESKTOP-001')
            _suppress_logging: If True, don't log errors (used by listener loops)

        Returns:
            Document data as dict, or None if not found
        """
        try:
            url = f"{self.base_url}/{path}"
            response = self.session.get(url, headers=self._get_auth_headers(), timeout=self.request_timeout)

            if response.status_code == 404:
                logger.debug(f"Document not found: {path}")
                return None

            response.raise_for_status()
            try:
                doc = response.json()
            except json.JSONDecodeError:
                logger.error(f"Non-JSON response for {path} (status {response.status_code}): {response.text[:200]}")
                raise
            return self._from_firestore_document(doc)

        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 404:
                return None
            if not _suppress_logging:
                logger.error(f"HTTP error getting document {path}: {e}")
            raise
        except Exception as e:
            # Check if this is a connectivity error
            error_str = str(e).lower()
            is_connectivity_error = any(x in error_str for x in [
                'connection', 'network', 'getaddrinfo', 'errno 11001',
                'unreachable', 'timeout', 'refused', 'max retries'
            ])

            if not _suppress_logging and not is_connectivity_error:
                # Only log non-connectivity errors at ERROR level
                logger.error(f"Error getting document {path}: {e}")
            elif not _suppress_logging:
                # Connectivity errors logged at DEBUG level (listener handles logging)
                logger.debug(f"Connectivity error getting document {path}: {type(e).__name__}")
            raise

    def set_document(self, path: str, data: Dict[str, Any], merge: bool = False):
        """
        Write a Firestore document.

        Args:
            path: Document path
            data: Document data as dict
            merge: If True, merge with existing data (default: False)
        """
        try:
            cleaned_data, timestamp_paths = self._extract_server_timestamps(data)

            if timestamp_paths:
                # Use :commit endpoint (supports fieldTransforms for server timestamps)
                field_transforms = self._build_field_transforms(timestamp_paths)

                if merge:
                    # For merge, specify updateMask with all field paths to avoid overwriting
                    all_paths = list(self._flatten_field_paths(cleaned_data)) + timestamp_paths
                    self._commit_write(path, cleaned_data, field_transforms,
                                       update_mask_paths=all_paths)
                else:
                    self._commit_write(path, cleaned_data, field_transforms)
            else:
                # No server timestamps — use PATCH endpoint.
                #
                # CRITICAL: merge=True MUST send an updateMask. Without one,
                # PATCH is a full document replacement and deletes every field
                # not in the payload — set_machine_flag wiped online/
                # lastHeartbeat/metrics on every call, showing as a 5s offline
                # blip until the next _upload_metrics.
                url = f"{self.base_url}/{path}"
                firestore_doc = self._to_firestore_document(cleaned_data)

                params = None
                if merge:
                    # Leaf field paths only — everything else stays untouched.
                    update_mask_paths = list(self._flatten_field_paths(cleaned_data))
                    params = [('updateMask.fieldPaths', p) for p in update_mask_paths]

                response = self.session.patch(
                    url,
                    json=firestore_doc,
                    params=params,
                    headers=self._get_auth_headers(),
                    timeout=self.request_timeout
                )

                response.raise_for_status()

            logger.debug(f"Document written: {path}")

        except Exception as e:
            logger.error(f"Error setting document {path}: {e}")
            raise

    def _escape_field_path(self, field_path: str) -> str:
        """Escape a (possibly dotted) field path for an updateMask: any segment
        with a character outside [a-zA-Z0-9_] must be backtick-quoted."""
        parts = field_path.split('.')
        escaped_parts = []

        for part in parts:
            if re.search(r'[^a-zA-Z0-9_]', part):
                escaped_parts.append(f'`{part}`')
            else:
                escaped_parts.append(part)

        return '.'.join(escaped_parts)

    def update_document(self, path: str, updates: Dict[str, Any]):
        """
        Update specific fields in a document.

        Supports nested field paths like 'metrics.cpu' or 'metrics.processes'.
        Supports DELETE_FIELD to remove fields from documents.

        Args:
            path: Document path
            updates: Fields to update (supports dot notation for nested fields)
        """
        try:
            cleaned_updates, timestamp_paths = self._extract_server_timestamps(updates)

            # Build updateMask from ALL original keys (including timestamp fields)
            update_mask_paths = [self._escape_field_path(key) for key in updates.keys()]

            firestore_fields = {}
            for key, value in cleaned_updates.items():
                firestore_value = self._to_firestore_value(value)

                # None = DELETE_FIELD sentinel: in the updateMask but not in
                # fields, which is what deletes it.
                if firestore_value is None:
                    continue

                if '.' in key:  # nested path, e.g. 'metrics.cpu'
                    parts = key.split('.')
                    current = firestore_fields

                    for i, part in enumerate(parts[:-1]):
                        if part not in current:
                            current[part] = {'mapValue': {'fields': {}}}
                        current = current[part]['mapValue']['fields']

                    current[parts[-1]] = firestore_value
                else:
                    firestore_fields[key] = firestore_value

            if timestamp_paths:
                # Use :commit endpoint (supports fieldTransforms for server timestamps)
                field_transforms = self._build_field_transforms(timestamp_paths)
                url = f"{self.base_url}:commit"
                doc_name = f"projects/{self.project_id}/databases/(default)/documents/{path}"

                write_entry = {
                    'update': {
                        'name': doc_name,
                        'fields': firestore_fields
                    },
                    'updateTransforms': field_transforms,
                    'updateMask': {'fieldPaths': update_mask_paths}
                }

                response = self.session.post(
                    url,
                    json={'writes': [write_entry]},
                    headers=self._get_auth_headers(),
                    timeout=self.request_timeout
                )
            else:
                # No server timestamps — use existing PATCH logic
                url = f"{self.base_url}/{path}"
                params = {
                    'updateMask.fieldPaths': update_mask_paths
                }

                response = self.session.patch(
                    url,
                    json={'fields': firestore_fields},
                    params=params,
                    headers=self._get_auth_headers(),
                    timeout=self.request_timeout
                )

            response.raise_for_status()
            logger.debug(f"Document updated: {path}")

        except Exception as e:
            logger.error(f"Error updating document {path}: {e}")
            raise

    def delete_document(self, path: str):
        """
        Delete a Firestore document.

        Args:
            path: Document path
        """
        try:
            url = f"{self.base_url}/{path}"
            response = self.session.delete(url, headers=self._get_auth_headers(), timeout=self.request_timeout)

            # 404 is OK for delete (already doesn't exist)
            if response.status_code not in [200, 204, 404]:
                response.raise_for_status()

            logger.debug(f"Document deleted: {path}")

        except Exception as e:
            logger.error(f"Error deleting document {path}: {e}")
            raise

    def listen_to_document(
        self,
        path: str,
        callback: Callable[[Optional[Dict[str, Any]]], None],
        min_interval: float = 2.0,
        max_interval: float = 30.0,
        backoff_multiplier: float = 1.5
    ) -> tuple:
        """Watch a document by adaptive polling: min_interval when active,
        backing off by backoff_multiplier toward max_interval when idle
        (all seconds).

        Returns:
            (thread, wake_event, stop_event) — thread already started; set
            wake_event to interrupt the sleep and poll now, stop_event to end it.
        """
        wake_event = threading.Event()
        stop_event = threading.Event()

        def poll_document():
            """Poll document for changes with exponential backoff."""
            # Sentinel, not None: None means "document does not exist".
            _UNINITIALIZED = object()
            last_data = _UNINITIALIZED
            last_hash = None

            current_interval = min_interval

            consecutive_errors = 0
            last_error_type = None

            while not stop_event.is_set():
                try:
                    current_data = self.get_document(path, _suppress_logging=True)

                    if consecutive_errors > 0:
                        logger.info(f"Listener recovered for {path} after {consecutive_errors} errors")
                    consecutive_errors = 0
                    last_error_type = None

                    # Hash, not dict equality: survives key ordering and float noise.
                    if current_data is not None:
                        current_hash = hashlib.md5(json.dumps(current_data, sort_keys=True).encode()).hexdigest()
                    else:
                        current_hash = None

                    if current_hash != last_hash:
                        current_interval = min_interval

                        # No callback on the first run for a document that does
                        # not exist.
                        if last_data is not _UNINITIALIZED or current_data is not None:
                            logger.debug(f"Document changed: {path}")
                            callback(current_data)
                        last_data = current_data
                        last_hash = current_hash
                    else:
                        current_interval = min(current_interval * backoff_multiplier, max_interval)

                    logger.debug(f"Polling {path} - next check in {current_interval:.1f}s")
                    if stop_event.is_set():
                        break
                    if wake_event.wait(current_interval):  # woken externally
                        wake_event.clear()
                        current_interval = min_interval

                except Exception as e:
                    if stop_event.is_set():
                        break
                    consecutive_errors += 1
                    error_type = type(e).__name__

                    error_str = str(e).lower()
                    is_connectivity_error = any(x in error_str for x in [
                        'connection', 'network', 'getaddrinfo', 'errno 11001',
                        'unreachable', 'timeout', 'refused'
                    ])

                    # Log the first error, every 30th after that, and any change
                    # of error type.
                    should_log = (
                        consecutive_errors == 1 or
                        error_type != last_error_type or
                        consecutive_errors % 30 == 0
                    )

                    if should_log:
                        if is_connectivity_error:
                            if consecutive_errors == 1:
                                logger.warning(f"Listener lost connectivity for {path}: {error_type}")
                            else:
                                logger.debug(f"Listener still offline for {path} ({consecutive_errors} errors)")
                        else:
                            logger.error(f"Error in document listener for {path}: {e}")

                    last_error_type = error_type

                    # Interruptible via stop_event.
                    error_backoff = min(5 * (1 + consecutive_errors // 10), 60)  # 5s to 60s max
                    stop_event.wait(error_backoff)
                    current_interval = min_interval  # Reset interval after error

            logger.debug(f"Listener stopped for document: {path}")

        thread = threading.Thread(target=poll_document, daemon=True)
        thread.start()
        logger.debug(f"Started listener for document: {path}")
        return thread, wake_event, stop_event

    def batch_write(self, writes: List[Dict[str, Any]]):
        """
        Perform batch write operation.

        Args:
            writes: List of write operations, each with:
                - operation: 'set', 'update', or 'delete'
                - path: Document path
                - data: Document data (for set/update)

        Example:
            client.batch_write([
                {'operation': 'set', 'path': 'logs/log1', 'data': {'msg': 'test'}},
                {'operation': 'delete', 'path': 'logs/log2'},
            ])
        """
        try:
            url = f"{self.base_url}:batchWrite"

            batch_writes = []

            for write in writes:
                operation = write.get('operation')
                path = write.get('path')
                data = write.get('data', {})

                doc_name = f"projects/{self.project_id}/databases/(default)/documents/{path}"

                if operation == 'set':
                    cleaned_data, timestamp_paths = self._extract_server_timestamps(data)
                    write_entry = {
                        'update': {
                            'name': doc_name,
                            **self._to_firestore_document(cleaned_data)
                        }
                    }
                    if timestamp_paths:
                        write_entry['updateTransforms'] = self._build_field_transforms(timestamp_paths)
                    batch_writes.append(write_entry)
                elif operation == 'delete':
                    batch_writes.append({
                        'delete': doc_name
                    })
                elif operation == 'update':
                    cleaned_data, timestamp_paths = self._extract_server_timestamps(data)
                    write_entry = {
                        'update': {
                            'name': doc_name,
                            **self._to_firestore_document(cleaned_data)
                        },
                        'updateMask': {
                            'fieldPaths': list(data.keys())
                        }
                    }
                    if timestamp_paths:
                        write_entry['updateTransforms'] = self._build_field_transforms(timestamp_paths)
                    batch_writes.append(write_entry)

            response = self.session.post(
                url,
                json={'writes': batch_writes},
                headers=self._get_auth_headers(),
                timeout=self.request_timeout
            )

            response.raise_for_status()
            logger.debug(f"Batch write completed: {len(writes)} operations")

        except Exception as e:
            is_403 = hasattr(e, 'response') and e.response is not None and e.response.status_code == 403

            if is_403:
                logger.debug(f"Batch write forbidden (expected with OAuth tokens): {e}")
                if hasattr(e, 'response'):
                    try:
                        error_details = e.response.json()
                        logger.debug(f"Firestore error details: {error_details}")
                    except (json.JSONDecodeError, ValueError):
                        pass
            else:
                logger.error(f"Error in batch write: {e}")
                if hasattr(e, 'response') and e.response is not None:
                    try:
                        error_details = e.response.json()
                        logger.error(f"Firestore error details: {error_details}")
                    except (json.JSONDecodeError, ValueError):
                        logger.error(f"Response text: {e.response.text if hasattr(e.response, 'text') else 'N/A'}")
            raise

    def collection(self, path: str):
        """
        Get a collection reference (for SDK-like interface).

        Returns a CollectionReference object that supports .document() chaining.

        Args:
            path: Collection path (e.g., 'sites')

        Returns:
            CollectionReference object
        """
        return CollectionReference(self, path)

    def batch(self):
        """
        Create a batch writer for atomic operations.

        Returns:
            BatchWriter object
        """
        return BatchWriter(self)


class CollectionReference:
    """
    Collection reference for SDK-like interface.

    Allows chaining like: firestore.collection('sites').document('abc').collection('machines')
    """

    def __init__(self, client: FirestoreRestClient, path: str):
        self.client = client
        self.path = path

    def document(self, doc_id: str):
        """Get a document reference."""
        return DocumentReference(self.client, f"{self.path}/{doc_id}")

    def stream(self):
        """
        Stream all documents in the collection.

        Note: This fetches all documents at once (no true streaming).
        For large collections, this may be slow or hit memory limits.

        Returns:
            Generator of DocumentSnapshot objects
        """
        try:
            url = f"{self.client.base_url}/{self.path}"

            response = self.client.session.get(
                url,
                headers=self.client._get_auth_headers(),
                timeout=self.client.request_timeout
            )

            response.raise_for_status()
            try:
                data = response.json()
            except json.JSONDecodeError:
                logger.error(f"Non-JSON response listing documents (status {response.status_code}): {response.text[:200]}")
                return

            documents = data.get('documents', [])

            for doc in documents:
                # Format: projects/.../databases/.../documents/path/to/doc_id
                doc_name = doc.get('name', '')
                doc_id = doc_name.split('/')[-1]

                yield DocumentSnapshot(
                    reference=DocumentReference(self.client, f"{self.path}/{doc_id}"),
                    data=self.client._from_firestore_document(doc),
                    exists=True
                )

        except Exception as e:
            logger.error(f"Error streaming collection {self.path}: {e}")
            raise


class DocumentReference:
    """
    Document reference for SDK-like interface.

    Provides methods: get(), set(), update(), delete(), collection()
    """

    def __init__(self, client: FirestoreRestClient, path: str):
        self.client = client
        self.path = path

    def get(self) -> Optional[Dict[str, Any]]:
        """Get document data."""
        return self.client.get_document(self.path)

    def set(self, data: Dict[str, Any], merge: bool = False):
        """Set document data."""
        return self.client.set_document(self.path, data, merge=merge)

    def update(self, updates: Dict[str, Any]):
        """Update document fields."""
        return self.client.update_document(self.path, updates)

    def delete(self):
        """Delete document."""
        return self.client.delete_document(self.path)

    def collection(self, collection_id: str):
        """Get a subcollection reference."""
        return CollectionReference(self.client, f"{self.path}/{collection_id}")


class DocumentSnapshot:
    """
    Document snapshot returned by stream() operations.

    Matches the interface of firebase_admin DocumentSnapshot.
    """

    def __init__(self, reference: DocumentReference, data: Optional[Dict[str, Any]], exists: bool):
        self.reference = reference
        self._data = data
        self.exists = exists

    def to_dict(self) -> Optional[Dict[str, Any]]:
        """Get document data as dictionary."""
        return self._data


class BatchWriter:
    """
    Batch writer for atomic operations.

    Matches the interface of firebase_admin WriteBatch.
    """

    def __init__(self, client: FirestoreRestClient):
        self.client = client
        self.operations: List[Dict[str, Any]] = []

    def set(self, reference: DocumentReference, data: Dict[str, Any]):
        """Add a set operation to the batch."""
        self.operations.append({
            'operation': 'set',
            'path': reference.path,
            'data': data
        })
        return self

    def update(self, reference: DocumentReference, updates: Dict[str, Any]):
        """Add an update operation to the batch."""
        self.operations.append({
            'operation': 'update',
            'path': reference.path,
            'data': updates
        })
        return self

    def delete(self, reference: DocumentReference):
        """Add a delete operation to the batch."""
        self.operations.append({
            'operation': 'delete',
            'path': reference.path
        })
        return self

    def commit(self):
        """Commit all batched operations atomically."""
        if not self.operations:
            return

        self.client.batch_write(self.operations)

        self.operations = []

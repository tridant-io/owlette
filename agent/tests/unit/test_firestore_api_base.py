"""The Firestore REST origin: production by default, emulator when asked.

Two things are pinned here and neither may drift:

1. With FIRESTORE_EMULATOR_HOST unset — every installed agent, always — the URLs
   are byte-identical to the ones the client sent before the seam existed. The
   expected strings below are written out in full, on purpose: a test that built
   them from the same constant the code uses could not catch a change to it.
2. With the variable set, every request path (not just the plain document GET /
   PATCH) moves to the emulator. `:commit` and `:batchWrite` used to re-derive
   their URL from the module constant, so a partial redirect would have left
   server-timestamp writes and batches still aimed at Google.
"""

import pytest
from unittest.mock import MagicMock

try:
    import firestore_rest_client
    from firestore_rest_client import FirestoreRestClient, SERVER_TIMESTAMP
except ImportError:
    pytest.skip("firestore_rest_client not importable", allow_module_level=True)


PROJECT = "owlette-dev-3838a"

PROD_DOCUMENTS = (
    "https://firestore.googleapis.com/v1"
    f"/projects/{PROJECT}/databases/(default)/documents"
)


@pytest.fixture
def mock_auth():
    auth = MagicMock()
    auth.get_valid_token.return_value = "fake-token"
    return auth


@pytest.fixture(autouse=True)
def _no_emulator_by_default(monkeypatch):
    """Never inherit the ambient value — a developer running the suite inside
    `firebase emulators:exec` would otherwise see the production tests fail."""
    monkeypatch.delenv("FIRESTORE_EMULATOR_HOST", raising=False)


def _urls_used(client, call) -> list:
    """Run `call(client)` against a mocked session and return the URLs it hit."""
    session = MagicMock()
    client.session = session
    call(client)
    return [
        c.args[0] if c.args else c.kwargs["url"]
        for method in (session.get, session.post, session.patch, session.delete)
        for c in method.call_args_list
    ]


class TestResolveApiBase:
    def test_production_default_is_unchanged(self):
        assert firestore_rest_client.resolve_api_base() == (
            "https://firestore.googleapis.com/v1"
        )

    def test_empty_variable_is_not_an_emulator(self, monkeypatch):
        """`FIRESTORE_EMULATOR_HOST=` (set but blank) must stay on production —
        an exported-but-empty variable is how a shell clears one, not how it
        names a host."""
        monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "")
        assert firestore_rest_client.resolve_api_base() == (
            "https://firestore.googleapis.com/v1"
        )

    def test_whitespace_variable_is_not_an_emulator(self, monkeypatch):
        monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "   ")
        assert firestore_rest_client.resolve_api_base() == (
            "https://firestore.googleapis.com/v1"
        )

    def test_bare_host_port_gets_http_and_v1(self, monkeypatch):
        monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080")
        assert firestore_rest_client.resolve_api_base() == "http://127.0.0.1:8080/v1"

    def test_host_with_scheme_is_not_double_prefixed(self, monkeypatch):
        monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "http://localhost:8080")
        assert firestore_rest_client.resolve_api_base() == "http://localhost:8080/v1"

    def test_trailing_slash_is_trimmed(self, monkeypatch):
        monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "http://localhost:8080/")
        assert firestore_rest_client.resolve_api_base() == "http://localhost:8080/v1"

    def test_read_per_call_not_captured_at_import(self, monkeypatch):
        """The module is imported once per process; a value read at import time
        would make the seam useless to anything that sets the variable later."""
        assert firestore_rest_client.resolve_api_base().startswith("https://")
        monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:9999")
        assert firestore_rest_client.resolve_api_base() == "http://127.0.0.1:9999/v1"


class TestProductionUrlsAreByteIdentical:
    """The negative control for the whole change: unset variable, unchanged wire."""

    def test_documents_base(self, mock_auth):
        client = FirestoreRestClient(project_id=PROJECT, auth_manager=mock_auth)
        assert client.base_url == PROD_DOCUMENTS
        assert client.api_base == "https://firestore.googleapis.com/v1"

    def test_get_document(self, mock_auth):
        client = FirestoreRestClient(project_id=PROJECT, auth_manager=mock_auth)
        urls = _urls_used(client, lambda c: c.get_document("config/site-A/machines/PC-1"))
        assert urls == [f"{PROD_DOCUMENTS}/config/site-A/machines/PC-1"]

    def test_set_document_patch(self, mock_auth):
        client = FirestoreRestClient(project_id=PROJECT, auth_manager=mock_auth)
        urls = _urls_used(client, lambda c: c.set_document("test/doc1", {"a": 1}))
        assert urls == [f"{PROD_DOCUMENTS}/test/doc1"]

    def test_set_document_commit(self, mock_auth):
        """SERVER_TIMESTAMP routes through :commit — the path that used to
        re-derive its URL from the module constant."""
        client = FirestoreRestClient(project_id=PROJECT, auth_manager=mock_auth)
        urls = _urls_used(
            client, lambda c: c.set_document("test/doc1", {"t": SERVER_TIMESTAMP})
        )
        assert urls == [f"{PROD_DOCUMENTS}:commit"]

    def test_update_document_patch(self, mock_auth):
        client = FirestoreRestClient(project_id=PROJECT, auth_manager=mock_auth)
        urls = _urls_used(client, lambda c: c.update_document("test/doc1", {"a": 1}))
        assert urls == [f"{PROD_DOCUMENTS}/test/doc1"]

    def test_update_document_commit(self, mock_auth):
        client = FirestoreRestClient(project_id=PROJECT, auth_manager=mock_auth)
        urls = _urls_used(
            client, lambda c: c.update_document("test/doc1", {"t": SERVER_TIMESTAMP})
        )
        assert urls == [f"{PROD_DOCUMENTS}:commit"]

    def test_delete_document(self, mock_auth):
        client = FirestoreRestClient(project_id=PROJECT, auth_manager=mock_auth)
        urls = _urls_used(client, lambda c: c.delete_document("test/doc1"))
        assert urls == [f"{PROD_DOCUMENTS}/test/doc1"]

    def test_batch_write(self, mock_auth):
        client = FirestoreRestClient(project_id=PROJECT, auth_manager=mock_auth)
        urls = _urls_used(
            client,
            lambda c: c.batch_write([{"operation": "set", "path": "t/1", "data": {}}]),
        )
        # `:commit`, the endpoint a user token may use for a batch (`:batchWrite` is for service accounts).
        assert urls == [f"{PROD_DOCUMENTS}:commit"]

    def test_collection_stream(self, mock_auth):
        client = FirestoreRestClient(project_id=PROJECT, auth_manager=mock_auth)
        urls = _urls_used(client, lambda c: list(c.collection("sites").stream()))
        assert urls == [f"{PROD_DOCUMENTS}/sites"]


class TestEmulatorUrls:
    """Same call sites, redirected. The emulator serves the identical /v1
    surface, so only the origin differs."""

    EMU_DOCUMENTS = (
        f"http://127.0.0.1:8080/v1/projects/{PROJECT}/databases/(default)/documents"
    )

    @pytest.fixture
    def client(self, monkeypatch, mock_auth):
        monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080")
        return FirestoreRestClient(project_id=PROJECT, auth_manager=mock_auth)

    def test_documents_base(self, client):
        assert client.base_url == self.EMU_DOCUMENTS
        assert client.api_base == "http://127.0.0.1:8080/v1"

    def test_get_document(self, client):
        urls = _urls_used(client, lambda c: c.get_document("config/site-A/machines/PC-1"))
        assert urls == [f"{self.EMU_DOCUMENTS}/config/site-A/machines/PC-1"]

    def test_set_document_patch(self, client):
        urls = _urls_used(client, lambda c: c.set_document("test/doc1", {"a": 1}))
        assert urls == [f"{self.EMU_DOCUMENTS}/test/doc1"]

    def test_set_document_commit(self, client):
        urls = _urls_used(
            client, lambda c: c.set_document("test/doc1", {"t": SERVER_TIMESTAMP})
        )
        assert urls == [f"{self.EMU_DOCUMENTS}:commit"]

    def test_update_document_commit(self, client):
        urls = _urls_used(
            client, lambda c: c.update_document("test/doc1", {"t": SERVER_TIMESTAMP})
        )
        assert urls == [f"{self.EMU_DOCUMENTS}:commit"]

    def test_batch_write(self, client):
        urls = _urls_used(
            client,
            lambda c: c.batch_write([{"operation": "set", "path": "t/1", "data": {}}]),
        )
        assert urls == [f"{self.EMU_DOCUMENTS}:commit"]

    def test_no_googleapis_url_survives_anywhere(self, client):
        """A partial redirect is the failure mode worth naming: an agent pointed
        at the emulator that still reaches the internet for some writes."""
        calls = [
            lambda c: c.get_document("a/b"),
            lambda c: c.set_document("a/b", {"x": 1}),
            lambda c: c.set_document("a/b", {"t": SERVER_TIMESTAMP}),
            lambda c: c.update_document("a/b", {"x": 1}),
            lambda c: c.update_document("a/b", {"t": SERVER_TIMESTAMP}),
            lambda c: c.delete_document("a/b"),
            lambda c: c.batch_write([{"operation": "set", "path": "a/b", "data": {}}]),
            lambda c: list(c.collection("sites").stream()),
        ]
        for call in calls:
            for url in _urls_used(client, call):
                assert "googleapis.com" not in url, url
                assert url.startswith("http://127.0.0.1:8080/v1/"), url


class TestClientsAreIndependent:
    def test_a_later_client_picks_up_a_changed_target(self, monkeypatch, mock_auth):
        """api_base is per-instance, so re-creating the client (which
        FirebaseClient._do_connect does on every reconnect) re-resolves."""
        prod = FirestoreRestClient(project_id=PROJECT, auth_manager=mock_auth)
        monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080")
        emu = FirestoreRestClient(project_id=PROJECT, auth_manager=mock_auth)

        assert prod.base_url == PROD_DOCUMENTS
        assert emu.base_url.startswith("http://127.0.0.1:8080/v1/")

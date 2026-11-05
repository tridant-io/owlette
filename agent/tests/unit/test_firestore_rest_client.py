"""Tests for firestore_rest_client.py — Firestore REST API value conversion and CRUD."""

import pytest
from unittest.mock import MagicMock, patch
import logging
import json

try:
    from firestore_rest_client import FirestoreRestClient
except ImportError:
    pytest.skip("firestore_rest_client not importable", allow_module_level=True)


@pytest.fixture
def mock_auth():
    auth = MagicMock()
    auth.get_valid_token.return_value = "fake-token"
    auth._site_id = "test-site"
    auth.machine_id = "TEST-MACHINE"
    auth.api_base = "https://owlette.app/api"
    return auth


@pytest.fixture
def client(mock_auth):
    return FirestoreRestClient(project_id="test-project", auth_manager=mock_auth)


class TestToFirestoreValue:
    def test_string_value(self, client):
        result = client._to_firestore_value("hello")
        assert result == {"stringValue": "hello"}

    def test_empty_string(self, client):
        result = client._to_firestore_value("")
        assert result == {"stringValue": ""}

    def test_integer_value(self, client):
        result = client._to_firestore_value(42)
        assert result == {"integerValue": "42"}

    def test_zero_integer(self, client):
        result = client._to_firestore_value(0)
        assert result == {"integerValue": "0"}

    def test_negative_integer(self, client):
        result = client._to_firestore_value(-7)
        assert result == {"integerValue": "-7"}

    def test_bool_true(self, client):
        """bool must be checked BEFORE int since bool is subclass of int in Python."""
        result = client._to_firestore_value(True)
        assert result == {"booleanValue": True}

    def test_bool_false(self, client):
        result = client._to_firestore_value(False)
        assert result == {"booleanValue": False}

    def test_bool_before_int_ordering(self, client):
        """Critical: True should NOT produce integerValue '1'."""
        result = client._to_firestore_value(True)
        assert "integerValue" not in result
        assert "booleanValue" in result

        result = client._to_firestore_value(False)
        assert "integerValue" not in result
        assert "booleanValue" in result

    def test_float_value(self, client):
        result = client._to_firestore_value(3.14)
        assert result == {"doubleValue": 3.14}

    def test_none_value(self, client):
        result = client._to_firestore_value(None)
        assert result == {"nullValue": None}

    def test_dict_value(self, client):
        result = client._to_firestore_value({"key": "val"})
        assert "mapValue" in result
        assert "fields" in result["mapValue"]
        inner = result["mapValue"]["fields"]
        assert inner["key"] == {"stringValue": "val"}

    def test_nested_dict(self, client):
        result = client._to_firestore_value({"outer": {"inner": 1}})
        assert "mapValue" in result
        outer_fields = result["mapValue"]["fields"]
        assert "mapValue" in outer_fields["outer"]
        inner_fields = outer_fields["outer"]["mapValue"]["fields"]
        assert inner_fields["inner"] == {"integerValue": "1"}

    def test_list_value(self, client):
        result = client._to_firestore_value(["a", "b"])
        assert "arrayValue" in result
        values = result["arrayValue"]["values"]
        assert values[0] == {"stringValue": "a"}
        assert values[1] == {"stringValue": "b"}

    def test_empty_list(self, client):
        result = client._to_firestore_value([])
        assert "arrayValue" in result

    def test_mixed_list(self, client):
        result = client._to_firestore_value([1, "two", True, None])
        values = result["arrayValue"]["values"]
        assert values[0] == {"integerValue": "1"}
        assert values[1] == {"stringValue": "two"}
        assert values[2] == {"booleanValue": True}
        assert values[3] == {"nullValue": None}


class TestFromFirestoreValue:
    def test_string_value(self, client):
        result = client._from_firestore_value({"stringValue": "hello"})
        assert result == "hello"

    def test_integer_value(self, client):
        result = client._from_firestore_value({"integerValue": "42"})
        assert result == 42

    def test_boolean_value_true(self, client):
        result = client._from_firestore_value({"booleanValue": True})
        assert result is True

    def test_boolean_value_false(self, client):
        result = client._from_firestore_value({"booleanValue": False})
        assert result is False

    def test_null_value(self, client):
        result = client._from_firestore_value({"nullValue": None})
        assert result is None

    def test_double_value(self, client):
        result = client._from_firestore_value({"doubleValue": 3.14})
        assert result == 3.14

    def test_map_value(self, client):
        firestore_val = {
            "mapValue": {
                "fields": {
                    "name": {"stringValue": "Owlette"},
                    "version": {"integerValue": "2"},
                }
            }
        }
        result = client._from_firestore_value(firestore_val)
        assert isinstance(result, dict)
        assert result["name"] == "Owlette"
        assert result["version"] == 2

    def test_nested_map_value(self, client):
        firestore_val = {
            "mapValue": {
                "fields": {
                    "config": {
                        "mapValue": {
                            "fields": {
                                "enabled": {"booleanValue": True}
                            }
                        }
                    }
                }
            }
        }
        result = client._from_firestore_value(firestore_val)
        assert result["config"]["enabled"] is True

    def test_array_value(self, client):
        firestore_val = {
            "arrayValue": {
                "values": [
                    {"stringValue": "one"},
                    {"integerValue": "2"},
                    {"booleanValue": False},
                ]
            }
        }
        result = client._from_firestore_value(firestore_val)
        assert result == ["one", 2, False]


class TestCRUD:
    def test_get_document_success(self, client):
        """get_document should parse Firestore response into a Python dict."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "name": "projects/test-project/databases/(default)/documents/test/doc1",
            "fields": {
                "status": {"stringValue": "online"},
                "uptime": {"integerValue": "3600"},
            },
        }
        # The client uses self.session.get, not requests.get.
        client.session.get = MagicMock(return_value=mock_response)

        result = client.get_document("test/doc1")

        assert result is not None
        assert result["status"] == "online"
        assert result["uptime"] == 3600

    def test_get_document_404_returns_none(self, client):
        """404 response should return None."""
        mock_response = MagicMock()
        mock_response.status_code = 404

        client.session.get = MagicMock(return_value=mock_response)

        result = client.get_document("test/nonexistent")
        assert result is None

    def test_set_document_sends_patch(self, client):
        """set_document should PATCH with Firestore-formatted data."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()

        client.session.patch = MagicMock(return_value=mock_response)

        client.set_document("test/doc1", {"name": "Agent-1", "active": True})

        assert client.session.patch.called
        call_kwargs = client.session.patch.call_args
        body = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
        assert "fields" in body
        assert "name" in body["fields"]
        assert body["fields"]["name"] == {"stringValue": "Agent-1"}
        assert body["fields"]["active"] == {"booleanValue": True}

    def test_delete_document_success(self, client):
        """delete_document should send DELETE request."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()

        client.session.delete = MagicMock(return_value=mock_response)

        client.delete_document("test/doc1")

        assert client.session.delete.called
        call_args = client.session.delete.call_args
        url = call_args[0][0]
        assert "test/doc1" in url

    def test_delete_document_404_is_ok(self, client):
        """Deleting a non-existent document should not raise."""
        mock_response = MagicMock()
        mock_response.status_code = 404

        client.session.delete = MagicMock(return_value=mock_response)

        client.delete_document("test/nonexistent")

    def test_batch_write_goes_through_commit(self, client):
        """`:batchWrite` is for service accounts and answered 403 to the agent's
        token, so a batch of 500 became 500 requests. `:commit` takes the same
        writes array."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()
        client.session.post = MagicMock(return_value=mock_response)

        client.batch_write([
            {'operation': 'set', 'path': 'logs/a', 'data': {'msg': 'one'}},
            {'operation': 'delete', 'path': 'logs/b'},
        ])

        assert client.session.post.called
        url = client.session.post.call_args.args[0]
        assert url.endswith(':commit')
        body = client.session.post.call_args.kwargs['json']
        assert [list(w.keys())[0] for w in body['writes']] == ['update', 'delete']

    def test_update_document_with_field_mask(self, client):
        """update_document should include updateMask params."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()

        client.session.patch = MagicMock(return_value=mock_response)

        client.update_document("test/doc1", {"cpu": 25.5, "memory": 60.0})

        assert client.session.patch.called
        call_kwargs = client.session.patch.call_args
        params = call_kwargs.kwargs.get("params") or call_kwargs[1].get("params")
        assert params is not None
        field_paths = params.get("updateMask.fieldPaths")
        assert "cpu" in field_paths
        assert "memory" in field_paths

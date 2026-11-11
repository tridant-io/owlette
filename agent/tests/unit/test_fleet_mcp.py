"""
Unit tests for fleet_mcp — the stdio MCP server an AI assistant on this machine
launches to act on its site through the fleet routes.

Every in-process test drives the real MCP server through mcp's in-memory
Client, so the handlers and the wire-shaped results are exercised as a client
sees them. The fleet API is a FakeApi standing in for the requests.Session the
script holds; the poll's sleep and clock are a FakeClock, so nothing sleeps.
The session file lives under a temp OWLETTE_DATA_ROOT (shared_utils resolves
the root per call), so nothing here touches the real machine's data root.

One test launches the script itself over stdio, with no session, the way an
MCP client would.
"""

import asyncio
import base64
import contextlib
import json
import os
import sys
import time
import uuid
from pathlib import Path

import pytest
import requests

mcp = pytest.importorskip('mcp', reason='mcp not installed in this environment')
from mcp import Client  # noqa: E402
from mcp.client.stdio import StdioServerParameters  # noqa: E402

import fleet_mcp  # noqa: E402


API_BASE = 'https://dev.owlette.app/api'
TOKEN = 'owf_secret-session-token'
ROTATED_TOKEN = 'owf_rotated-session-token'
SITE_ID = 'site-1'
MACHINE_ID = 'machine-1'
IMAGE_URL = 'https://storage.googleapis.com/bucket/shot.png?X-Goog-Signature=deadbeef'
PNG_BYTES = b'\x89PNG\r\n\x1a\nnot-really-a-png'

SCRIPT = Path(fleet_mcp.__file__)

CATALOG = [
    {
        'name': 'list_machines',
        'description': 'the machines this machine may act on',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'get_process_list',
        'description': 'the processes owlette manages on a machine',
        'inputSchema': {
            'type': 'object',
            'properties': {'machine': {'type': 'string'}},
            'required': ['machine'],
        },
    },
]


# Fakes

class FakeResponse:
    """Just enough of requests.Response for the script."""

    def __init__(self, status_code=200, body=None, headers=None, content=b''):
        self.status_code = status_code
        self._body = body
        self.headers = headers or {}
        self._content = content

    def json(self):
        if self._body is None:
            raise ValueError('no json body')
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f'{self.status_code} for a url')

    def iter_content(self, chunk_size):
        for start in range(0, len(self._content), chunk_size):
            yield self._content[start:start + chunk_size]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


TOOLS_ROUTE = ('GET', '/agent/fleet/tools')


class FakeApi:
    """A requests.Session stand-in: answers fleet routes from a script and
    records every request.

    `answer(method, path, *responses)` queues responses for a route; the last
    one repeats. A response may be a callable, run when the request arrives, or
    an exception, raised then. The tool list answers CATALOG unless a test says
    otherwise.
    """

    def __init__(self):
        self.routes = {}
        self.requests = []
        self.images = {}
        self.image_requests = []

    def answer(self, method, path, *responses):
        self.routes.setdefault((method, path), []).extend(responses)

    def request(self, method, url, **kwargs):
        self.requests.append({'method': method, 'url': url, **kwargs})
        assert url.startswith(API_BASE), f'request to a server that is not the api base: {url}'
        route = (method, url[len(API_BASE):])
        queue = self.routes.get(route)
        if queue is None and route == TOOLS_ROUTE:
            queue = [FakeResponse(200, {'tools': CATALOG})]
        assert queue, f'unexpected request: {route}'
        response = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(response, Exception):
            raise response
        return response() if callable(response) else response

    def get(self, url, **kwargs):
        self.image_requests.append({'url': url, **kwargs})
        return self.images[url]

    @property
    def calls(self):
        """Every request but the tool list, which mcp's client fetches again
        after a call to check the result against the tool's output schema."""
        return [r for r in self.requests if (r['method'], r['url'][len(API_BASE):]) != TOOLS_ROUTE]

    def headers(self, index):
        return self.calls[index]['headers']


class FakeClock:
    """The poll's clock and its sleep: sleeping moves the clock, instantly."""

    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def __call__(self):
        return self.now

    async def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def problem(status, code, detail):
    """An RFC 7807 problem response."""
    return FakeResponse(status, {
        'type': 'about:blank', 'title': 'refused', 'status': status, 'detail': detail, 'code': code,
    })


# Helpers / fixtures

@pytest.fixture
def data_root(tmp_path, monkeypatch):
    """Point the data root at a temp dir with no session in it."""
    monkeypatch.setenv('OWLETTE_DATA_ROOT', str(tmp_path))
    return tmp_path


def write_session(**fields):
    """Write the session file the agent keeps, with `fields` over a live one."""
    session = {
        'token': TOKEN,
        'expiresAt': int(time.time()) + 900,
        'apiBase': API_BASE,
        'siteId': SITE_ID,
        'machineId': MACHINE_ID,
        **fields,
    }
    path = fleet_mcp.session_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(session, f)


@pytest.fixture
def session(data_root):
    write_session()


@pytest.fixture
def api():
    return FakeApi()


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def fleet(api, clock):
    return fleet_mcp.FleetClient(http=api, sleep=clock.sleep, clock=clock)


def over_mcp(fleet, action):
    """Run `action(client)` against the real server, through mcp's in-memory client."""
    async def run():
        async with Client(fleet_mcp.build_server(fleet)) as client:
            return await action(client)
    return asyncio.run(run())


def list_tools(fleet):
    return over_mcp(fleet, lambda client: client.list_tools()).tools


def call(fleet, name, arguments=None):
    return over_mcp(fleet, lambda client: client.call_tool(name, arguments or {}))


def texts(result):
    return [item.text for item in result.content if item.type == 'text']


async def _list_and_status(client):
    tools = await client.list_tools()
    status = await client.call_tool('fleet_status', {})
    return [tool.name for tool in tools.tools], status


def started(call_id='cmd:machine-2:abc', **fields):
    """The 202 a call that runs on a machine starts with."""
    return FakeResponse(202, {'callId': call_id, **fields})


# The tool list

def test_without_a_session_the_list_is_fleet_status_alone(data_root, api, fleet):
    assert [tool.name for tool in list_tools(fleet)] == ['fleet_status']
    assert api.requests == []


def test_with_a_session_the_server_catalog_follows_fleet_status(session, api, fleet):
    api.answer('GET', '/agent/fleet/tools', FakeResponse(200, {
        'tools': CATALOG, 'site': {'id': SITE_ID}, 'machine': {'id': MACHINE_ID},
    }))

    tools = list_tools(fleet)

    assert [tool.name for tool in tools] == ['fleet_status', 'list_machines', 'get_process_list']
    assert tools[2].input_schema == CATALOG[1]['inputSchema']
    request = api.requests[0]
    assert request['method'] == 'GET'
    assert request['url'] == f'{API_BASE}/agent/fleet/tools'
    assert request['timeout'] == 30
    assert request['headers']['Authorization'] == f'Bearer {TOKEN}'
    assert request['headers']['User-Agent'].startswith('Owlette-Agent/')
    assert request['headers']['User-Agent'].endswith(f'; {MACHINE_ID})')


@pytest.mark.parametrize('answer', [
    problem(403, 'fleet_not_granted', 'this machine is not granted'),
    requests.ConnectionError('offline'),
])
def test_a_catalog_the_server_will_not_give_leaves_fleet_status(session, api, fleet, answer):
    api.answer('GET', '/agent/fleet/tools', answer)

    assert [tool.name for tool in list_tools(fleet)] == ['fleet_status']


def test_a_malformed_catalog_entry_is_dropped_and_the_rest_kept(session, api, fleet, caplog):
    api.answer('GET', '/agent/fleet/tools', FakeResponse(200, {'tools': [
        CATALOG[0],
        {'name': 'broken_tool', 'inputSchema': 'not a schema'},
        42,
    ]}))

    assert [tool.name for tool in list_tools(fleet)] == ['fleet_status', 'list_machines']
    assert 'broken_tool' in caplog.text


def test_fleet_status_says_why_the_server_offers_no_tools_until_it_answers(session, api, fleet):
    api.answer(
        'GET', '/agent/fleet/tools',
        problem(403, 'fleet_not_granted', 'this machine is not granted'),
        FakeResponse(200, {'tools': CATALOG}),
    )

    names, status = over_mcp(fleet, _list_and_status)

    assert names == ['fleet_status']
    assert texts(status)[0].endswith(
        'the server refused the last request: fleet_not_granted: this machine is not granted'
    )

    assert [tool.name for tool in list_tools(fleet)] == ['fleet_status'] + [t['name'] for t in CATALOG]
    assert 'refused' not in texts(call(fleet, 'fleet_status'))[0]


def test_a_trailing_slash_on_the_api_base_keeps_one_slash(data_root, api, fleet):
    write_session(apiBase=f'{API_BASE}/')
    api.answer('GET', '/agent/fleet/tools', FakeResponse(200, {'tools': []}))

    list_tools(fleet)

    assert api.requests[0]['url'] == f'{API_BASE}/agent/fleet/tools'


# fleet_status and what counts as no session

def test_fleet_status_without_a_session_says_how_to_get_one(data_root, fleet):
    result = call(fleet, 'fleet_status')

    assert not result.is_error
    assert "a site owner or site admin grants it in the site's settings" in texts(result)[0]


def test_fleet_status_reports_the_session_but_never_its_token(data_root, api, fleet):
    expires_at = int(time.time()) + 600
    write_session(expiresAt=expires_at)
    expected_expiry = time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(expires_at))

    text = texts(call(fleet, 'fleet_status'))[0]

    assert 'session: yes' in text
    assert SITE_ID in text and MACHINE_ID in text
    assert 'dev.owlette.app' in text
    assert expected_expiry in text
    assert TOKEN not in text and 'owf_' not in text
    assert api.calls == []


@pytest.mark.parametrize('fields', [
    {'expiresAt': int(time.time()) - 1},
    {'expiresAt': '9999999999'},
    {'expiresAt': True},
    {'expiresAt': float('nan')},
    {'expiresAt': float('inf')},
    {'token': ''},
    {'token': 'owf_abc\nX-Injected: 1'},
    {'token': 'owf_abc def'},
    {'token': 'owf_abc\x00'},
    {'siteId': None},
    {'machineId': 7},
], ids=[
    'expired', 'expiry-a-string', 'expiry-a-bool', 'expiry-nan', 'expiry-infinity',
    'empty-token', 'token-with-a-newline', 'token-with-a-space', 'token-with-a-control-character',
    'no-site', 'machine-not-a-string',
])
def test_an_unusable_session_file_is_no_session(data_root, api, fleet, fields):
    write_session(**fields)

    assert [tool.name for tool in list_tools(fleet)] == ['fleet_status']
    result = call(fleet, 'get_process_list', {'machine': 'machine-2'})
    assert result.is_error
    assert texts(result) == [fleet_mcp.NO_SESSION]
    assert api.requests == []


def test_an_unreadable_session_file_is_no_session(data_root, api, fleet):
    path = fleet_mcp.session_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Path(path).write_text('{"token": "owf_', encoding='utf-8')

    assert [tool.name for tool in list_tools(fleet)] == ['fleet_status']
    assert texts(call(fleet, 'fleet_status')) == [fleet_mcp.NO_SESSION]
    assert api.requests == []


def test_a_session_naming_another_server_is_ignored_and_the_token_stays_home(data_root, api, fleet):
    write_session(apiBase='https://owlette.example.com/api')

    assert [tool.name for tool in list_tools(fleet)] == ['fleet_status']
    status = texts(call(fleet, 'fleet_status'))[0]
    assert 'not owlette' in status and 'owlette.example.com' in status
    result = call(fleet, 'get_process_list', {'machine': 'machine-2'})
    assert result.is_error
    assert api.requests == []


def test_the_owlette_check_decides_which_servers_get_the_token(data_root, api, fleet, monkeypatch):
    write_session()
    monkeypatch.setattr(fleet_mcp.shared_utils, 'is_owlette_api_base', lambda base: False)

    assert [tool.name for tool in list_tools(fleet)] == ['fleet_status']
    assert api.requests == []


# Calls

def test_an_inline_call_maps_its_content(session, api, fleet):
    api.answer('POST', '/agent/fleet/call', FakeResponse(200, {
        'status': 'completed', 'content': [{'type': 'text', 'text': '2 machines online'}],
    }))

    result = call(fleet, 'list_machines')

    assert not result.is_error
    assert texts(result) == ['2 machines online']
    request = api.calls[0]
    assert request['url'] == f'{API_BASE}/agent/fleet/call'
    assert request['json'] == {'tool': 'list_machines', 'params': {}}
    assert request['timeout'] == 30
    assert request['headers']['Authorization'] == f'Bearer {TOKEN}'
    uuid.UUID(request['headers']['Idempotency-Key'])


def test_an_inline_call_that_failed_is_an_error_led_by_its_reason(session, api, fleet):
    # a tool the server answers itself fails in the same response, with no poll
    api.answer('POST', '/agent/fleet/call', FakeResponse(200, {
        'status': 'failed', 'error': 'process_not_found: no process named nope',
    }))

    result = call(fleet, 'delete_process', {'machine': 'machine-2', 'process_name': 'nope'})

    assert result.is_error
    assert texts(result) == ['process_not_found: no process named nope']
    assert len(api.calls) == 1


def test_every_call_carries_a_fresh_idempotency_key(session, api, fleet):
    api.answer('POST', '/agent/fleet/call', FakeResponse(200, {'status': 'completed', 'content': []}))

    call(fleet, 'list_machines')
    call(fleet, 'list_machines')

    assert api.headers(0)['Idempotency-Key'] != api.headers(1)['Idempotency-Key']


def test_a_started_call_is_polled_until_it_completes(session, api, fleet, clock):
    api.answer('POST', '/agent/fleet/call', FakeResponse(202, {'callId': 'cmd:machine-2:abc'}))
    api.answer(
        'GET', '/agent/fleet/calls/cmd%3Amachine-2%3Aabc',
        FakeResponse(200, {'status': 'pending'}),
        FakeResponse(200, {'status': 'in_progress'}),
        FakeResponse(200, {'status': 'completed', 'content': [{'type': 'text', 'text': 'TouchDesigner: running'}]}),
    )

    result = call(fleet, 'get_process_list', {'machine': 'machine-2'})

    assert not result.is_error
    assert texts(result) == ['TouchDesigner: running']
    assert api.calls[0]['json'] == {'tool': 'get_process_list', 'params': {'machine': 'machine-2'}}
    assert clock.sleeps == [1, 1, 1]
    assert [r['method'] for r in api.calls] == ['POST', 'GET', 'GET', 'GET']


def test_polling_backs_off_after_thirty_seconds_and_stops_at_the_server_timeout_plus_thirty(
        session, api, fleet, clock):
    api.answer('POST', '/agent/fleet/call', started('cmd:machine-2:slow', timeoutSeconds=15))
    api.answer('GET', '/agent/fleet/calls/cmd%3Amachine-2%3Aslow', FakeResponse(200, {'status': 'in_progress'}))

    result = call(fleet, 'run_command', {'machine': 'machine-2'})

    assert result.is_error
    assert 'still running after 45 seconds' in texts(result)[0]
    assert 'cmd:machine-2:slow' in texts(result)[0]
    assert clock.sleeps == [1] * 30 + [3] * 5


def test_the_server_timeout_is_capped_at_an_hour(session, api, fleet, clock):
    api.answer('POST', '/agent/fleet/call', started('cmd:machine-2:slow', timeoutSeconds=7200))
    api.answer('GET', '/agent/fleet/calls/cmd%3Amachine-2%3Aslow', FakeResponse(200, {'status': 'pending'}))

    result = call(fleet, 'run_command', {'machine': 'machine-2'})

    assert 'still running after 3630 seconds' in texts(result)[0]
    assert sum(clock.sleeps) == 3630


@pytest.mark.parametrize('fields', [
    {},
    {'timeoutSeconds': 0},
    {'timeoutSeconds': -5},
    {'timeoutSeconds': '60'},
    {'timeoutSeconds': True},
    {'timeoutSeconds': float('nan')},
    {'timeoutSeconds': float('inf')},
], ids=['absent', 'zero', 'negative', 'a-string', 'a-bool', 'nan', 'infinity'])
def test_the_poll_bound_is_ninety_seconds_without_a_usable_server_timeout(session, api, fleet, clock, fields):
    api.answer('POST', '/agent/fleet/call', started('cmd:machine-2:slow', **fields))
    api.answer('GET', '/agent/fleet/calls/cmd%3Amachine-2%3Aslow', FakeResponse(200, {'status': 'pending'}))

    result = call(fleet, 'get_process_list', {'machine': 'machine-2'})

    assert result.is_error
    assert sum(clock.sleeps) == 90


def test_a_timeout_seconds_argument_does_not_set_the_poll_bound(session, api, fleet, clock):
    api.answer('POST', '/agent/fleet/call', started('cmd:machine-2:slow'))
    api.answer('GET', '/agent/fleet/calls/cmd%3Amachine-2%3Aslow', FakeResponse(200, {'status': 'pending'}))

    call(fleet, 'set_registry_value', {'machine': 'machine-2', 'timeout_seconds': 15})

    assert sum(clock.sleeps) == 90


@pytest.mark.parametrize('dropped', [
    requests.ConnectionError('blip'),
    problem(429, 'rate_limited', 'slow down'),
    FakeResponse(503),
], ids=['connection-error', '429', '503'])
def test_a_dropped_or_refused_poll_is_retried(session, api, fleet, clock, dropped):
    api.answer('POST', '/agent/fleet/call', started())
    api.answer(
        'GET', '/agent/fleet/calls/cmd%3Amachine-2%3Aabc',
        dropped,
        FakeResponse(200, {'status': 'completed', 'content': [{'type': 'text', 'text': 'done'}]}),
    )

    result = call(fleet, 'get_process_list', {'machine': 'machine-2'})

    assert not result.is_error
    assert texts(result) == ['done']
    assert clock.sleeps == [1, 1]


def test_a_poll_answering_404_ends_the_call_naming_its_id(session, api, fleet, clock):
    api.answer('POST', '/agent/fleet/call', started())
    api.answer('GET', '/agent/fleet/calls/cmd%3Amachine-2%3Aabc', problem(404, 'not_found', 'no such call'))

    result = call(fleet, 'get_process_list', {'machine': 'machine-2'})

    assert result.is_error
    assert texts(result) == ["the call's result could not be collected (call id cmd:machine-2:abc)"]
    assert clock.sleeps == [1]


def test_a_failed_call_is_an_error_led_by_its_reason(session, api, fleet):
    api.answer('POST', '/agent/fleet/call', FakeResponse(202, {'callId': 'cmd:machine-2:abc'}))
    api.answer('GET', '/agent/fleet/calls/cmd%3Amachine-2%3Aabc', FakeResponse(200, {
        'status': 'failed', 'error': 'no process named nope',
    }))

    result = call(fleet, 'restart_process', {'machine': 'machine-2', 'process_name': 'nope'})

    assert result.is_error
    assert texts(result) == ['no process named nope']


def test_a_401_rereads_the_session_file_once_and_retries(session, api, fleet):
    def rotated_meanwhile():
        write_session(token=ROTATED_TOKEN)
        return problem(401, 'fleet_session_invalid', 'the fleet session is not valid')

    api.answer(
        'POST', '/agent/fleet/call',
        rotated_meanwhile,
        FakeResponse(200, {'status': 'completed', 'content': [{'type': 'text', 'text': 'ok'}]}),
    )

    result = call(fleet, 'list_machines')

    assert texts(result) == ['ok']
    assert len(api.calls) == 2
    assert api.headers(0)['Authorization'] == f'Bearer {TOKEN}'
    assert api.headers(1)['Authorization'] == f'Bearer {ROTATED_TOKEN}'
    assert api.headers(0)['Idempotency-Key'] == api.headers(1)['Idempotency-Key']


def test_a_second_401_is_an_error_and_there_is_no_third_try(session, api, fleet):
    api.answer('POST', '/agent/fleet/call', problem(401, 'fleet_session_invalid', 'the fleet session is not valid'))

    result = call(fleet, 'list_machines')

    assert result.is_error
    assert texts(result) == ['fleet_session_invalid: the fleet session is not valid']
    assert len(api.calls) == 2


def test_a_session_gone_by_the_retry_is_no_session(session, api, fleet):
    def grant_removed_meanwhile():
        os.remove(fleet_mcp.session_path())
        return problem(401, 'fleet_session_invalid', 'the fleet session is not valid')

    api.answer('POST', '/agent/fleet/call', grant_removed_meanwhile)

    result = call(fleet, 'list_machines')

    assert result.is_error
    assert texts(result) == [fleet_mcp.NO_SESSION]
    assert len(api.calls) == 1


# Content and error mapping

def test_an_image_url_is_fetched_into_an_image_without_the_token(session, api, fleet):
    api.answer('POST', '/agent/fleet/call', FakeResponse(200, {'status': 'completed', 'content': [
        {'type': 'image_url', 'url': IMAGE_URL},
        {'type': 'text', 'text': 'machine-2, display 1'},
    ]}))
    api.images[IMAGE_URL] = FakeResponse(200, headers={'Content-Type': 'image/png'}, content=PNG_BYTES)

    result = call(fleet, 'capture_screenshot', {'machine': 'machine-2'})

    assert not result.is_error
    image, caption = result.content
    assert image.type == 'image'
    assert base64.b64decode(image.data) == PNG_BYTES
    assert image.mime_type == 'image/png'
    assert caption.text == 'machine-2, display 1'
    fetched = api.image_requests[0]
    assert fetched['timeout'] == 30 and fetched['stream'] is True
    assert fetched['allow_redirects'] is False
    assert 'headers' not in fetched


@pytest.mark.parametrize('url,answer', [
    (IMAGE_URL, FakeResponse(404)),
    (IMAGE_URL, FakeResponse(
        302, headers={'Content-Type': 'image/png', 'Location': 'https://elsewhere.example/x.png'}, content=PNG_BYTES,
    )),
    (IMAGE_URL, FakeResponse(200, headers={'Content-Type': 'text/html'}, content=b'<html>')),
    (IMAGE_URL, FakeResponse(200, headers={'Content-Type': 'image/svg+xml'}, content=b'<svg/>')),
    (IMAGE_URL, FakeResponse(200, headers={'Content-Type': 'image/png'}, content=b'x' * (5 * 1024 * 1024 + 1))),
    ('http://storage.googleapis.com/bucket/shot.png?X-Goog-Signature=deadbeef', None),
], ids=['not-found', 'a-redirect', 'not-an-image', 'svg', 'over-5-mb', 'not-https'])
def test_an_image_that_cannot_be_had_names_only_its_host(session, api, fleet, url, answer):
    api.answer('POST', '/agent/fleet/call', FakeResponse(200, {
        'status': 'completed', 'content': [{'type': 'image_url', 'url': url}],
    }))
    if answer is not None:
        api.images[url] = answer

    result = call(fleet, 'capture_screenshot', {'machine': 'machine-2'})

    assert texts(result) == ['an image from storage.googleapis.com could not be fetched']
    if answer is None:
        assert api.image_requests == []


def test_content_of_an_unknown_kind_shows_its_text_or_a_placeholder(session, api, fleet):
    api.answer('POST', '/agent/fleet/call', FakeResponse(200, {'status': 'completed', 'content': [
        {'type': 'resource_link', 'text': 'see the agent log'},
        {'type': 'audio', 'data': 'AAAA'},
        {'type': 'audio', 'text': ''},
    ]}))

    result = call(fleet, 'list_machines')

    assert texts(result) == [
        'see the agent log',
        'owlette sent content this script cannot show (audio)',
        'owlette sent content this script cannot show (audio)',
    ]


def test_a_problem_is_an_error_carrying_its_detail_and_code(session, api, fleet):
    api.answer('POST', '/agent/fleet/call', problem(403, 'machine_not_granted', 'this machine may not act on machine-9'))

    result = call(fleet, 'get_process_list', {'machine': 'machine-9'})

    assert result.is_error
    assert texts(result) == ['machine_not_granted: this machine may not act on machine-9']


def test_a_problem_while_polling_is_an_error(session, api, fleet):
    api.answer('POST', '/agent/fleet/call', FakeResponse(202, {'callId': 'cmd:machine-2:abc'}))
    api.answer('GET', '/agent/fleet/calls/cmd%3Amachine-2%3Aabc', problem(403, 'machine_not_granted', 'no longer granted'))

    result = call(fleet, 'get_process_list', {'machine': 'machine-2'})

    assert result.is_error
    assert texts(result) == ['machine_not_granted: no longer granted']


def test_an_answer_without_json_names_the_status(session, api, fleet):
    api.answer('POST', '/agent/fleet/call', FakeResponse(502))

    result = call(fleet, 'list_machines')

    assert result.is_error
    assert texts(result) == ['owlette answered HTTP 502']


def test_an_unreachable_server_is_an_error(session, api, fleet):
    api.answer('POST', '/agent/fleet/call', requests.ConnectionError('connection refused'))

    result = call(fleet, 'list_machines')

    assert result.is_error
    assert texts(result)[0].startswith('could not reach owlette')


def test_the_token_never_reaches_a_log_line(session, api, fleet, caplog):
    caplog.set_level('DEBUG')
    api.answer('GET', '/agent/fleet/tools', requests.ConnectionError('offline'))
    api.answer('POST', '/agent/fleet/call', problem(401, 'fleet_session_invalid', 'the fleet session is not valid'))

    list_tools(fleet)
    call(fleet, 'list_machines')
    call(fleet, 'fleet_status')

    assert caplog.records
    assert TOKEN not in caplog.text and 'owf_' not in caplog.text


def test_a_requests_error_quoting_the_header_never_reaches_a_result_or_log(session, api, fleet, caplog):
    caplog.set_level('DEBUG')
    message = "Invalid return character or leading space in header: Authorization: 'Bearer owf_SECRETPART'"
    api.answer('GET', '/agent/fleet/tools', requests.exceptions.InvalidHeader(message))
    api.answer('POST', '/agent/fleet/call', requests.exceptions.InvalidHeader(message), started())
    api.answer(
        'GET', '/agent/fleet/calls/cmd%3Amachine-2%3Aabc',
        requests.exceptions.InvalidHeader(message),
        FakeResponse(200, {'status': 'completed', 'content': [{'type': 'text', 'text': 'done'}]}),
    )

    list_tools(fleet)
    refused = call(fleet, 'list_machines')
    polled = call(fleet, 'get_process_list', {'machine': 'machine-2'})

    assert texts(refused) == ['could not reach owlette: InvalidHeader']
    assert texts(polled) == ['done']
    shown = '\n'.join(texts(refused) + texts(polled)) + caplog.text
    assert 'InvalidHeader' in caplog.text
    assert 'owf_SECRETPART' not in shown and message not in shown


# Over stdio, as an MCP client launches it

def test_the_script_over_stdio_with_no_session_offers_fleet_status_alone(tmp_path):
    async def run():
        params = StdioServerParameters(
            command=sys.executable,
            args=[str(SCRIPT)],
            env={'OWLETTE_DATA_ROOT': str(tmp_path)},
        )
        async with Client(params) as client:
            return client.server_info.name, await _list_and_status(client)

    server_name, (names, status) = asyncio.run(run())

    assert server_name == 'owlette'
    assert names == ['fleet_status']
    assert not status.is_error
    assert status.content[0].text == fleet_mcp.NO_SESSION


def test_serve_points_stdout_at_stderr_while_the_server_runs(monkeypatch):
    # set to itself so monkeypatch puts the original back after the test
    monkeypatch.setattr(sys, 'stdout', sys.stdout)
    assert sys.stdout is not sys.stderr

    @contextlib.asynccontextmanager
    async def fake_stdio_server():
        yield 'read-stream', 'write-stream'

    class FakeServer:
        def create_initialization_options(self):
            return 'options'

        async def run(self, read_stream, write_stream, options):
            self.ran_with = (read_stream, write_stream, options)
            self.stdout_was_stderr = sys.stdout is sys.stderr

    monkeypatch.setattr(fleet_mcp, 'stdio_server', fake_stdio_server)
    server = FakeServer()

    asyncio.run(fleet_mcp.serve(server))

    assert server.ran_with == ('read-stream', 'write-stream', 'options')
    assert server.stdout_was_stderr is True

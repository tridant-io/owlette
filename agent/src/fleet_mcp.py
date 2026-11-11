"""
The owlette MCP server: lets an AI assistant on this machine act on its site.

A stdio server that an MCP client (Claude Code, for one) launches as the
logged-in user. It holds no credential of its own. While a site owner or site
admin grants this machine, the agent keeps a short-lived fleet session in
``<data root>/ipc/fleet/session.json``; this script reads that file fresh on
every request and sends its token only to the owlette API it names, and only
when that is an owlette API base.

The tool catalog and every result come from the server's fleet routes, so the
surface grows without an agent release. The one local tool, ``fleet_status``,
says whether there is a session and, when there is none, how to get one.

Never imports auth_manager or secure_storage and never refreshes anything: a
401 means read the file once more and retry, nothing else.
"""

import asyncio
import base64
import json
import logging
import math
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import quote, urlparse

import requests
from mcp import types
from mcp.server import Server
from mcp.server.stdio import stdio_server

import shared_utils

logger = logging.getLogger(__name__)


SESSION_FILE = 'session.json'
REQUEST_TIMEOUT_SECONDS = 30
MAX_IMAGE_BYTES = 5 * 1024 * 1024
IMAGE_CHUNK_BYTES = 64 * 1024
IMAGE_TYPES = ('image/png', 'image/jpeg', 'image/gif', 'image/webp')

# a started call is polled every second for its first 30 seconds, then every 3,
# until it ends or the timeoutSeconds the server gave it when it started (at
# most an hour) plus 30 have passed; 90 when the server gave none.
FAST_POLL_SECONDS = 30
FAST_POLL_INTERVAL = 1
SLOW_POLL_INTERVAL = 3
MAX_CALL_TIMEOUT_SECONDS = 3600
POLL_GRACE_SECONDS = 30
DEFAULT_POLL_SECONDS = 90
TERMINAL_STATUSES = ('completed', 'failed')

SESSION_FIELDS = ('token', 'apiBase', 'siteId', 'machineId')

NO_SESSION = (
    "no session: this machine may not act on its site. a site owner or site admin "
    "grants it in the site's settings, and the owlette agent on this machine then "
    "keeps a session for it."
)
NOT_OWLETTE = (
    "no session: the session file names a server that is not owlette ({host}), "
    "so it is ignored."
)

FLEET_STATUS_TOOL = {
    'name': 'fleet_status',
    'description': (
        'whether this machine may act on its owlette site: the site id, the machine '
        'id, the owlette server and when the session expires. with no session, says '
        'how a site owner or site admin grants one.'
    ),
    'inputSchema': {'type': 'object', 'properties': {}},
}


class NoSession(Exception):
    """There is no fleet session to send; the message says why."""


def session_path():
    """Where the agent keeps this machine's fleet session."""
    return os.path.join(shared_utils.get_data_path('ipc/fleet'), SESSION_FILE)


def read_session():
    """This machine's fleet session as (session, None), or (None, why) when
    there is none to use.

    A missing or unreadable file, a missing field, a token with whitespace or a
    control character in it, and an expiry that is not a finite time ahead all
    mean no session. So does an API base that is not owlette's: the token goes
    nowhere else.
    """
    try:
        with open(session_path(), encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None, NO_SESSION
    if not isinstance(data, dict) or not all(
        isinstance(data.get(field), str) and data[field] for field in SESSION_FIELDS
    ):
        return None, NO_SESSION
    # requests refuses such a header with an error that quotes its whole value
    token = data['token']
    if not token.isprintable() or any(c.isspace() for c in token):
        return None, NO_SESSION
    if not shared_utils.is_owlette_api_base(data['apiBase']):
        return None, NOT_OWLETTE.format(host=_host(data['apiBase']))
    expires_at = data.get('expiresAt')
    if (not _is_number(expires_at) or not math.isfinite(expires_at)
            or expires_at <= time.time()):
        return None, NO_SESSION
    return {
        'token': data['token'],
        'expiresAt': expires_at,
        'apiBase': data['apiBase'].rstrip('/'),
        'siteId': data['siteId'],
        'machineId': data['machineId'],
    }, None


def fetch_image(http, url):
    """An MCP image item for `url`, or a text item naming its host when it
    cannot be had.

    The URL is a signed read URL, so only its host is ever logged or shown, and
    it is fetched without the session token and without following a redirect.
    """
    host = _host(url)
    try:
        if urlparse(url).scheme != 'https':
            raise ValueError('not an https url')
        with http.get(url, timeout=REQUEST_TIMEOUT_SECONDS, stream=True, allow_redirects=False) as response:
            if response.status_code != 200:
                raise ValueError('not a 200')
            mime_type = response.headers.get('Content-Type', '').split(';')[0].strip().lower()
            if mime_type not in IMAGE_TYPES:
                raise ValueError('not an image type a client shows')
            data = bytearray()
            for chunk in response.iter_content(IMAGE_CHUNK_BYTES):
                data.extend(chunk)
                if len(data) > MAX_IMAGE_BYTES:
                    raise ValueError('larger than the image cap')
    except Exception as e:
        # the type only: a requests error's text carries the signed url
        logger.warning(f"Could not fetch an image from {host}: {type(e).__name__}")
        return _text(f'an image from {host} could not be fetched')
    return {
        'type': 'image',
        'data': base64.b64encode(bytes(data)).decode('ascii'),
        'mimeType': mime_type,
    }


class FleetClient:
    """The fleet routes, reached with whatever session the agent has written.

    `http` is a requests.Session-like object; `sleep` (async) and `clock` pace
    the poll of a started call. `last_refusal` is the problem text of the last
    non-2xx answer from any fleet route, cleared by the next 2xx.
    """

    def __init__(self, http=None, sleep=asyncio.sleep, clock=time.monotonic):
        self.http = http if http is not None else requests.Session()
        self.sleep = sleep
        self.clock = clock
        self.last_refusal = None

    def status(self):
        """What fleet_status reports: the session's site, machine, server and
        expiry, never its token, or why there is no session; and the server's
        last refusal, which says why the list holds no other tools."""
        session, why = read_session()
        if session is None:
            lines = [why]
        else:
            expires = datetime.fromtimestamp(session['expiresAt'], timezone.utc)
            lines = [
                'session: yes',
                f"site: {session['siteId']}",
                f"machine: {session['machineId']}",
                f"server: {_host(session['apiBase'])}",
                f"expires: {expires.strftime('%Y-%m-%d %H:%M:%S UTC')}",
            ]
        if self.last_refusal:
            lines.append(f'the server refused the last request: {self.last_refusal}')
        return '\n'.join(lines)

    async def list_tools(self):
        """fleet_status, then each well-formed tool of the server's catalog for
        this machine's grant when there is a session and the server answers."""
        tools = [FLEET_STATUS_TOOL]
        try:
            response = await asyncio.to_thread(self._send, 'GET', '/agent/fleet/tools')
        except NoSession:
            return tools
        except requests.RequestException as e:
            logger.warning(f"Could not list the fleet tools: {type(e).__name__}")
            return tools
        if response.status_code != 200:
            logger.warning(f"The fleet tools route refused: {_problem_text(response)}")
            return tools
        catalog = _json(response).get('tools')
        for entry in catalog if isinstance(catalog, list) else []:
            try:
                types.Tool.model_validate(entry)
            except ValueError:
                name = entry.get('name') if isinstance(entry, dict) else None
                logger.warning(f"Dropping a malformed fleet tool: {name if isinstance(name, str) else '(unnamed)'}")
                continue
            tools.append(entry)
        return tools

    async def call_tool(self, name, arguments):
        """Run one tool and return its result as a wire-shaped CallToolResult."""
        if name == FLEET_STATUS_TOOL['name']:
            return _result(self.status())
        arguments = arguments or {}
        try:
            response = await asyncio.to_thread(
                self._send, 'POST', '/agent/fleet/call',
                {'tool': name, 'params': arguments},
                {'Idempotency-Key': str(uuid.uuid4())},
            )
        except NoSession as e:
            return _result(str(e), error=True)
        except requests.RequestException as e:
            return _result(f'could not reach owlette: {type(e).__name__}', error=True)
        if response.status_code == 200:
            return await self._finish(_json(response))
        if response.status_code != 202:
            return _result(_problem_text(response), error=True)
        started = _json(response)
        call_id = started.get('callId')
        if not isinstance(call_id, str) or not call_id:
            return _result('owlette started the call but sent no call id', error=True)
        return await self._poll(call_id, _poll_bound(started))

    async def _poll(self, call_id, bound):
        """Read a started call until it ends or `bound` seconds pass."""
        path = '/agent/fleet/calls/' + quote(call_id, safe='')
        started = self.clock()
        while True:
            elapsed = self.clock() - started
            if elapsed >= bound:
                return _result(
                    f'the call was still running after {int(bound)} seconds; its result '
                    f'was not collected (call id {call_id})',
                    error=True,
                )
            await self.sleep(FAST_POLL_INTERVAL if elapsed < FAST_POLL_SECONDS else SLOW_POLL_INTERVAL)
            # a dropped, throttled or failed poll is no reason to give up on a
            # call that may still finish
            try:
                response = await asyncio.to_thread(self._send, 'GET', path)
            except NoSession as e:
                return _result(str(e), error=True)
            except requests.RequestException as e:
                logger.warning(f"Polling call {call_id} failed, trying again: {type(e).__name__}")
                continue
            if response.status_code == 429 or response.status_code >= 500:
                logger.warning(f"Polling call {call_id} answered {response.status_code}, trying again")
                continue
            if response.status_code == 404:
                return _result(f"the call's result could not be collected (call id {call_id})", error=True)
            if response.status_code != 200:
                return _result(_problem_text(response), error=True)
            body = _json(response)
            if body.get('status') in TERMINAL_STATUSES:
                return await self._finish(body)

    async def _finish(self, body):
        """A finished call's body as a CallToolResult: its content, led by its
        error when it failed."""
        items = body.get('content')
        content = [await self._content_item(item) for item in (items if isinstance(items, list) else [])]
        if body.get('status') != 'failed':
            return {'content': content, 'isError': False}
        error = body.get('error')
        if not isinstance(error, str) or not error:
            error = 'the call failed'
        return {'content': [_text(error)] + content, 'isError': True}

    async def _content_item(self, item):
        """One envelope item as MCP content: text as text, image_url fetched into
        an image, and a kind this script does not know as its text when it has
        some."""
        kind = item.get('type') if isinstance(item, dict) else None
        if kind == 'text':
            return _text(str(item.get('text', '')))
        if kind == 'image_url':
            return await asyncio.to_thread(fetch_image, self.http, item.get('url'))
        text = item.get('text') if isinstance(item, dict) else None
        if isinstance(text, str) and text:
            return _text(text)
        return _text(f'owlette sent content this script cannot show ({kind})')

    def _send(self, method, path, body=None, headers=None):
        """One request to a fleet route; on a 401, read the session file once
        more and retry. Keeps the answer's refusal, if any, in last_refusal.

        Raises NoSession when there is no session to send.
        """
        response = self._request(method, path, body, headers)
        if response.status_code == 401:
            # the agent may have rotated the session since this request read it
            response = self._request(method, path, body, headers)
        self.last_refusal = None if 200 <= response.status_code < 300 else _problem_text(response)
        return response

    def _request(self, method, path, body, headers):
        """One request carrying the session the file holds right now."""
        session, why = read_session()
        if session is None:
            raise NoSession(why)
        return self.http.request(
            method,
            session['apiBase'] + path,
            json=body,
            timeout=REQUEST_TIMEOUT_SECONDS,
            headers={
                **(headers or {}),
                'Authorization': f"Bearer {session['token']}",
                'User-Agent': _user_agent(session['machineId']),
            },
        )


def build_server(fleet):
    """The MCP server named owlette, serving `fleet`'s tools."""

    async def list_tools(ctx, params):
        return types.ListToolsResult.model_validate({'tools': await fleet.list_tools()})

    async def call_tool(ctx, params):
        return types.CallToolResult.model_validate(
            await fleet.call_tool(params.name, params.arguments)
        )

    return Server(
        'owlette',
        version=shared_utils.APP_VERSION,
        on_list_tools=list_tools,
        on_call_tool=call_tool,
    )


async def serve(server):
    """Run `server` over stdio until the client hangs up."""
    async with stdio_server() as (read_stream, write_stream):
        # mcp diverts fd 1 while serving, but a print buffered meanwhile would be
        # flushed onto the wire at exit, once mcp has handed fd 1 back (gate 0.2)
        sys.stdout = sys.stderr
        await server.run(read_stream, write_stream, server.create_initialization_options())


def main():
    """Entry point: log to stderr and serve the fleet tools over stdio."""
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format='%(asctime)s [%(levelname)s] %(message)s',
    )
    asyncio.run(serve(build_server(FleetClient())))


def _poll_bound(started):
    """How long to wait for a started call: the timeoutSeconds the server gave
    it, at most an hour, plus 30; else 90."""
    timeout = started.get('timeoutSeconds')
    if _is_number(timeout) and math.isfinite(timeout) and timeout > 0:
        return min(timeout, MAX_CALL_TIMEOUT_SECONDS) + POLL_GRACE_SECONDS
    return DEFAULT_POLL_SECONDS


def _is_number(value):
    """True for an int or a float, which JSON true and false are not."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _problem_text(response):
    """An RFC 7807 problem as '<code>: <detail>', falling back to the status."""
    body = _json(response)
    detail = body.get('detail') or body.get('title') or f'owlette answered HTTP {response.status_code}'
    code = body.get('code')
    return f'{code}: {detail}' if code else str(detail)


def _json(response):
    """A response's JSON object, or {} when it has none."""
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _host(url):
    """The host part of `url`, for messages that must not carry the rest."""
    try:
        host = urlparse(url).hostname if isinstance(url, str) else None
    except ValueError:
        host = None
    return host or 'an unknown host'


def _user_agent(machine_id):
    """The agent's User-Agent, as auth_manager sends it."""
    return f'Owlette-Agent/{shared_utils.APP_VERSION} ({shared_utils.get_os_family_arch()[0]}; {machine_id})'


def _text(text):
    """A text content item."""
    return {'type': 'text', 'text': text}


def _result(text, error=False):
    """A CallToolResult holding one text item."""
    return {'content': [_text(text)], 'isError': error}


if __name__ == '__main__':
    main()

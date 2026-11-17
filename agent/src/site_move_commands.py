"""
site_move_commands — the agent's half of moving a machine to another site.

An admin moves a paired machine from the admin panel, and nobody is at the
machine. The server cannot rebind it alone: the site lives in this machine's
config.json and token store, so the agent follows the move itself.

1. It learns the move's id from a `site_move` command, or, for a machine that
   was offline or whose command was swept, from `move` on `GET /api/agent/site`
   (the cloud client's move callback).
2. It asks for the new site's credentials with the refresh token it holds for
   the old one (`POST /api/agent/auth/move`). A refusal changes nothing here.
3. It ends hoot, which off Windows answers its end with an `offline` write on
   the old site's token, and the fleet session, then writes the new
   credentials and the move into the token store in one write, then the site
   into config.json.
4. The main loop sees the site change and rebuilds the cloud client on the new
   site, which confirms the move once it has connected
   (`POST /api/agent/auth/move/confirm`). Only then does the server clean the
   old site, so #326 removal detection never sees the config doc vanish under
   a client still bound to it.

A switch cut short between the token store and config.json is finished by
`reconcile`, which runs before a cloud client is built, and from the main
loop's site check while a config write the switch could not land is due.

The handler never completes its command once switched: the command lives on
the old site, whose writes stop being this machine's. The type rides the fast
lane (`firebase_client._FAST_COMMAND_TYPES`), and one follow runs at a time.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

import requests

import configure_site
import shared_utils
from command_router import COMMAND_DEFERRED, CommandRouter
from connection_manager import ConnectionState

logger = logging.getLogger(__name__)

_REQUEST_TIMEOUT_SECONDS = 30

# a config.json held open (an editor, a scan) is usually free again within a
# second or two: the switch asks again on its own thread before it leaves the
# write to the main loop
CONFIG_WRITE_ATTEMPTS = 3
CONFIG_WRITE_RETRY_SECONDS = 0.5

_follow_lock = threading.Lock()
_confirm_lock = threading.Lock()

# set while a switch is in the token store but not in config.json
_reconcile_due = threading.Event()


def reconcile_due() -> bool:
    """True while a switch could not name its site in config.json: the main
    loop's site check calls reconcile until it lands."""
    return _reconcile_due.is_set()


def register_handlers(router: CommandRouter) -> None:
    """register the move handler on the given CommandRouter, once at init."""
    router.register("site_move")(handle_site_move)
    logger.info("site_move_commands: registered handler — site_move")


def handle_site_move(cmd_data: dict, cmd_id: str, service: Any):
    """follow the move the command names; see follow_move for what it returns."""
    move_id = cmd_data.get('moveId')
    if not move_id:
        return "Error: site_move carries no moveId"
    return follow_move(service, move_id)


def follow_in_background(service: Any, move_id: str) -> None:
    """the cloud client's move callback. it runs on the thread that read the
    site projection, which the follow must not hold."""
    threading.Thread(
        target=follow_move, args=(service, move_id), daemon=True, name='site-move',
    ).start()


def follow_move(service: Any, move_id: str):
    """Switch this machine to the site the move takes it to.

    Returns COMMAND_DEFERRED once the credentials are switched, and while
    another follow runs or this move is already followed, since either of those
    owns the outcome. Returns an `Error:` string when nothing was changed: the
    server refused, could not be asked, or the credentials could not be saved.
    """
    client = getattr(service, 'firebase_client', None)
    if client is None:
        return "Error: firebase client unavailable; cannot follow the move"

    if not _follow_lock.acquire(blocking=False):
        logger.info(f"site move {move_id}: a follow is already running")
        return COMMAND_DEFERRED
    try:
        return _follow(service, client, move_id)
    finally:
        _follow_lock.release()


def _follow(service: Any, client: Any, move_id: str):
    auth = client.auth_manager
    storage = auth.storage
    if (storage.get_move() or {}).get('moveId') == move_id:
        logger.info(f"site move {move_id}: already switched; the new site's client confirms it")
        return COMMAND_DEFERRED

    source = storage.get_site_id()
    credentials, refusal = _fetch_credentials(auth, move_id)
    if refusal:
        logger.warning(f"site move {move_id}: {refusal}; staying on {source}")
        return f"Error: {refusal}"
    target = credentials['siteId']

    # hoot's last write must go out on the old site's token first, and no
    # relaunch may read the old site before config.json names the new one
    service.end_hoot("this machine is moving to another site", wait=True)
    service.fleet_session.withdraw(forget=True)

    move = {'moveId': move_id, 'phase': 'switched', 'source': source, 'target': target}
    expiry = time.time() + float(credentials.get('expiresIn', 3600))
    if not auth.adopt_move_credentials(
            credentials['refreshToken'], credentials['accessToken'], expiry, target, move):
        logger.error(f"site move {move_id}: the new site's credentials could not be saved; staying on {source}")
        return "Error: the new site's credentials could not be saved"

    try:
        _point_config_at_patiently(target)
    except Exception as e:
        # until then the old client keeps the old site, which refuses the new
        # site's token
        _reconcile_due.set()
        logger.error(
            f"site move {move_id}: config.json still names {source} ({e}); "
            f"the main loop finishes the switch")
        return COMMAND_DEFERRED

    logger.info(f"site move {move_id}: switched from {source} to {target}")
    return COMMAND_DEFERRED


def _fetch_credentials(auth: Any, move_id: str):
    """(the server's answer, None) when it minted the new site's credentials,
    else (None, why it did not)."""
    stored = auth.storage.get_refresh_token()
    if not stored:
        return None, "this machine holds no credential to move with"

    try:
        response = requests.post(
            f"{auth.api_base}/agent/auth/move",
            json={'refreshToken': stored, 'machineId': auth.machine_id, 'moveId': move_id},
            headers=_headers(auth),
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )
    except requests.exceptions.RequestException as e:
        return None, f"could not reach the server: {e}"

    if response.status_code != 200:
        return None, f"the server refused the move (HTTP {response.status_code}{_reason(response)})"

    try:
        answer = response.json()
    except ValueError:
        return None, "the server's answer was not JSON"
    if not isinstance(answer, dict) or not all(
            answer.get(key) for key in ('accessToken', 'refreshToken', 'siteId')):
        return None, "the server's answer did not carry the new site's credentials"
    return answer, None


def _reason(response: Any) -> str:
    """': <the server's reason>' from a refusal's body, or ''."""
    try:
        body = response.json()
    except ValueError:
        return ''
    if not isinstance(body, dict):
        return ''
    reason = body.get('error') or body.get('code')
    return f": {reason}" if isinstance(reason, str) and reason else ''


def _headers(auth: Any) -> dict:
    """the headers the token refresh sends."""
    return {
        'User-Agent': (f'Owlette-Agent/{shared_utils.APP_VERSION} '
                       f'({shared_utils.get_os_family_arch()[0]}; {auth.machine_id})'),
        'X-Owlette-Agent-Version': shared_utils.APP_VERSION,
        'Content-Type': 'application/json',
    }


def _point_config_at_patiently(target: str) -> None:
    """_point_config_at, asked again a few times a moment apart. Never on the
    main loop: it sleeps. Raises the last attempt's error."""
    for attempt in range(1, CONFIG_WRITE_ATTEMPTS + 1):
        try:
            _point_config_at(target)
            return
        except Exception:
            if attempt == CONFIG_WRITE_ATTEMPTS:
                raise
            time.sleep(CONFIG_WRITE_RETRY_SECONDS * attempt)


def _point_config_at(target: str) -> None:
    """name the new site in config.json, which the main loop answers by
    rebuilding the cloud client there. the cached cloud config goes too: the
    service prefers it, and it holds the old site's."""
    shared_utils.write_config(['firebase', 'site_id'], target)
    try:
        configure_site._drop_cloud_cache()
    except OSError as e:
        logger.warning(f"site move: could not delete the cached cloud config (non-critical): {e}")


def confirm_on_connect(client: Any) -> None:
    """Confirm a switched move each time this client connects.

    Called after the client's start(), which writes its presence and first
    metrics, so the new site has the machine before the old one loses it. The
    client connects in its constructor, before any listener exists, so the
    state it has already reached counts as a connect. A confirm that fails is
    asked again on the next connect.
    """
    manager = client.connection_manager

    def on_change(event):
        if event.new_state == ConnectionState.CONNECTED:
            _confirm_in_background(client)

    manager.add_state_listener(on_change)
    if manager.state == ConnectionState.CONNECTED:
        _confirm_in_background(client)


def _confirm_in_background(client: Any) -> None:
    """connection listeners run synchronously; the confirm is a round trip."""
    threading.Thread(
        target=confirm_if_switched, args=(client,), daemon=True, name='site-move-confirm',
    ).start()


def confirm_if_switched(client: Any) -> None:
    """tell the server this machine arrived, if a switched move names the
    client's site as its target. one confirm at a time."""
    if not _confirm_lock.acquire(blocking=False):
        return
    try:
        _confirm(client)
    except Exception as e:
        logger.error(f"site move: the confirm failed, asking again on the next connect: {e}")
    finally:
        _confirm_lock.release()


def _confirm(client: Any) -> None:
    from auth_manager import AuthenticationError, TokenRefreshError

    auth = client.auth_manager
    move = auth.storage.get_move()
    if not move or move.get('phase') != 'switched' or move.get('target') != client.site_id:
        return
    move_id = move.get('moveId')

    try:
        credential = auth.get_valid_token()
        response = requests.post(
            f"{auth.api_base}/agent/auth/move/confirm",
            json={'machineId': auth.machine_id, 'moveId': move_id},
            headers={**_headers(auth), 'Authorization': f'Bearer {credential}'},
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )
    except (AuthenticationError, TokenRefreshError, requests.exceptions.RequestException) as e:
        logger.warning(f"site move {move_id}: could not confirm, asking again on the next connect: {e}")
        return

    # 404 is a confirm whose answer was lost, a cancel, or a removal: done either way
    if response.status_code not in (200, 404):
        logger.warning(
            f"site move {move_id}: the confirm was refused (HTTP {response.status_code}"
            f"{_reason(response)}); asking again on the next connect")
        return
    if auth.finish_move():
        logger.info(f"site move {move_id}: confirmed on {client.site_id}")
    else:
        logger.warning(f"site move {move_id}: confirmed, but the stored move could not be cleared")


def reconcile() -> None:
    """Finish a switch cut short between the token store and config.json, by a
    crash or by a config write that would not land.

    Runs before a cloud client is built, and from the main loop's site check
    while reconcile_due(); one attempt, no waits. It acts only when the stored
    move's target is the site the stored credentials are for: a pairing made
    since then wins over a move it left behind. A failure leaves it due.
    Never raises.
    """
    try:
        _finish_switch()
    except Exception as e:
        _reconcile_due.set()
        logger.error(f"site move: could not finish an interrupted switch: {e}")
    else:
        _reconcile_due.clear()


def _finish_switch() -> None:
    import secure_storage

    storage = secure_storage.get_storage()
    move = storage.get_move()
    if not move or move.get('phase') != 'switched':
        return
    target = move.get('target')
    if not target or target != storage.get_site_id():
        return
    if shared_utils.read_config(['firebase', 'site_id']) == target:
        return
    logger.warning(f"site move {move.get('moveId')}: config.json still names the old site; pointing it at {target}")
    _point_config_at(target)

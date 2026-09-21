"""
Owlette Cortex — Local AI Agent Process.

The third agent process (alongside the service and the desktop app). Runs in
the user session, launched by the service via CreateProcessAsUser.

Handles two modes:
  1. User Chat — polls Firestore for pending messages, runs Agent SDK, streams responses
  2. Autonomous — picks up IPC event files from the service, investigates locally

Uses Claude Agent SDK with local MCP tools (no Firestore relay for tool calls).
"""

import asyncio
import json
import logging
import os
import signal
import socket
import sys
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import shared_utils

# ─── Logging ──────────────────────────────────────────────────────────────────

LOG_DIR = shared_utils.get_data_path('logs')
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    handlers=[
        RotatingFileHandler(
            os.path.join(LOG_DIR, 'cortex.log'),
            maxBytes=2 * 1024 * 1024,  # 2 MB
            backupCount=3,
            encoding='utf-8',
        ),
    ],
)
logger = logging.getLogger('cortex')

# ─── Constants ────────────────────────────────────────────────────────────────

PID_PATH = shared_utils.get_data_path('tmp/cortex.pid')
IPC_EVENTS_DIR = shared_utils.get_data_path('ipc/cortex_events')
MAIN_LOOP_INTERVAL = 1.5  # seconds
HEARTBEAT_INTERVAL = 10.0  # seconds between heartbeats
MAX_CONCURRENT_INVESTIGATIONS = 3
MAX_EVENTS_PER_HOUR = 10
DEDUP_COOLDOWN_SECONDS = 15 * 60  # 15 minutes
MAX_BUDGET_USD = 2.0
MAX_TURNS = 15

DEFAULT_DIRECTIVE = (
    'Keep all configured processes running and machines operational. '
    'When a process crashes, check agent logs and system event logs for errors, '
    'restart the process. If a restart fails twice, escalate to site admins.'
)


# ─── Singleton Enforcement ────────────────────────────────────────────────────

def write_pid_file():
    """Write our PID to the pid file for the service to monitor."""
    os.makedirs(os.path.dirname(PID_PATH), exist_ok=True)
    with open(PID_PATH, 'w') as f:
        f.write(str(os.getpid()))
    logger.info(f"PID file written: {PID_PATH} (pid={os.getpid()})")


def remove_pid_file():
    """Clean up PID file on shutdown."""
    try:
        if os.path.exists(PID_PATH):
            os.remove(PID_PATH)
            logger.debug("PID file removed")
    except OSError:
        pass


def check_singleton() -> bool:
    """Check if another Cortex instance is already running.

    Returns True if we can proceed, False if another instance is alive.
    """
    if not os.path.exists(PID_PATH):
        return True

    try:
        with open(PID_PATH, 'r') as f:
            old_pid = int(f.read().strip())

        import psutil
        try:
            proc = psutil.Process(old_pid)
            if proc.is_running() and proc.status() != 'zombie':
                cmdline = ' '.join(proc.cmdline()).lower()
                if 'owlette_cortex' in cmdline:
                    logger.warning(f"Another Cortex instance is running (PID {old_pid})")
                    return False
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass  # Stale PID file — safe to proceed
    except (ValueError, OSError):
        pass  # Corrupt PID file — safe to proceed

    return True


# ─── API Key Management ──────────────────────────────────────────────────────

def get_cortex_api_key(config: dict) -> Optional[str]:
    """Retrieve the decrypted LLM API key for Cortex.

    The key is stored encrypted in config.json under cortex.apiKeyEncrypted,
    encrypted with the machine-specific Fernet cipher from SecureStorage.

    Returns:
        Decrypted API key string, or None if not provisioned.
    """
    encrypted = config.get('cortex', {}).get('apiKeyEncrypted')
    if not encrypted:
        return None

    try:
        from secure_storage import get_storage
        storage = get_storage()
        return storage._fernet.decrypt(encrypted.encode('utf-8')).decode('utf-8')
    except Exception as e:
        logger.error(f"Failed to decrypt Cortex API key: {e}")
        return None


# ─── Guardrails ───────────────────────────────────────────────────────────────

class AutoGuardrails:
    """Rate limiting and dedup for autonomous investigations."""

    def __init__(self):
        self._recent_events: Dict[str, float] = {}  # key -> timestamp
        self._active_count = 0
        self._hourly_events: List[float] = []

    def passes(self, event: Dict[str, Any]) -> bool:
        """Check if an autonomous event should be processed.

        Args:
            event: Event dict with processName, eventType, machineId.

        Returns:
            True if the event passes all guardrails.
        """
        now = time.time()

        if self._active_count >= MAX_CONCURRENT_INVESTIGATIONS:
            logger.info("Guardrail: max concurrent investigations reached")
            return False

        self._hourly_events = [t for t in self._hourly_events if now - t < 3600]
        if len(self._hourly_events) >= MAX_EVENTS_PER_HOUR:
            logger.info("Guardrail: hourly event rate limit reached")
            return False

        # Prune stale dedup entries — the map is otherwise unbounded.
        stale_keys = [k for k, t in self._recent_events.items() if now - t > DEDUP_COOLDOWN_SECONDS]
        for k in stale_keys:
            del self._recent_events[k]

        # Dedup: same machine + process within the cooldown.
        dedup_key = f"{event.get('machineId', '')}:{event.get('processName', '')}"
        last_time = self._recent_events.get(dedup_key, 0)
        if now - last_time < DEDUP_COOLDOWN_SECONDS:
            logger.info(f"Guardrail: dedup cooldown for {dedup_key}")
            return False

        return True

    def begin(self, event: Dict[str, Any]):
        """Mark the start of an investigation."""
        self._active_count += 1
        self._hourly_events.append(time.time())
        dedup_key = f"{event.get('machineId', '')}:{event.get('processName', '')}"
        self._recent_events[dedup_key] = time.time()

    def end(self):
        """Mark the end of an investigation."""
        self._active_count = max(0, self._active_count - 1)


# ─── Chat Handler ─────────────────────────────────────────────────────────────

async def handle_chat_message(
    message: Dict[str, Any],
    options,
    firestore,
):
    """Handle a user chat message via Agent SDK.

    Args:
        message: Dict with 'content', 'chatId', 'messages', 'machineName'.
        options: ClaudeAgentOptions for the Agent SDK.
        firestore: CortexFirestore instance.
    """
    from claude_agent_sdk import ClaudeSDKClient, AssistantMessage, TextBlock

    firestore.set_status('processing')
    firestore.write_cortex_status('thinking')

    chat_id = message.get('chatId', '')
    user_content = message.get('content', '')
    images = message.get('images', [])
    machine_name = message.get('machineName', socket.gethostname())

    logger.info(f"Processing chat message: chatId={chat_id}, len={len(user_content)}, images={len(images)}")

    # query() takes a str for text, but multimodal needs structured content
    # blocks sent through the streaming message format.
    if images:
        content_blocks = []
        if user_content:
            content_blocks.append({"type": "text", "text": user_content})
        for img in images:
            url = img.get("url", "")
            media_type = img.get("mediaType", "image/jpeg")
            if url:
                content_blocks.append({
                    "type": "image",
                    "source": {"type": "url", "url": url, "media_type": media_type},
                })
        multimodal_content = content_blocks if content_blocks else user_content
    else:
        multimodal_content = None

    start_time = time.time()
    full_response = ''
    parts = []

    try:
        async with ClaudeSDKClient(options=options) as client:
            if multimodal_content is not None:
                async def _image_message():
                    yield {
                        "type": "user",
                        "message": {"role": "user", "content": multimodal_content},
                        "parent_tool_use_id": None,
                        "session_id": "default",
                    }
                await client.query(_image_message())
            else:
                await client.query(user_content)

            async for msg in client.receive_response():
                if isinstance(msg, AssistantMessage):
                    for block in msg.content:
                        if isinstance(block, TextBlock):
                            full_response += block.text
                            parts.append({'type': 'text', 'text': block.text})
                            firestore.write_response_chunk(full_response, parts)
                            firestore.write_cortex_status('thinking')
                        else:
                            block_dict = block.__dict__ if hasattr(block, '__dict__') else {'type': 'unknown'}
                            parts.append(block_dict)
                            firestore.write_cortex_status('tool_call')

        duration_ms = int((time.time() - start_time) * 1000)
        firestore.write_final_response(
            content=full_response,
            parts=parts,
            metadata={'durationMs': duration_ms, 'chatId': chat_id},
        )
        firestore.write_cortex_status('idle')
        logger.info(f"Chat response complete: {duration_ms}ms, {len(full_response)} chars")

    except Exception as e:
        logger.error(f"Chat handler error: {e}")
        firestore.write_error_response(str(e))
        firestore.write_cortex_status('error')


# ─── Autonomous Handler ──────────────────────────────────────────────────────

def build_autonomous_prompt(event: Dict[str, Any], config: dict) -> str:
    """Build the autonomous investigation prompt from event context."""
    directive = config.get('cortex', {}).get('directive', '') or DEFAULT_DIRECTIVE
    process_name = event.get('processName', 'Unknown')
    event_type = event.get('eventType', 'process_crash')
    error_message = event.get('errorMessage', 'No details available')
    machine_name = event.get('machineName', socket.gethostname())

    action = 'crashed' if event_type == 'process_crash' else 'failed to start'

    return (
        f'You are Owlette Cortex operating in AUTONOMOUS mode. You have been triggered '
        f'by a system alert — no human initiated this conversation.\n\n'
        f'YOUR DIRECTIVE: {directive}\n\n'
        f'CURRENT EVENT:\n'
        f'Process "{process_name}" {action} on machine "{machine_name}".\n'
        f'Error: {error_message}\n\n'
        f'RULES:\n'
        f'1. INVESTIGATE FIRST — check agent logs and process status before acting\n'
        f'2. RESTART LIMIT — max 2 restarts for the same process in this session\n'
        f'3. ESCALATE — if unresolved after investigation + restarts, say "ESCALATION NEEDED"\n'
        f'4. BE EFFICIENT — minimize tool calls, focus on the specific issue\n'
        f'5. ALWAYS SUMMARIZE:\n'
        f'   - ISSUE: what happened\n'
        f'   - INVESTIGATION: what you found\n'
        f'   - ACTION: what you did\n'
        f'   - OUTCOME: resolved / escalated / needs attention\n'
        f'6. VISUAL VERIFICATION — after restarting a display or media process, '
        f'capture a screenshot to verify visual recovery. Report what you see. '
        f'Skip for non-display services.'
    )


async def handle_autonomous_event(
    event: Dict[str, Any],
    options,
    firestore,
    guardrails: AutoGuardrails,
    config: dict,
):
    """Handle an autonomous investigation triggered by a process event.

    Args:
        event: Event dict from IPC file.
        options: ClaudeAgentOptions for the Agent SDK.
        firestore: CortexFirestore instance.
        guardrails: AutoGuardrails instance.
        config: Agent config dict.
    """
    from claude_agent_sdk import ClaudeSDKClient, AssistantMessage, TextBlock

    process_name = event.get('processName', 'Unknown')
    event_type = event.get('eventType', 'process_crash')
    event_id = f"auto_{int(time.time()*1000)}_{socket.gethostname()}"

    logger.info(f"Autonomous investigation started: {process_name} ({event_type})")

    guardrails.begin(event)
    firestore.write_cortex_status('thinking')

    firestore.write_autonomous_event(event_id, {
        'machineName': event.get('machineName', socket.gethostname()),
        'processName': process_name,
        'eventType': event_type,
        'errorMessage': event.get('errorMessage', ''),
        'status': 'investigating',
        'chatId': event_id,
        'actions': [],
    })

    prompt = build_autonomous_prompt(event, config)
    start_time = time.time()
    full_response = ''
    actions = []

    try:
        async with ClaudeSDKClient(options=options) as client:
            await client.query(prompt)

            async for msg in client.receive_response():
                if isinstance(msg, AssistantMessage):
                    for block in msg.content:
                        if isinstance(block, TextBlock):
                            full_response += block.text
                        else:
                            # Audit trail for the event.
                            block_dict = block.__dict__ if hasattr(block, '__dict__') else {}
                            if hasattr(block, 'name'):
                                actions.append({
                                    'tool': block.name,
                                    'timestamp': time.time(),
                                })

        duration_ms = int((time.time() - start_time) * 1000)
        needs_escalation = 'ESCALATION NEEDED' in full_response.upper()
        status = 'escalated' if needs_escalation else 'resolved'

        firestore.write_autonomous_event(event_id, {
            'machineName': event.get('machineName', socket.gethostname()),
            'processName': process_name,
            'eventType': event_type,
            'errorMessage': event.get('errorMessage', ''),
            'status': status,
            'chatId': event_id,
            'summary': full_response[-500:] if full_response else '',
            'actions': actions,
            'durationMs': duration_ms,
        })

        if needs_escalation:
            firestore.write_escalation_flag(event_id)
            logger.warning(f"Autonomous investigation escalated: {process_name}")
        else:
            logger.info(f"Autonomous investigation resolved: {process_name} ({duration_ms}ms)")

    except Exception as e:
        logger.error(f"Autonomous investigation error: {e}")
        firestore.write_autonomous_event(event_id, {
            'machineName': event.get('machineName', socket.gethostname()),
            'processName': process_name,
            'eventType': event_type,
            'errorMessage': event.get('errorMessage', ''),
            'status': 'failed',
            'chatId': event_id,
            'summary': f'Investigation failed: {e}',
            'actions': actions,
        })
    finally:
        guardrails.end()
        firestore.write_cortex_status('idle')


# ─── IPC Event Scanner ────────────────────────────────────────────────────────

def check_ipc_events() -> Optional[Dict[str, Any]]:
    """Check for autonomous event files written by the service.

    Returns the oldest unprocessed event, or None.
    """
    if not os.path.isdir(IPC_EVENTS_DIR):
        return None

    try:
        files = sorted(f for f in os.listdir(IPC_EVENTS_DIR) if f.endswith('.json'))
        if not files:
            return None

        event_path = os.path.join(IPC_EVENTS_DIR, files[0])
        try:
            with open(event_path, 'r', encoding='utf-8') as f:
                event = json.load(f)
            os.remove(event_path)
            return event
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"Failed to read IPC event {files[0]}: {e}")
            # Delete corrupt files — otherwise they are retried forever.
            try:
                os.remove(event_path)
            except OSError:
                pass
            return None
    except OSError:
        return None


# ─── Main Loop ────────────────────────────────────────────────────────────────

shutdown_requested = False


def _signal_handler(signum, frame):
    """Handle shutdown signals gracefully."""
    global shutdown_requested
    logger.info(f"Shutdown signal received (signal {signum})")
    shutdown_requested = True


async def main():
    """Main Cortex event loop."""
    global shutdown_requested

    logger.info("=" * 60)
    logger.info("Owlette Cortex starting...")
    logger.info(f"Version: {shared_utils.get_app_version()}")
    logger.info(f"PID: {os.getpid()}")
    logger.info("=" * 60)

    if not check_singleton():
        logger.error("Another Cortex instance is running — exiting")
        return

    write_pid_file()

    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)

    config = shared_utils.read_config()
    if not config:
        logger.error("Failed to read agent config — exiting")
        remove_pid_file()
        return

    if not config.get('cortex', {}).get('enabled', False):
        logger.info("Cortex is disabled in config — exiting")
        remove_pid_file()
        return

    api_key = get_cortex_api_key(config)
    if not api_key:
        logger.error("No Cortex API key provisioned — exiting")
        logger.error("Provision a key via the web dashboard (Settings → Cortex)")
        remove_pid_file()
        return

    os.environ['ANTHROPIC_API_KEY'] = api_key

    site_id = config.get('firebase', {}).get('site_id', '')
    project_id = config.get('firebase', {}).get('project_id') or shared_utils.get_project_id()
    machine_id = socket.gethostname()

    if not site_id:
        logger.error("No site_id in config — exiting")
        remove_pid_file()
        return

    # Auth manager + Firestore client, as in firebase_client.py.
    from auth_manager import AuthManager
    api_base = shared_utils.get_configured_api_base(config)
    auth_manager = AuthManager(api_base=api_base)

    if not auth_manager.is_authenticated():
        logger.error("Agent not authenticated — exiting")
        remove_pid_file()
        return

    from firestore_rest_client import FirestoreRestClient
    db = FirestoreRestClient(project_id=project_id, auth_manager=auth_manager)

    from cortex_firestore import CortexFirestore
    firestore = CortexFirestore(db=db, site_id=site_id, machine_id=machine_id)

    # The installer ships the Agent SDK without its 241.5 MB bundled binary, so
    # the CLI is downloaded and sha256-verified on first enable. None means no
    # usable CLI — exit cleanly rather than crash-loop under the service.
    import cortex_cli_fetch
    cli_path = cortex_cli_fetch.ensure_cli(db)
    if not cli_path:
        logger.error("Claude Code CLI unavailable — exiting")
        firestore.write_cortex_error(
            'claude code cli could not be downloaded — check network access and retry'
        )
        remove_pid_file()
        return

    import cortex_tools
    max_tier = config.get('cortex', {}).get('maxTier', 2)
    owlette_server = cortex_tools.create_owlette_mcp_server(config, max_tier=max_tier)

    from claude_agent_sdk import ClaudeAgentOptions
    # agent root (parent of src/) — where CLAUDE.md lives
    agent_cwd = str(Path(__file__).parent.parent)

    options = ClaudeAgentOptions(
        mcp_servers={"owlette": owlette_server},
        allowed_tools=["mcp__owlette__*"],
        setting_sources=["project"],
        cwd=agent_cwd,
        # Set explicitly: subprocess_cli.py only calls _find_cli when it is None.
        cli_path=cli_path,
        permission_mode="acceptEdits",
        max_turns=MAX_TURNS,
        max_budget_usd=MAX_BUDGET_USD,
    )

    guardrails = AutoGuardrails()
    autonomous_enabled = config.get('cortex', {}).get('autonomousEnabled', False)

    firestore.write_cortex_heartbeat()
    firestore.write_cortex_status('idle')
    logger.info("Cortex online and ready")

    # ─── Main Loop ────────────────────────────────────────────────────────
    last_heartbeat = time.time()

    try:
        while not shutdown_requested:
            now = time.time()

            if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                firestore.write_cortex_heartbeat()
                last_heartbeat = now

            # Hot-reload of cortex settings.
            config = shared_utils.read_config() or config
            autonomous_enabled = config.get('cortex', {}).get('autonomousEnabled', False)

            try:
                message = firestore.poll_for_messages()
                if message:
                    await handle_chat_message(message, options, firestore)
            except Exception as e:
                logger.error(f"Chat polling error: {e}")

            if autonomous_enabled:
                try:
                    event = check_ipc_events()
                    if event and guardrails.passes(event):
                        await handle_autonomous_event(
                            event, options, firestore, guardrails, config
                        )
                except Exception as e:
                    logger.error(f"Autonomous event error: {e}")

            await asyncio.sleep(MAIN_LOOP_INTERVAL)

    except Exception as e:
        logger.error(f"Main loop error: {e}")
    finally:
        logger.info("Cortex shutting down...")
        firestore.write_cortex_offline()
        remove_pid_file()
        logger.info("Cortex shutdown complete")


if __name__ == '__main__':
    asyncio.run(main())

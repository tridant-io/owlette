"""
MCP Tool wrappers for Owlette Cortex (Agent SDK).

Wraps tools from mcp_tools.py as Agent SDK @tool() decorated functions. Tier 1
and Tier 3 tools execute directly. Tier 2 tools use file-based IPC to the service
(Cortex runs in user session, service runs as SYSTEM).

Nobody can approve a call here, so no tool changes what the machine launches or
runs code: those wait for a person in a dashboard chat.

IPC protocol:
  Cortex writes -> ipc/cortex_commands/{cmd_id}.json
  Service reads, executes, writes -> ipc/cortex_results/{cmd_id}.json
  Cortex polls for result (sub-second latency)
"""

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Any

from claude_agent_sdk import tool, create_sdk_mcp_server

import mcp_tools
import shared_utils

logger = logging.getLogger(__name__)

# IPC directories, created by shared_utils constants
IPC_CMD_DIR = shared_utils.get_data_path('ipc/cortex_commands')
IPC_RESULT_DIR = shared_utils.get_data_path('ipc/cortex_results')

IPC_POLL_INTERVAL = 0.2  # seconds
IPC_TIMEOUT = 30  # seconds


# IPC helpers


def _ensure_ipc_dirs():
    """Ensure IPC directories exist and clean up stale files."""
    os.makedirs(IPC_CMD_DIR, exist_ok=True)
    os.makedirs(IPC_RESULT_DIR, exist_ok=True)
    _cleanup_stale_ipc_files()


def _cleanup_stale_ipc_files():
    """Remove IPC command and result files older than 120 seconds."""
    cutoff = time.time() - 120
    for ipc_dir in (IPC_CMD_DIR, IPC_RESULT_DIR):
        try:
            for filename in os.listdir(ipc_dir):
                filepath = os.path.join(ipc_dir, filename)
                try:
                    if os.path.isfile(filepath) and os.path.getmtime(filepath) < cutoff:
                        os.remove(filepath)
                except OSError:
                    pass
        except OSError:
            pass


def _write_ipc_command(tool_name: str, tool_params: dict) -> str:
    """Write a command file for the service to pick up.

    Returns the command ID for polling the result.
    """
    _ensure_ipc_dirs()
    cmd_id = f"ctx_{int(time.time()*1000)}_{uuid.uuid4().hex[:6]}"
    cmd_path = os.path.join(IPC_CMD_DIR, f"{cmd_id}.json")

    payload = {
        'id': cmd_id,
        'tool_name': tool_name,
        'tool_params': tool_params,
        'timestamp': time.time(),
    }

    # Atomic: write tmp, then rename.
    tmp_path = cmd_path + '.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(payload, f)
    os.replace(tmp_path, cmd_path)

    logger.debug(f"IPC command written: {cmd_id} ({tool_name})")
    return cmd_id


def _poll_ipc_result(cmd_id: str, timeout: float = IPC_TIMEOUT) -> dict:
    """Poll for the result of an IPC command.

    Returns the result dict or an error dict if timed out.
    """
    result_path = os.path.join(IPC_RESULT_DIR, f"{cmd_id}.json")
    start = time.time()

    while time.time() - start < timeout:
        if os.path.exists(result_path):
            try:
                with open(result_path, 'r', encoding='utf-8') as f:
                    result = json.load(f)
                try:
                    os.remove(result_path)
                except OSError:
                    pass
                logger.debug(f"IPC result received: {cmd_id}")
                return result.get('result', result)
            except (json.JSONDecodeError, OSError) as e:
                logger.warning(f"IPC result read error for {cmd_id}: {e}")
                # Possibly mid-write; retry.
        time.sleep(IPC_POLL_INTERVAL)

    logger.warning(f"IPC command timed out: {cmd_id}")
    return {'error': f'IPC command timed out after {timeout}s'}


def _format_result(result: dict) -> dict:
    """Format a tool result for the Agent SDK MCP protocol."""
    text = json.dumps(result, indent=2, default=str)
    return {"content": [{"type": "text", "text": text}]}


def _execute_direct_sync(tool_name: str, params: dict, config: dict) -> dict:
    """Execute a tool directly via mcp_tools and format the result (sync)."""
    result = mcp_tools.execute_tool(tool_name, params, config)
    return _format_result(result)


def _execute_via_ipc_sync(tool_name: str, params: dict) -> dict:
    """Execute a tool via IPC to the service and format the result (sync)."""
    cmd_id = _write_ipc_command(tool_name, params)
    result = _poll_ipc_result(cmd_id)
    return _format_result(result)


def _execute_via_ipc_sync_raw(
    tool_name: str, params: dict, timeout: float = IPC_TIMEOUT
) -> dict:
    """Execute a tool via IPC and return the raw result dict (no MCP formatting).

    `timeout` exists for capture_screenshot, which genuinely takes ~55s (a
    user-session poll plus the upload POST) and so cannot finish inside the
    30s default. Keep any override under the 120s stale-file cutoff in
    _cleanup_stale_ipc_files, or a live command is reaped out from under itself.
    """
    cmd_id = _write_ipc_command(tool_name, params)
    return _poll_ipc_result(cmd_id, timeout=timeout)


async def _execute_direct(tool_name: str, params: dict, config: dict) -> dict:
    """Execute a tool directly — runs in a thread to avoid blocking the event loop."""
    return await asyncio.to_thread(_execute_direct_sync, tool_name, params, config)


async def _execute_via_ipc(tool_name: str, params: dict) -> dict:
    """Execute a tool via IPC — runs in a thread to avoid blocking the event loop."""
    return await asyncio.to_thread(_execute_via_ipc_sync, tool_name, params)


# Tier 1: read-only tools, executed directly


def _make_tier1_tools(config: dict) -> list:
    """Create Tier 1 tool functions with config bound."""

    @tool("get_system_info",
          "Get comprehensive system information: hostname, OS, CPU, memory, disk, GPU, VRAM, uptime, agent version.",
          {})
    async def get_system_info(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_direct('get_system_info', args, config)

    @tool("get_process_list",
          "Get all Owlette-configured processes with status, PID, autolaunch setting, and running state.",
          {})
    async def get_process_list(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_direct('get_process_list', args, config)

    @tool("get_running_processes",
          "Get all running OS processes with CPU and memory usage. Filter by name, sorted by memory.",
          {"name_filter": str, "limit": int})
    async def get_running_processes(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_direct('get_running_processes', args, config)

    @tool("get_gpu_processes",
          "Get per-process GPU memory (VRAM) usage — dedicated and shared, sorted by usage. Cross-vendor (NVIDIA, AMD, Intel). Uses Windows Performance Counters (same source as Task Manager).",
          {})
    async def get_gpu_processes(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_direct('get_gpu_processes', args, config)

    @tool("get_network_info",
          "Get network interfaces with IP addresses, netmasks, and link status.",
          {})
    async def get_network_info(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_direct('get_network_info', args, config)

    @tool("get_disk_usage",
          "Get disk usage for all drives including total, used, free space and percentage.",
          {})
    async def get_disk_usage(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_direct('get_disk_usage', args, config)

    @tool("get_event_logs",
          "Get Windows event log entries from Application, System, or Security logs.",
          {
              "type": "object",
              "properties": {
                  "log_name": {"type": "string", "enum": ["Application", "System", "Security"]},
                  "max_events": {"type": "number"},
                  "level": {"type": "string", "enum": ["Error", "Warning", "Information"]},
              },
          })
    async def get_event_logs(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_direct('get_event_logs', args, config)

    @tool("get_service_status",
          "Get the status of a Windows service by name.",
          {"service_name": str})
    async def get_service_status(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_direct('get_service_status', args, config)

    @tool("get_agent_config",
          "Get current Owlette agent configuration (sensitive fields stripped).",
          {})
    async def get_agent_config(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_direct('get_agent_config', args, config)

    @tool("get_agent_logs",
          "Get recent Owlette agent log entries. Filter by level: ERROR, WARNING, INFO, DEBUG.",
          {"max_lines": int, "level": str})
    async def get_agent_logs(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_direct('get_agent_logs', args, config)

    @tool("get_agent_health",
          "Get agent health status including connection state and health probe results.",
          {})
    async def get_agent_health(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_direct('get_agent_health', args, config)

    return [
        get_system_info, get_process_list, get_running_processes,
        get_network_info, get_disk_usage, get_event_logs,
        get_service_status, get_agent_config, get_agent_logs,
        get_agent_health,
    ]


# Tier 2: process management, via IPC to the service


def _make_tier2_tools() -> list:
    """Create Tier 2 tool functions that use IPC."""

    @tool("restart_process",
          "Restart an Owlette-configured process by name.",
          {"process_name": str})
    async def restart_process(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_via_ipc('restart_process', args)

    @tool("kill_process",
          "Kill/stop an Owlette-configured process by name.",
          {"process_name": str})
    async def kill_process(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_via_ipc('kill_process', args)

    @tool("start_process",
          "Start an Owlette-configured process by name.",
          {"process_name": str})
    async def start_process(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_via_ipc('start_process', args)

    @tool("capture_screenshot",
          "Capture a screenshot of this machine's desktop. Returns the captured "
          "image for you to analyze visually — use this to see what is actually "
          "on screen. Use when the operator reports visual issues (frozen screen, "
          "black screen, wrong content, display glitches), asks what is currently "
          "on screen, or after restarting a display/media process to verify visual "
          "recovery. Do not capture screenshots for pure backend or service issues "
          "where the display is irrelevant. Use monitor=0 for all displays "
          "combined (default), or monitor=1, 2, etc. for a specific display.",
          {"monitor": int})
    async def capture_screenshot(args: dict[str, Any]) -> dict[str, Any]:
        # 60s, not the 30s default: the service side takes ~55s. Now that the
        # pump runs off the 5s loop the wait is real rather than masked by the
        # loop stalling anyway, so the default would just report a spurious
        # timeout for a capture that was going to succeed.
        result = await asyncio.to_thread(
            _execute_via_ipc_sync_raw, 'capture_screenshot', args, 60
        )
        # Build MCP content with image block if base64 is available
        content = []
        if result.get('error'):
            content.append({"type": "text", "text": result['error']})
        else:
            message = result.get('message', 'Screenshot captured')
            content.append({"type": "text", "text": message})
            b64 = result.get('base64')
            if b64:
                content.append({
                    "type": "image",
                    "data": b64,
                    "mimeType": "image/jpeg",
                })
        return {"content": content}

    return [restart_process, kill_process, start_process, capture_screenshot]


# Tier 3: privileged reads, executed directly


def _make_tier3_tools(config: dict) -> list:
    """Create Tier 3 tool functions with config bound."""

    @tool("read_file",
          "Read the contents of a file (max 100KB).",
          {"path": str})
    async def read_file(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_direct('read_file', args, config)

    @tool("list_directory",
          "List directory contents with file sizes and modification dates.",
          {"path": str})
    async def list_directory(args: dict[str, Any]) -> dict[str, Any]:
        return await _execute_direct('list_directory', args, config)

    return [read_file, list_directory]


# Server factory


def create_owlette_mcp_server(config: dict, max_tier: int = 2):
    """Build the MCP server with all tools up to the specified tier.

    Args:
        config: Agent config dict (passed to tool handlers).
        max_tier: Maximum tool tier to include (1, 2, or 3). Default: 2.

    Returns:
        An MCP server instance for use with ClaudeAgentOptions.
    """
    tools = []

    tools.extend(_make_tier1_tools(config))

    if max_tier >= 2:
        tools.extend(_make_tier2_tools())

    if max_tier >= 3:
        tools.extend(_make_tier3_tools(config))

    logger.info(f"Created Owlette MCP server with {len(tools)} tools (max tier {max_tier})")

    return create_sdk_mcp_server(
        name="owlette",
        version=shared_utils.get_app_version(),
        tools=tools,
    )

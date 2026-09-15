"""The claude-agent-sdk API surface hoot actually depends on.

The rest of the suite stubs the SDK out, so a breaking change in an upgrade —
a renamed symbol, a dropped ClaudeAgentOptions field — passes 1178 tests and
then fails on a real machine the first time someone opens a hoot chat. The pin
sat 83 minor versions behind for months; this guard is what makes the next bump
cheap to verify.

Skipped entirely when the SDK is absent, so the Linux sync-pipeline job and any
pywin32-less environment stay green.
"""

import inspect

import pytest

claude_agent_sdk = pytest.importorskip(
    'claude_agent_sdk',
    reason='claude-agent-sdk not installed in this environment',
)


def test_symbols_agent_src_imports_exist():
    """Every name agent/src imports from the SDK."""
    for name in (
        'tool',
        'create_sdk_mcp_server',
        'ClaudeSDKClient',
        'AssistantMessage',
        'TextBlock',
        'ClaudeAgentOptions',
    ):
        assert hasattr(claude_agent_sdk, name), f'claude_agent_sdk.{name} is gone'


def test_claude_agent_options_accepts_every_kwarg_owlette_cortex_passes():
    """owlette_cortex.py builds ClaudeAgentOptions with exactly these fields."""
    from claude_agent_sdk import ClaudeAgentOptions

    options = ClaudeAgentOptions(
        mcp_servers={'owlette': object()},
        allowed_tools=['mcp__owlette__*'],
        setting_sources=['project'],
        cwd='.',
        cli_path='claude.exe',
        permission_mode='acceptEdits',
        max_turns=1,
        max_budget_usd=1.0,
    )

    assert options.cli_path == 'claude.exe'
    assert options.permission_mode == 'acceptEdits'
    assert options.max_turns == 1
    assert options.max_budget_usd == 1.0
    assert options.setting_sources == ['project']


def test_bundled_cli_version_is_declared():
    """cortex_cli_fetch pins by sha256, but the SDK is the source of truth for
    WHICH CLI version it needs. An upgrade that moves this must be followed by
    scripts/upload-cortex-cli.mjs in every environment."""
    from claude_agent_sdk import _cli_version

    version = _cli_version.__cli_version__
    assert isinstance(version, str) and version.strip()
    # Shape only, never an equality assert: pinning the value here would make
    # every routine SDK bump fail this test for no reason.
    assert version.count('.') == 2, f'unexpected CLI version shape: {version}'


def test_create_sdk_mcp_server_still_takes_name_and_tools():
    """cortex_tools.create_owlette_mcp_server calls this."""
    from claude_agent_sdk import create_sdk_mcp_server

    params = inspect.signature(create_sdk_mcp_server).parameters
    assert 'name' in params
    assert 'tools' in params

"""The mcp API surface fleet_mcp.py actually depends on.

test_fleet_mcp.py drives the script through the real package, but only the
paths its tests take. This guard names every symbol and constructor argument
the script and its tests use, and the wire shapes it hands to model_validate,
so an mcp upgrade that renames or drops one fails here, by name, rather than
on a machine the first time a client launches the script. mcp 2 already moved
the low-level handlers from decorators to constructor arguments and removed
fastmcp (gate 0.2).

Skipped entirely when mcp is absent.
"""

import asyncio
import inspect

import pytest

mcp = pytest.importorskip('mcp', reason='mcp not installed in this environment')


def test_symbols_fleet_mcp_imports_exist():
    """Every name fleet_mcp.py and its tests import from mcp."""
    from mcp import types
    import mcp.client.stdio
    import mcp.server
    import mcp.server.stdio

    for name in ('ListToolsResult', 'CallToolResult', 'Tool', 'TextContent', 'ImageContent'):
        assert hasattr(types, name), f'mcp.types.{name} is gone'
    assert hasattr(mcp.server, 'Server'), 'mcp.server.Server is gone'
    assert hasattr(mcp.server.stdio, 'stdio_server'), 'mcp.server.stdio.stdio_server is gone'
    assert hasattr(mcp, 'Client'), 'mcp.Client is gone'
    assert hasattr(mcp.client.stdio, 'StdioServerParameters'), 'mcp.client.stdio.StdioServerParameters is gone'


def test_server_takes_the_handlers_and_runs_the_way_fleet_mcp_calls_it():
    """build_server passes a name, version and two handlers; serve() calls
    create_initialization_options and run(read, write, options)."""
    from mcp.server import Server

    params = inspect.signature(Server.__init__).parameters
    for name in ('name', 'version', 'on_list_tools', 'on_call_tool'):
        assert name in params, f'Server() no longer takes {name}'

    server = Server('owlette', version='0.0.0', on_list_tools=None, on_call_tool=None)
    assert callable(server.create_initialization_options)
    run_params = list(inspect.signature(Server.run).parameters)
    assert run_params[1:4] == ['read_stream', 'write_stream', 'initialization_options']


def test_stdio_server_is_an_async_context_manager_taking_no_arguments():
    from mcp.server.stdio import stdio_server

    assert all(
        p.default is not inspect.Parameter.empty
        for p in inspect.signature(stdio_server).parameters.values()
    )
    assert hasattr(stdio_server(), '__aenter__')


def test_list_tools_result_takes_the_server_catalog_as_wire_json():
    """The catalog passes straight through with its wire name, inputSchema."""
    from mcp import types

    schema = {'type': 'object', 'properties': {'machine': {'type': 'string'}}, 'required': ['machine']}
    result = types.ListToolsResult.model_validate({'tools': [
        {'name': 'get_process_list', 'description': 'processes', 'inputSchema': schema},
    ]})

    tool = result.tools[0]
    assert isinstance(tool, types.Tool)
    assert tool.name == 'get_process_list'
    assert tool.input_schema == schema


def test_call_tool_result_takes_text_and_image_content_as_wire_json():
    from mcp import types

    result = types.CallToolResult.model_validate({
        'content': [
            {'type': 'text', 'text': 'hello'},
            {'type': 'image', 'data': 'aGk=', 'mimeType': 'image/png'},
        ],
        'isError': True,
    })

    text, image = result.content
    assert isinstance(text, types.TextContent) and text.text == 'hello'
    assert isinstance(image, types.ImageContent)
    assert image.data == 'aGk=' and image.mime_type == 'image/png'
    assert result.is_error is True


def test_client_and_stdio_parameters_take_what_the_tests_pass():
    from mcp import Client
    from mcp.client.stdio import StdioServerParameters

    params = StdioServerParameters(command='python', args=['fleet_mcp.py'], env={'OWLETTE_DATA_ROOT': '.'})
    assert params.command == 'python' and params.args == ['fleet_mcp.py']
    for method in ('list_tools', 'call_tool'):
        assert inspect.iscoroutinefunction(getattr(Client, method)), f'Client.{method} is gone or not async'


def test_handlers_get_a_context_and_params_through_an_in_memory_client():
    """build_server's handlers take (ctx, params) and read params.name and
    params.arguments; test_fleet_mcp.py drives them through Client(<Server>)."""
    from mcp import Client, types
    from mcp.server import Server

    seen = {}

    async def on_list_tools(*args):
        seen['list'] = args
        return types.ListToolsResult.model_validate({'tools': [
            {'name': 'echo', 'inputSchema': {'type': 'object', 'properties': {}}},
        ]})

    async def on_call_tool(*args):
        seen['call'] = args
        params = args[-1]
        return types.CallToolResult.model_validate({
            'content': [{'type': 'text', 'text': f'{params.name} {params.arguments}'}],
            'isError': False,
        })

    server = Server('owlette', version='0.0.0', on_list_tools=on_list_tools, on_call_tool=on_call_tool)

    async def run():
        async with Client(server) as client:
            tools = await client.list_tools()
            return client.server_info.name, tools, await client.call_tool('echo', {'text': 'hi'})

    name, tools, result = asyncio.run(run())

    assert name == 'owlette'
    assert [tool.name for tool in tools.tools] == ['echo']
    assert len(seen['list']) == 2
    assert len(seen['call']) == 2
    assert seen['call'][1].name == 'echo'
    assert seen['call'][1].arguments == {'text': 'hi'}
    assert result.content[0].text == "echo {'text': 'hi'}"

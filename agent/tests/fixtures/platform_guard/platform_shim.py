"""Control: a top-level module named platform* shadows the stdlib `platform`.

agent/src is sys.path[0] for the agent, so this file would be what
`import platform` resolves to for every module that asks for the real one.
"""


def node():
    return 'not the stdlib platform.node'

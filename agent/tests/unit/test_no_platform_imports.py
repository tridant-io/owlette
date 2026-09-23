"""Guard: every module under agent/src must import on macOS and Linux.

The tri-platform agent keeps its Windows code behind `osadapter/win.py`, so a
module-scope `import win32api` anywhere else takes the whole agent down on a
POSIX box — an ImportError at start-up, not a failing feature. This guard
AST-parses every file under agent/src and fails on four things:

1. a module-scope import of a Windows-only module (`win32*` and pywin32's
   other top-levels, the Windows-only stdlib, and the `sys_platform ==
   "win32"` packages in agent/requirements.txt) or a module-scope use of a
   Windows-only name in the `ctypes` namespace (`windll`, `WinDLL`,
   `WINFUNCTYPE`, …) — `ctypes.wintypes` is fine, it is pure type declarations
   and imports on every platform;
2. a module-scope import OF one of the exempt modules below, which would drag
   the same ImportError in through the back door;
3. an exempt entry that no longer needs its exemption — the list only shrinks;
4. a top-level module named `platform*`, which shadows the stdlib `platform`
   that agent/src imports (agent/src is sys.path[0]).

"Module scope" means "runs on import": function bodies are exempt — though
their decorators and argument defaults are not — and so is an
`if __name__ == '__main__':` block, which no importer executes.
"""

import ast
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
AGENT_SRC = REPO_ROOT / 'agent' / 'src'
FIXTURE_DIR = Path(__file__).resolve().parents[1] / 'fixtures' / 'platform_guard'

# Modules allowed to carry a module-scope Windows dependency, keyed by their
# path relative to agent/src. Entries only ever shrink — rule 3 fails the guard
# when a listed file stops needing its line, so a port deletes it here.
WINDOWS_ONLY_MODULES = frozenset({
    # permanent — gated at every call site, never ported
    'display_manager.py',
    'owlette_scout.py',
    'registry_utils.py',
})

# The Windows arms themselves: exempt from rule 1, and rule 2 keeps the rest of
# the tree from importing them at module scope. They have no exemption to retire,
# so rule 3 does not police this set — an arm may be listed here before it
# exists.
WINDOWS_ARMS = frozenset({
    'osadapter/win.py',
    'tools_windows.py',
})

# Windows-only modules whose name does not start with `win32`. Importing any
# of them off Windows is the same ImportError as `import win32api`: the stdlib
# ones do not exist there, and pip installs neither pywin32 nor the marked
# packages.
_WINDOWS_MODULES = frozenset({
    # stdlib, Windows builds only
    'winreg', 'msvcrt', 'winsound',
    # pywin32 top-levels that do not start with `win32`
    'servicemanager', 'pywintypes', 'pythoncom', 'ntsecuritycon', 'winerror',
    'commctrl', 'sspicon', 'winioctlcon', 'regutil',
    # agent/requirements.txt, marked `sys_platform == "win32"`
    'wmi', 'clr', 'HardwareMonitor',
})

# Everything `ctypes` defines only under `_os.name == "nt"`.
_CTYPES_WINDOWS_NAMES = frozenset({
    'windll', 'oledll', 'WinDLL', 'OleDLL', 'WINFUNCTYPE', 'HRESULT',
    'WinError', 'FormatError', 'GetLastError', 'get_last_error',
    'set_last_error', 'DllGetClassObject', 'DllCanUnloadNow',
})


def _is_windows_module(name):
    top = name.split('.')[0]
    return top.startswith('win32') or top in _WINDOWS_MODULES


def _is_main_guard(test):
    return (
        isinstance(test, ast.Compare)
        and isinstance(test.left, ast.Name)
        and test.left.id == '__name__'
        and len(test.ops) == 1
        and isinstance(test.ops[0], ast.Eq)
        and isinstance(test.comparators[0], ast.Constant)
        and test.comparators[0].value == '__main__'
    )


def _signature_nodes(func):
    """A def's import-time parts: its decorators and its argument defaults.

    Annotations are left out on purpose — much of agent/src carries
    `from __future__ import annotations`, which makes theirs strings.
    """
    return [
        *func.decorator_list,
        *func.args.defaults,
        *(default for default in func.args.kw_defaults if default is not None),
    ]


def _import_time_nodes(node):
    """Every descendant of `node` that runs when the module is imported."""
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for part in _signature_nodes(child):
                yield part
                yield from _import_time_nodes(part)
            continue
        if isinstance(child, ast.If) and _is_main_guard(child.test):
            for alternative in child.orelse:
                yield alternative
                yield from _import_time_nodes(alternative)
            continue
        yield child
        yield from _import_time_nodes(child)


def _windows_dependencies(tree):
    """(lineno, description) for every module-scope Windows dependency."""
    found = []
    for node in _import_time_nodes(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if _is_windows_module(alias.name):
                    found.append((node.lineno, f'import {alias.name}'))
        elif isinstance(node, ast.ImportFrom):
            if node.module and _is_windows_module(node.module):
                found.append((node.lineno, f'from {node.module} import ...'))
            elif node.module == 'ctypes':
                for alias in node.names:
                    if alias.name in _CTYPES_WINDOWS_NAMES:
                        found.append((node.lineno, f'from ctypes import {alias.name}'))
        elif (
            isinstance(node, ast.Attribute)
            and node.attr in _CTYPES_WINDOWS_NAMES
            and isinstance(node.value, ast.Name)
            and node.value.id == 'ctypes'
        ):
            found.append((node.lineno, f'ctypes.{node.attr}'))
    return sorted(set(found))


def _exempt_targets(windows_only, windows_arms):
    """The exempt files as dotted module paths, the way an import spells them."""
    targets = set()
    for rel in set(windows_only) | set(windows_arms):
        parts = rel[:-len('.py')].split('/')
        if parts[-1] == '__init__':
            parts = parts[:-1]
        if parts:
            targets.add('.'.join(parts))
    return frozenset(targets)


def _is_exempt_target(dotted, targets):
    return any(dotted == target or dotted.startswith(f'{target}.') for target in targets)


def _absolute_module(rel, module, level):
    """The dotted path a `from ... import` in the file at `rel` resolves to."""
    if not level:
        return module or ''
    package = rel.split('/')[:-1]
    base = package[:len(package) - (level - 1)]
    return '.'.join(base + ([module] if module else []))


def _imports_of(tree, targets, rel):
    """(lineno, description) for every module-scope import of `targets`."""
    found = []
    for node in _import_time_nodes(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if _is_exempt_target(alias.name, targets):
                    found.append((node.lineno, f'import {alias.name}'))
        elif isinstance(node, ast.ImportFrom):
            module = _absolute_module(rel, node.module, node.level)
            if not module:
                continue
            if _is_exempt_target(module, targets):
                found.append((node.lineno, f'from {module} import ...'))
                continue
            for alias in node.names:
                if _is_exempt_target(f'{module}.{alias.name}', targets):
                    found.append((node.lineno, f'from {module} import {alias.name}'))
    return sorted(set(found))


def find_violations(sources, windows_only=WINDOWS_ONLY_MODULES, windows_arms=WINDOWS_ARMS):
    """Check a {relative posix path: source text} mapping of an agent/src tree."""
    exempt_targets = _exempt_targets(windows_only, windows_arms)
    violations = []
    trees = {}

    for rel in sorted(sources):
        if rel.split('/')[0].startswith('platform'):
            violations.append(
                f'{rel}: a top-level module named platform* shadows the stdlib '
                f'platform module that agent/src imports — rename it'
            )
            continue

        tree = trees[rel] = ast.parse(sources[rel], filename=rel)

        if rel in windows_only or rel in windows_arms:
            continue

        for lineno, what in _windows_dependencies(tree):
            violations.append(
                f'{rel}:{lineno}: module-scope {what} breaks the import on '
                f'macOS and Linux — move it into the function that uses it, or '
                f'behind osadapter/win.py'
            )
        for lineno, what in _imports_of(tree, exempt_targets, rel):
            violations.append(
                f'{rel}:{lineno}: module-scope {what} pulls in a Windows-only '
                f'module — import it inside the function that uses it'
            )

    for rel in sorted(windows_only):
        tree = trees.get(rel)
        if tree is None:
            violations.append(f'{rel}: listed as Windows-only but is no longer a module in this tree — drop the entry')
        elif not _windows_dependencies(tree):
            violations.append(
                f'{rel}: listed as Windows-only but carries no module-scope '
                f'Windows dependency any more — drop the entry, the list only shrinks'
            )

    return violations


def _read_tree(root, relative_paths):
    return {
        rel: (root / rel).read_text(encoding='utf-8')
        for rel in relative_paths
    }


def _walk_py(root):
    return sorted(
        path.relative_to(root).as_posix()
        for path in root.rglob('*.py')
        if '__pycache__' not in path.parts
    )


def _agent_src_sources():
    """agent/src as the guard sees it: every .py file, path relative to it.

    The tree on disk rather than `git ls-files`: a module written but not yet
    staged is exactly the one whose imports have never been checked, and the
    index keeps listing a file deleted from the worktree until that deletion
    is committed.
    """
    return _read_tree(AGENT_SRC, _walk_py(AGENT_SRC))


def test_agent_src_imports_on_posix():
    sources = _agent_src_sources()
    assert sources, 'found no python files under agent/src'
    assert find_violations(sources) == []


def test_guard_accepts_the_clean_fixtures():
    sources = _read_tree(FIXTURE_DIR, ['clean_module.py', 'windows_only_module.py'])
    assert find_violations(
        sources, windows_only=frozenset({'windows_only_module.py'}), windows_arms=frozenset()
    ) == []


def test_guard_rejects_the_control_fixtures():
    sources = _read_tree(FIXTURE_DIR, _walk_py(FIXTURE_DIR))
    violations = find_violations(
        sources,
        windows_only=frozenset({'windows_only_module.py'}),
        windows_arms=frozenset({'arm_pkg/arm.py'}),
    )

    assert {violation.split(':')[0] for violation in violations} == {
        'module_scope_offender.py',
        'exempt_importer.py',
        'arm_pkg/__init__.py',
        'platform_shim.py',
    }
    assert any('import winreg' in violation for violation in violations)
    assert any('import winerror' in violation for violation in violations)
    assert any('from ctypes import WinDLL' in violation for violation in violations)
    assert any('ctypes.WinDLL' in violation for violation in violations)
    assert any('ctypes.WINFUNCTYPE' in violation for violation in violations)
    assert any('ctypes.windll' in violation for violation in violations)
    assert any('import windows_only_module' in violation for violation in violations)
    assert any('from arm_pkg import arm' in violation for violation in violations)
    assert any('shadows the stdlib' in violation for violation in violations)


def test_guard_rejects_an_exemption_that_is_no_longer_needed():
    sources = _read_tree(FIXTURE_DIR, ['clean_module.py'])
    violations = find_violations(
        sources, windows_only=frozenset({'clean_module.py'}), windows_arms=frozenset()
    )

    assert violations == [
        'clean_module.py: listed as Windows-only but carries no module-scope '
        'Windows dependency any more — drop the entry, the list only shrinks'
    ]

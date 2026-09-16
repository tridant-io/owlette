"""Control: rule 2 — a relative module-scope import of a Windows arm.

The shape `osadapter/__init__.py` must never take: hoisting `from . import win`
out of the platform check makes the package itself Windows-only.
"""

from . import arm

BUILD = arm.BUILD

"""Control: rule 2 — a module-scope import of an exempt, Windows-only module."""

import windows_only_module

CURRENT_PROCESS = windows_only_module.CURRENT_PROCESS

# the .claude/ agent harness

How Claude Code is set up for this repo: what loads when, and how it is checked. Rewritten 2026-10-08; the 2025 version described TypeScript hooks and a keyword-matching activation hook that no longer exist.

## what loads when

| piece | where | loads |
|---|---|---|
| project instructions | `.claude/CLAUDE.md` | every session |
| subfolder instructions | `web/CLAUDE.md` | when a file under `web/` is read |
| vocabulary | `GLOSSARY.md` | read on demand; CLAUDE.md points at it |
| decisions | `docs/adr/NNNN-*.md` | read on demand for the area being touched |
| skills | `.claude/skills/<name>/SKILL.md` | the description every session (or, with `paths:`, once a matching file is touched); the body when the model or a person invokes it |
| commands | `.claude/commands/*.md` | the description every session; the body on `/name` or when the model invokes it |
| subagents | `.claude/agents/*.md` | listed every session; each needs `name:` and `description:` frontmatter or Claude Code ignores the file |
| hooks | `.claude/settings.json` | on their events |

`agent/CLAUDE.md` is not coding guidance: it is hoot's constitution, shipped to machines by the installer. `claudeMdExcludes` in `.claude/settings.json` keeps it out of coding sessions.

Skills are folders, never flat files: Claude Code silently skips `.claude/skills/<name>.md`. Write descriptions in the words people actually use when asking (release, failover, env vars), because the description is what makes the model reach for the skill.

## the workflow

`/plan` (codebase-researcher agents) → `/execute` (one task-executor per task in a wave) or `/next` → `/verify` (checks, then code-architecture-reviewer for standards and work-verifier for spec, in parallel, plus evidence from where the owner looks). `/debug` for bugs, `/preflight` before pushing web changes, `/save` and `/resume` across sessions. Plans live in `dev/` (see `dev/README.md`).

## hooks

| hook | event | does |
|---|---|---|
| `track-edits.mjs` | PostToolUse Edit/Write | logs edited paths to `.claude/session-edits.json` (10 min window) |
| `deploy-agent.mjs` | PostToolUse Edit/Write | mirrors an edited `agent/src/*.py` into `C:\ProgramData\Owlette\agent\src` and restarts the service |
| `pre-commit-check.mjs` | PreToolUse Bash | on `git commit`/`push`, runs tsc + jest for web edits and pytest for agent edits from the edit log; denies the call on failure |
| `post-push-e2e.mjs` | PostToolUse Bash | when a push or `gh pr merge` lands web changes on dev/main, tells Claude to watch the playwright e2e run |
| `post-push-installer.mjs` | PostToolUse Bash | when agent files land on dev/main, reminds Claude that machines only get them through an installer release |

Hooks fail silently: a hook that does not parse, or writes a field Claude Code ignores, still exits 0. So every hook writes stdout only through `lib/hook-output.mjs`, and `node scripts/check-claude-hooks.mjs` (CI: `.github/workflows/claude-hooks.yml`) proves each one parses and emits valid hook JSON. It also fails on frontmatter Claude Code would silently drop: a flat skill file, a missing description, a name that does not match, or an unquoted `:` in a value. Run it after any change under `.claude/`.

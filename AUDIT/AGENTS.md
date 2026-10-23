# AGENTS.md — DocFlow rules for any AI coding agent
> Purpose: tool-agnostic entry point (Codex, Antigravity, Cursor, etc.). Same rules as `CLAUDE.md`.
> Read: before making any change. Commands and project summary live in `CLAUDE.md`.

## Non-negotiable rules
1. **NEVER run any git command** (commit, add, push, checkout, stash, reset, branch, merge, rebase, …) without the user's explicit permission.
2. Before editing, state which files you will touch and why. Minimal, scoped changes only.
3. Do NOT add dependencies, change DB schema/migrations, or alter auth/RBAC without asking.
4. After a change, update `docs/IMPLEMENTATION_STATUS.md` (and `docs/DEBUGGING_LESSONS.md` if a non-obvious bug was solved).
5. Never expose secrets (`Backend/.env`, `Frontend/.env`, Firebase service-account JSON). Names only.
6. Don't guess: unverified facts become `TODO(verify): …` plus a question to the user.

## Routing — read before acting
| Task | Read |
|---|---|
| UI / frontend | `docs/DESIGN.md` (placeholder) + `docs/CODING_RULES.md` §Frontend |
| API / logic / DB | `docs/ARCHITECTURE.md` + `docs/CODING_RULES.md` §Backend |
| Bug / error | `docs/DEBUGGING_LESSONS.md` |
| Status / next steps | `docs/IMPLEMENTATION_STATUS.md` |
| Roles, workflow & approval rules, lifecycle | `docs/PROJECT_CONTEXT.md` |

Run/build/test commands and the definition of done: see `CLAUDE.md`.

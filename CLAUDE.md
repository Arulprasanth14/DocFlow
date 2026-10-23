# DocFlow — agent entry point

**Before making any change, read [`AUDIT/CLAUDE.md`](AUDIT/CLAUDE.md).**
It holds the non-negotiable rules (git, scope, schema/RBAC/dependency approval, secrets)
and a routing table pointing to the right doc for your task:

| Task | Read |
|---|---|
| UI / frontend | `AUDIT/docs/DESIGN.md` + `AUDIT/docs/CODING_RULES.md` (Frontend) |
| API / logic / DB | `AUDIT/docs/ARCHITECTURE.md` + `AUDIT/docs/CODING_RULES.md` (Backend) |
| Bug / error | `AUDIT/docs/DEBUGGING_LESSONS.md` |
| What's done / next | `AUDIT/docs/IMPLEMENTATION_STATUS.md` |
| Roles, workflow & approval rules, lifecycle | `AUDIT/docs/PROJECT_CONTEXT.md` |

Project summary and the real run/build/test/migrate commands are in `AUDIT/CLAUDE.md`.

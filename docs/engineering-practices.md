# Engineering practices

Junban follows Google’s published Engineering Practices guidance for code review and change size. The goal is steady improvement of the codebase while still shipping focused, functional work.

## Official sources

Cite and re-read these pages; this document summarizes how they apply here:

1. [The Standard of Code Review](https://google.github.io/eng-practices/review/reviewer/standard.html)
   Reviewers should favor approving a change once it **definitely improves overall code health**, even if it is not perfect. The primary purpose of review is improving code health over time while still letting developers make progress.
2. [What to look for in a code review](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
   Look for sound design, functionality that matches intent and user need, complexity that stays justified, appropriate tests, clear naming and comments (why, not what), and consistent style.
3. [Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html)
   Prefer small, simple changes that are easier to review, safer to revert, and less likely to hide defects.

## How we apply them

| Principle                         | Practice in this repo                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| Code health while making progress | Improve structure in the change you are already making; do not block on perfection.               |
| Simplicity / no overengineering   | Ship the simplest complete design for the current phase. No speculative frameworks.               |
| Focused changes                   | One phase outcome or one reviewable concern per commit/PR when practical.                         |
| Functionality                     | Behavior must work and match the acceptance contract; unproven “flexibility” is not a substitute. |
| Proportional tests                | Test real behavior. Do not add meaningless tests to decorate empty modules.                       |
| Clear names and comments          | Name for the domain. Comment intent and non-obvious constraints.                                  |
| Better rather than perfect        | Prefer a solid incremental improvement that lands over a theoretical ideal that stalls.           |

## Phase discipline

- Work only the active ExecPlan phase.
- Delete superseded scaffolding after its replacement lands.
- Do not claim checks that were not run.
- Record evidence under `goals/rust-rewrite/evidence/` when a phase requires it.

## Frontend and Node boundary

- Preserve the approved React design unless the user explicitly approves a visible change.
- Use Node/pnpm only to develop, test, and build the frontend.
- Never introduce a shipped Node backend, sidecar, or plugin process.

## Review selection

Use the dominant-risk checkpoint table in [`../PLANS.md`](../PLANS.md). Fix verified in-scope material findings before phase closure, or record an explicit accepted-risk decision. Do not block phases on speculative abstractions or unrelated cleanup.

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

## Rust code health and DX

Apply these when changing Rust modules. Prefer official sources over folklore or arbitrary size rules:

- [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/)
- [The Rust Book — modules and privacy](https://doc.rust-lang.org/book/ch07-00-managing-growing-projects-with-packages-crates-and-modules.html) and the [Reference on visibility](https://doc.rust-lang.org/reference/visibility-and-privacy.html)
- [Clippy lints](https://rust-lang.github.io/rust-clippy/master/index.html) and [Clippy configuration](https://doc.rust-lang.org/clippy/configuration.html)
- [Tokio shared state](https://tokio.rs/tokio/tutorial/shared-state), [`select!`](https://tokio.rs/tokio/tutorial/select), and [graceful shutdown](https://tokio.rs/tokio/topics/shutdown)
- [The rustdoc book](https://doc.rust-lang.org/rustdoc/)
- [Cargo and CI](https://doc.rust-lang.org/cargo/guide/continuous-integration.html)
- [rust-analyzer manual](https://rust-analyzer.github.io/manual.html)

### Ownership over line counts

There is **no arbitrary file or LoC ceiling**. A god module or type is one that mixes ownership or authority domains, or that creates demonstrated navigation, review, or compile pain—not a file that merely grew while staying cohesive.

Split by coherent ownership. Keep items private by default and expose `pub(crate)` only at real crate boundaries. Do not invent speculative traits, facade layers, or micro-crates to chase size metrics. Exhaustive registries, executors, and domain authorities may stay large when they remain one ownership boundary.

### Lint and review posture

CI is the authority for format and lint: `cargo fmt` and Clippy with `--all-targets` and `-D warnings`. Treat pedantic lints and `too_many_lines` as review smoke alarms, not automatic split mandates. Do not treat `cognitive_complexity` as a trusted quality metric.

### Async and shared state

Do not hold synchronous locks across `.await`. Prefer cancellation-safe `select!`, RAII guards, and supervised tasks with explicit shutdown. Shared mutable state should stay short-lived and ownership-clear.

### Docs and the contributor loop

Document public and crate-boundary APIs (why and invariants, not narration). Contributors should run the nearest focused check first, then widen only when the risk or failure justifies it.

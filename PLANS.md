# Planning and Review Standard

Create a self-contained ExecPlan under `goals/<slug>/execplan.md` for any multi-phase feature, architecture boundary, persistence change, public surface, plugin/security work, accessibility change, performance budget, or release workflow.

## Required plan sections

Every ExecPlan includes:

- Purpose and user-visible outcome
- Baseline and evidence
- In scope / out of scope
- Acceptance contract
- Architecture and ownership boundaries
- Alternatives and decision log
- Phase graph and progress
- Concrete steps and commands
- Validation and performance evidence
- Recovery and rollback
- Review checkpoints
- Discoveries, outcomes, and retrospective

Keep the plan live. A phase is not complete while its relevant check fails, evidence is missing, documentation is stale, or a material review finding remains open.

## Review selection

Use one appropriate reviewer at each real gate rather than stacking redundant reviews.

| Dominant risk                                            | Required checkpoint                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| Architecture and boundaries                              | Architecture reviewer                                                 |
| SQLite schema, queries, or recovery                      | Database reviewer                                                     |
| HTTP, CLI, MCP, plugin or tool contracts                 | API-contract reviewer                                                 |
| Authentication, permissions, secrets, plugin sandbox     | Security reviewer; red-team only for a distinct severe attack surface |
| React behavior, accessibility, exact design preservation | Frontend/accessibility reviewer                                       |
| Runtime memory, startup, throughput                      | Performance-focused review                                            |
| Contributor workflow and canonical docs                  | Docs auditor                                                          |
| Ordinary integrated change                               | General reviewer                                                      |

Fix verified in-scope material findings before closure or record an explicit accepted-risk decision. Do not block phases on speculative abstractions or unrelated cleanup.

## Phase completion

Each rewrite phase must:

1. define one observable end-to-end outcome;
2. avoid shipping parallel old/new owners;
3. include focused tests and relevant broad checks;
4. record optimized-build memory/performance data once runnable;
5. preserve approved UI screenshots where frontend behavior is involved;
6. update docs and the live plan;
7. pass its reviewer gate;
8. end in one clean, named commit.

A later phase may depend only on completed, committed earlier phases.

# Phase 3 review finding ledger

This ledger records material Phase 3 review findings. Closed findings are not reopened without new evidence.

| ID           | Severity | Status | Decision                                                                                                                                                                       |
| ------------ | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P3-REMDB-001 | High     | Open   | Reminder settlement must bind to the exact current claim attempt and an unexpired lease/claim; delayed callbacks, release, expiry, and same-term reclaim must fail closed.     |
| P3-REMDB-002 | Medium   | Open   | Terminal reminder audit rows and snapshot/list reads need the frozen 90-day, 2,000-row, and 2 MiB bounds without removing current pending/claimed intent.                      |
| P3-REMDB-003 | Medium   | Open   | Reminder due/expiry ordering must not use variable-width RFC3339 lexical comparisons; storage/query behavior needs a sortable representation and fractional-boundary coverage. |

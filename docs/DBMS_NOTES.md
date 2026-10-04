# DBMS Viva Notes

## ACID
Atomicity: transfer operations commit together or roll back together.
Consistency: constraints and business checks preserve valid state.
Isolation: row locks prevent conflicting concurrent balance updates.
Durability: committed PostgreSQL data persists to storage.

## Why an append-only ledger?
Balances are a current-state optimization. Ledger entries preserve an auditable history of movements and are protected against UPDATE/DELETE by a database trigger.

## Why NUMERIC for money?
Binary floating point can introduce rounding behavior. Fixed precision decimal is appropriate for this simulation.

## Why indexes?
Indexes support frequent account, reference, date and audit-log lookups without scanning every row.

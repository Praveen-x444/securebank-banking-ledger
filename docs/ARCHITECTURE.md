# SecureBank v2 Architecture

## Layers

Browser -> React UI -> REST API -> Service/transaction logic -> PostgreSQL

The educational implementation keeps route handlers thin enough to show the database behavior clearly. PostgreSQL is the source of truth for balances and the immutable ledger.

## Core invariants

1. Money uses `NUMERIC(18,2)` rather than floating point.
2. A transfer debits one account and credits another in the same DB transaction.
3. Source/destination rows are locked in sorted UUID order to reduce deadlock risk.
4. The ledger is append-only using database triggers.
5. Account balances cannot become negative.
6. Protected routes enforce JWT authentication and server-side roles.
7. Audit events are written for security and financial operations.

## DBMS concepts

- Normalized relational schema
- PK/FK/UNIQUE/NOT NULL/CHECK constraints
- B-tree indexes
- View: `account_statement`
- Triggers for ledger immutability and balance guards
- Transactions / ACID
- Row-level locking with `FOR UPDATE`
- Aggregation, joins, grouping and reporting queries

## Software engineering

- Separation between frontend and backend
- Environment-driven configuration
- Centralized API error shape
- Input validation with Zod
- Password hashing
- RBAC
- Rate limiting and Helmet
- Dockerized development
- Responsive UI and reduced-motion-friendly CSS animation approach

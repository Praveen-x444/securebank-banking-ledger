# SecureBank v2 — Banking Ledger Application

A complete educational full-stack banking simulation designed to demonstrate **DBMS + backend engineering + security + software engineering + premium UI**.

> **Important:** This is a portfolio/college simulation. It is not a real banking system and must not be connected to real bank accounts, payment rails, or real customer financial data.

## Stack

- React + Vite
- Node.js + Express
- PostgreSQL 16
- JWT + bcrypt
- Zod validation
- Helmet + rate limiting
- Docker Compose
- Lucide icons + CSS 3D/glass UI

## Features

### Customer
- Register/login/logout
- Dashboard and live balance
- Immutable transaction history
- Search/filter transactions
- CSV statement export
- Atomic transfers by destination account number
- Beneficiary management
- Notifications

### Admin
- User lifecycle management
- Account freeze/unfreeze/close
- Deposits and withdrawals
- Transaction review
- Audit log
- SQL-driven reports
- Customer/account reporting

### Database/DBMS
- ACID transfer transactions
- Row-level locks with deterministic lock ordering
- Append-only ledger trigger
- Negative-balance database guard
- PK/FK/UNIQUE/NOT NULL/CHECK constraints
- Indexes
- `account_statement` view
- Aggregation, joins and reporting queries
- Numeric fixed-precision money

### Software engineering
- JWT authentication
- Server-side RBAC
- Password hashing
- Zod input validation
- Parameterized SQL
- Centralized error responses
- Helmet security headers
- Rate limiting
- Environment configuration
- Dockerized reproducible setup
- Responsive UI
- Animated 3D-style banking hero

## Run with Docker Desktop

1. Install and start Docker Desktop.
2. Open PowerShell in the project folder.
3. If you have an older SecureBank database volume, reset it once:

```powershell
docker compose down -v
```

4. Build and start:

```powershell
docker compose up --build
```

5. Open:

`http://localhost:5173`

API health:

`http://localhost:4000/api/health`

## Demo accounts

Customer:

- `user@securebank.local`
- `User@12345`
- Account: `SBDEMO000001`

Second customer:

- `alex@securebank.local`
- `User@12345`
- Account: `SBDEMO000002`

Admin:

- `admin@securebank.local`
- `Admin@12345`

## Demo transfer

Sign in as the customer and open **Transfer**.

Send money to:

`SBDEMO000002`

Example amount:

`500`

The backend will:

1. Validate ownership/status.
2. Resolve the destination account.
3. Lock both account rows.
4. Check sufficient funds.
5. Debit the source.
6. Credit the destination.
7. Create a transfer record.
8. Create two immutable ledger entries.
9. Create notifications.
10. Write an audit event.
11. Commit everything atomically.

## If Docker is not recognized in VS Code

Install Docker Desktop for Windows, start it, close/reopen VS Code, then verify:

```powershell
docker --version
docker compose version
```

Then run:

```powershell
docker compose up --build
```

## Project structure

```text
securebank/
├── client/
│   ├── src/main.jsx
│   ├── src/style.css
│   ├── Dockerfile
│   └── package.json
├── server/
│   ├── src/index.js
│   ├── sql/init.sql
│   ├── test/logic.test.js
│   ├── Dockerfile
│   └── package.json
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API.md
│   └── DBMS_NOTES.md
├── docker-compose.yml
└── .env.example
```


## v2.1 repair notes

This build fixes the common `Dashboard could not be loaded` / `Reports could not be loaded`
500 errors caused by a PostgreSQL volume retaining an older SecureBank schema.

The API now runs the idempotent `server/sql/init.sql` schema at startup. This means
an existing development database is repaired when the API starts, instead of relying
only on Docker's `/docker-entrypoint-initdb.d` behavior (which runs only for a new
PostgreSQL volume).

### Clean reset (recommended for demo data)

```powershell
docker compose down -v --remove-orphans
docker compose up --build --force-recreate
```

### Verify the API

```powershell
curl http://localhost:4000/api/health
```

Expected:

```json
{"success":true,"data":{"service":"SecureBank API","status":"healthy", "...":"..."}}
```

### If an old container is still running

```powershell
docker compose ps
docker compose logs server --tail=200
```

The browser frontend now shows the actual API error and a Retry button instead of
leaving the admin pages stuck on an endless loading state.

Demo credentials remain:

- Customer: `user@securebank.local` / `User@12345`
- Admin: `admin@securebank.local` / `Admin@12345`
- Customer 2: `alex@securebank.local` / `User@12345`

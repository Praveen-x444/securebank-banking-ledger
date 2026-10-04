# SecureBank API summary

Base URL: `http://localhost:4000/api`

## Auth

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /me`

## Customer

- `GET /accounts/:id/statement`
- `GET /accounts/:id/transactions`
- `POST /transfers`
- `GET/POST/DELETE /beneficiaries...`
- `GET /notifications`
- `PATCH /notifications/:id/read`

## Admin/Auditor

- `GET /admin/overview`
- `GET /admin/users`
- `PATCH /admin/users/:id/status` (admin)
- `GET /admin/accounts`
- `POST /admin/accounts` (admin)
- `PATCH /admin/accounts/:id/status` (admin)
- `GET /admin/transactions`
- `GET /admin/audit-logs`
- `GET /admin/reports`
- `POST /deposits` (admin)
- `POST /withdrawals` (admin)

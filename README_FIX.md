# SecureBank v2.2 Fixed

This build specifically fixes Admin Overview and Reports returning HTTP 500.

## Important reset
From the project directory run:

```powershell
docker compose down -v --remove-orphans
docker compose up --build --force-recreate
```

Then open http://localhost:5173.

Admin: admin@securebank.local / Admin@12345

The API now performs compatibility migrations for older development databases and uses explicit, PostgreSQL-compatible reporting queries. Server logs include ADMIN_OVERVIEW_SQL_ERROR and ADMIN_REPORTS_SQL_ERROR if a database query ever fails.

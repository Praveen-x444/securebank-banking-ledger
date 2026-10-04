CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), full_name VARCHAR(120) NOT NULL,
 email VARCHAR(180) UNIQUE NOT NULL, password_hash TEXT NOT NULL,
 role VARCHAR(20) NOT NULL DEFAULT 'CUSTOMER' CHECK(role IN ('CUSTOMER','ADMIN','AUDITOR')),
 status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS accounts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id),
 account_number VARCHAR(24) UNIQUE NOT NULL, account_type VARCHAR(20) NOT NULL DEFAULT 'SAVINGS' CHECK(account_type IN ('SAVINGS','CURRENT')),
 currency CHAR(3) NOT NULL DEFAULT 'INR', balance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(balance>=0),
 status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','FROZEN','CLOSED')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transfers (
 id UUID PRIMARY KEY, from_account UUID NOT NULL REFERENCES accounts(id), to_account UUID NOT NULL REFERENCES accounts(id),
 amount NUMERIC(18,2) NOT NULL CHECK(amount>0), status VARCHAR(20) NOT NULL CHECK(status IN ('PENDING','COMPLETED','FAILED','REVERSED')),
 note VARCHAR(200), initiated_by UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS deposits (id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id), amount NUMERIC(18,2) NOT NULL CHECK(amount>0), note VARCHAR(200), created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS withdrawals (id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id), amount NUMERIC(18,2) NOT NULL CHECK(amount>0), note VARCHAR(200), created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ledger_entries (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), reference_id UUID NOT NULL, account_id UUID NOT NULL REFERENCES accounts(id),
 entry_type VARCHAR(10) NOT NULL CHECK(entry_type IN ('CREDIT','DEBIT')), amount NUMERIC(18,2) NOT NULL CHECK(amount>0),
 balance_after NUMERIC(18,2) NOT NULL CHECK(balance_after>=0), description VARCHAR(240) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs (id BIGSERIAL PRIMARY KEY, user_id UUID REFERENCES users(id), action VARCHAR(80) NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS notifications (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, title VARCHAR(120) NOT NULL, message VARCHAR(500) NOT NULL, type VARCHAR(20) NOT NULL DEFAULT 'INFO', read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS beneficiaries (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, account_id UUID NOT NULL REFERENCES accounts(id), nickname VARCHAR(60) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(user_id,account_id));
-- Compatibility repairs for databases created by an earlier SecureBank build.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'CUSTOMER';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_number VARCHAR(24);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) NOT NULL DEFAULT 'SAVINGS';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'INR';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS balance NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS from_account UUID;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS to_account UUID;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS amount NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'PENDING';
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS note VARCHAR(200);
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS initiated_by UUID;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS reference_id UUID;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS account_id UUID;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS entry_type VARCHAR(10) NOT NULL DEFAULT 'CREDIT';
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS amount NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS balance_after NUMERIC(18,2) NOT NULL DEFAULT 0;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS description VARCHAR(240) NOT NULL DEFAULT 'Ledger entry';
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id); CREATE INDEX IF NOT EXISTS idx_ledger_account_created ON ledger_entries(account_id,created_at DESC); CREATE INDEX IF NOT EXISTS idx_ledger_reference ON ledger_entries(reference_id); CREATE INDEX IF NOT EXISTS idx_transfers_created ON transfers(created_at DESC); CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_account); CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC); CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id,created_at DESC);
CREATE OR REPLACE VIEW account_statement AS SELECT le.id,le.reference_id,le.account_id,le.entry_type,le.amount,le.balance_after,le.description,le.created_at FROM ledger_entries le;
CREATE OR REPLACE FUNCTION deny_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Ledger is append-only'; END; $$;
DROP TRIGGER IF EXISTS ledger_no_update ON ledger_entries; DROP TRIGGER IF EXISTS ledger_no_delete ON ledger_entries;
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION deny_ledger_mutation();
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION deny_ledger_mutation();
CREATE OR REPLACE FUNCTION prevent_negative_balance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.balance < 0 THEN RAISE EXCEPTION 'Balance cannot be negative'; END IF; RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS account_balance_guard ON accounts; CREATE TRIGGER account_balance_guard BEFORE INSERT OR UPDATE OF balance ON accounts FOR EACH ROW EXECUTE FUNCTION prevent_negative_balance();


import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
const { Pool } = pg;

const app = express();
const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 15 });

async function ensureSchema() {
  // The Docker init script only runs when the PostgreSQL volume is created.
  // Running the same idempotent SQL at API startup also repairs an existing
  // development volume created by an older SecureBank version.
  const schemaUrl = new URL('../sql/init.sql', import.meta.url);
  const schema = await readFile(schemaUrl, 'utf8');
  await pool.query(schema);
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: CLIENT_ORIGIN, credentials: false }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false }));

const send = (res, status, data = {}, message = '') => res.status(status).json({ success: status < 400, data, message });
const error = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const sign = u => jwt.sign({ id:u.id, role:u.role, email:u.email, name:u.full_name }, JWT_SECRET, { expiresIn:'4h' });
const auth = (req,res,next) => {
  try {
    const h=req.headers.authorization||''; const token=h.startsWith('Bearer ')?h.slice(7):null;
    if(!token) return error(res,401,'UNAUTHORIZED','Authentication required');
    req.user=jwt.verify(token,JWT_SECRET); next();
  } catch { return error(res,401,'INVALID_TOKEN','Invalid or expired token'); }
};
const roles = (...allowed) => (req,res,next) => allowed.includes(req.user.role) ? next() : error(res,403,'FORBIDDEN','You do not have permission for this action');
const parse = (schema, value) => { const r=schema.safeParse(value); if(!r.success) { const e=new Error(r.error.issues.map(x=>`${x.path.join('.')}: ${x.message}`).join('; ')); e.status=400; e.code='VALIDATION_ERROR'; throw e; } return r.data; };
const audit = async (client,userId,action,metadata={}) => client.query('INSERT INTO audit_logs(user_id,action,metadata) VALUES($1,$2,$3)',[userId || null,action,JSON.stringify(metadata)]);
const accountForUser = async (userId, accountId, client=pool) => { const q=await client.query('SELECT * FROM accounts WHERE id=$1 AND user_id=$2',[accountId,userId]); return q.rows[0]; };
const money = z.coerce.number().finite().positive().max(100000000);

app.get('/api/health', asyncRoute(async (_,res)=>send(res,200,{service:'SecureBank API',status:'healthy',timestamp:new Date().toISOString()})));

app.post('/api/auth/register', asyncRoute(async(req,res)=>{
  const s=parse(z.object({fullName:z.string().trim().min(2).max(120),email:z.string().email().max(180),password:z.string().min(8).max(100)}),req.body);
  const c=await pool.connect();
  try { await c.query('BEGIN');
    const hash=await bcrypt.hash(s.password,12);
    const u=(await c.query('INSERT INTO users(full_name,email,password_hash) VALUES($1,$2,$3) RETURNING id,full_name,email,role,status,created_at',[s.fullName,s.email.toLowerCase(),hash])).rows[0];
    const acctNo='SB'+crypto.randomInt(100000000000,999999999999);
    const a=(await c.query('INSERT INTO accounts(user_id,account_number) VALUES($1,$2) RETURNING id,account_number,account_type,currency,balance,status,created_at',[u.id,acctNo])).rows[0];
    await audit(c,u.id,'USER_REGISTERED',{email:u.email}); await c.query('COMMIT');
    send(res,201,{token:sign(u),user:u,accounts:[a]},'Registration successful');
  } catch(e) { await c.query('ROLLBACK'); if(e.code==='23505') return error(res,409,'DUPLICATE_EMAIL','Email is already registered'); throw e; } finally { c.release(); }
}));

app.post('/api/auth/login', asyncRoute(async(req,res)=>{
  const s=parse(z.object({email:z.string().email(),password:z.string().min(1)}),req.body);
  const q=await pool.query('SELECT * FROM users WHERE email=$1',[s.email.toLowerCase()]);
  if(!q.rowCount) return error(res,401,'INVALID_CREDENTIALS','Invalid email or password');
  const u=q.rows[0];
  if(!(await bcrypt.compare(s.password,u.password_hash))) return error(res,401,'INVALID_CREDENTIALS','Invalid email or password');
  if(u.status!=='ACTIVE') return error(res,403,'USER_SUSPENDED','This user account is suspended');
  await pool.query('UPDATE users SET last_login_at=now() WHERE id=$1',[u.id]);
  await pool.query('INSERT INTO audit_logs(user_id,action,metadata) VALUES($1,$2,$3)',[u.id,'LOGIN',JSON.stringify({})]);
  const {password_hash,...safe}=u; send(res,200,{token:sign(safe),user:safe},'Login successful');
}));

app.get('/api/me',auth,asyncRoute(async(req,res)=>{
  const u=(await pool.query('SELECT id,full_name,email,role,status,created_at,last_login_at FROM users WHERE id=$1',[req.user.id])).rows[0];
  if(!u) return error(res,404,'USER_NOT_FOUND','User not found');
  const accounts=(await pool.query('SELECT id,account_number,account_type,currency,balance,status,created_at FROM accounts WHERE user_id=$1 ORDER BY created_at',[req.user.id])).rows;
  const notifications=(await pool.query('SELECT id,title,message,type,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',[req.user.id])).rows;
  send(res,200,{user:u,accounts,notifications});
}));
app.post('/api/auth/logout',auth,asyncRoute(async(req,res)=>{ await pool.query('INSERT INTO audit_logs(user_id,action,metadata) VALUES($1,$2,$3)',[req.user.id,'LOGOUT',JSON.stringify({})]); send(res,200,{},'Logged out'); }));

app.get('/api/accounts/:id/statement',auth,asyncRoute(async(req,res)=>{
  const id=req.params.id; const permitted=req.user.role!=='CUSTOMER' || (await accountForUser(req.user.id,id));
  if(!permitted) return error(res,403,'FORBIDDEN','Account does not belong to you');
  const q=await pool.query('SELECT * FROM account_statement WHERE account_id=$1 ORDER BY created_at DESC LIMIT 500',[id]); send(res,200,{rows:q.rows});
}));
app.get('/api/accounts/:id/transactions',auth,asyncRoute(async(req,res)=>{
  const schema=z.object({search:z.string().optional(),type:z.enum(['CREDIT','DEBIT']).optional(),from:z.string().optional(),to:z.string().optional(),page:z.coerce.number().int().min(1).default(1),limit:z.coerce.number().int().min(1).max(100).default(20)});
  const p=parse(schema,req.query); const permitted=req.user.role!=='CUSTOMER' || (await accountForUser(req.user.id,req.params.id)); if(!permitted) return error(res,403,'FORBIDDEN','Account does not belong to you');
  const vals=[req.params.id]; const where=['account_id=$1'];
  if(p.type){vals.push(p.type);where.push(`entry_type=$${vals.length}`)}
  if(p.search){vals.push(`%${p.search}%`);where.push(`(description ILIKE $${vals.length} OR reference_id::text ILIKE $${vals.length})`)}
  if(p.from){vals.push(p.from);where.push(`created_at >= $${vals.length}::timestamptz`)} if(p.to){vals.push(p.to);where.push(`created_at < ($${vals.length}::date + interval '1 day')`)}
  const count=(await pool.query(`SELECT count(*)::int count FROM ledger_entries WHERE ${where.join(' AND ')}`,vals)).rows[0].count;
  vals.push(p.limit,p.limit*(p.page-1)); const rows=(await pool.query(`SELECT * FROM ledger_entries WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${vals.length-1} OFFSET $${vals.length}`,vals)).rows;
  send(res,200,{rows,pagination:{page:p.page,limit:p.limit,total:count,pages:Math.ceil(count/p.limit)}});
}));

const transferSchema=z.object({fromAccount:z.string().uuid(),toAccount:z.string().uuid().optional(),toAccountNumber:z.string().trim().min(6).max(24).optional(),amount:money,note:z.string().trim().max(200).optional()}).refine(x=>Boolean(x.toAccount||x.toAccountNumber),{message:'Destination account is required'});
app.post('/api/transfers',auth,asyncRoute(async(req,res)=>{
  const p=parse(transferSchema,req.body);
  const c=await pool.connect(); const ref=crypto.randomUUID();
  try { await c.query('BEGIN'); await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    let destinationId=p.toAccount;
    if(!destinationId){ const lookup=await c.query('SELECT id FROM accounts WHERE account_number=$1',[p.toAccountNumber]); if(!lookup.rowCount) throw Object.assign(new Error('Destination account not found'),{status:404,code:'ACCOUNT_NOT_FOUND'}); destinationId=lookup.rows[0].id; }
    if(p.fromAccount===destinationId) throw Object.assign(new Error('Source and destination must differ'),{status:400,code:'SAME_ACCOUNT'});
    const ids=[p.fromAccount,destinationId].sort(); const locked=(await c.query('SELECT * FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids])).rows;
    const from=locked.find(x=>x.id===p.fromAccount), to=locked.find(x=>x.id===destinationId);
    if(!from||!to) throw Object.assign(new Error('Account not found'),{status:404,code:'ACCOUNT_NOT_FOUND'});
    if(req.user.role==='CUSTOMER' && from.user_id!==req.user.id) throw Object.assign(new Error('Source account is not yours'),{status:403,code:'FORBIDDEN'});
    if(from.status!=='ACTIVE'||to.status!=='ACTIVE') throw Object.assign(new Error('Both accounts must be active'),{status:409,code:'ACCOUNT_NOT_ACTIVE'});
    if(Number(from.balance)<p.amount) throw Object.assign(new Error('Insufficient funds'),{status:409,code:'INSUFFICIENT_FUNDS'});
    const na=(Number(from.balance)-p.amount).toFixed(2), nb=(Number(to.balance)+p.amount).toFixed(2);
    await c.query('UPDATE accounts SET balance=$1,updated_at=now() WHERE id=$2',[na,from.id]); await c.query('UPDATE accounts SET balance=$1,updated_at=now() WHERE id=$2',[nb,to.id]);
    await c.query('INSERT INTO transfers(id,from_account,to_account,amount,status,note,initiated_by,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())',[ref,from.id,to.id,p.amount,'COMPLETED',p.note||null,req.user.id]);
    await c.query('INSERT INTO ledger_entries(reference_id,account_id,entry_type,amount,balance_after,description) VALUES($1,$2,$3,$4,$5,$6),($1,$7,$8,$4,$9,$10)',[ref,from.id,'DEBIT',p.amount,na,p.note||'Transfer sent',to.id,'CREDIT',nb,p.note||'Transfer received']);
    await c.query('INSERT INTO notifications(user_id,title,message,type) VALUES($1,$2,$3,$4),($5,$6,$7,$8)',[from.user_id,'Transfer sent',`₹${p.amount.toFixed(2)} sent successfully.` ,'SUCCESS',to.user_id,'Funds received',`₹${p.amount.toFixed(2)} was credited to your account.` ,'SUCCESS']);
    await audit(c,req.user.id,'TRANSFER_COMPLETED',{referenceId:ref,amount:p.amount,fromAccount:from.id,toAccount:to.id}); await c.query('COMMIT'); send(res,201,{referenceId:ref,status:'COMPLETED',amount:p.amount},'Transfer completed');
  } catch(e){ await c.query('ROLLBACK'); error(res,e.status||400,e.code||'TRANSACTION_FAILED',e.message); } finally { c.release(); }
}));

const amountSchema=z.object({accountId:z.string().uuid(),amount:money,note:z.string().trim().max(200).optional()});
app.post('/api/deposits',auth,roles('ADMIN'),asyncRoute(async(req,res)=>{ const p=parse(amountSchema,req.body); const c=await pool.connect(); try{await c.query('BEGIN'); const a=(await c.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[p.accountId])).rows[0]; if(!a) throw Object.assign(new Error('Account not found'),{status:404,code:'ACCOUNT_NOT_FOUND'}); if(a.status!=='ACTIVE') throw Object.assign(new Error('Account is not active'),{status:409,code:'ACCOUNT_NOT_ACTIVE'}); const nb=(Number(a.balance)+p.amount).toFixed(2),ref=crypto.randomUUID(); await c.query('UPDATE accounts SET balance=$1,updated_at=now() WHERE id=$2',[nb,a.id]); await c.query('INSERT INTO deposits(id,account_id,amount,note,created_by) VALUES($1,$2,$3,$4,$5)',[ref,a.id,p.amount,p.note||null,req.user.id]); await c.query('INSERT INTO ledger_entries(reference_id,account_id,entry_type,amount,balance_after,description) VALUES($1,$2,$3,$4,$5,$6)',[ref,a.id,'CREDIT',p.amount,nb,p.note||'Deposit']); await audit(c,req.user.id,'DEPOSIT_COMPLETED',{referenceId:ref,accountId:a.id,amount:p.amount}); await c.query('COMMIT'); send(res,201,{referenceId:ref},'Deposit completed');}catch(e){await c.query('ROLLBACK');error(res,e.status||400,e.code||'DEPOSIT_FAILED',e.message)}finally{c.release()}}));
app.post('/api/withdrawals',auth,roles('ADMIN'),asyncRoute(async(req,res)=>{ const p=parse(amountSchema,req.body); const c=await pool.connect(); try{await c.query('BEGIN'); const a=(await c.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[p.accountId])).rows[0]; if(!a) throw Object.assign(new Error('Account not found'),{status:404,code:'ACCOUNT_NOT_FOUND'}); if(a.status!=='ACTIVE') throw Object.assign(new Error('Account is not active'),{status:409,code:'ACCOUNT_NOT_ACTIVE'}); if(Number(a.balance)<p.amount) throw Object.assign(new Error('Insufficient funds'),{status:409,code:'INSUFFICIENT_FUNDS'}); const nb=(Number(a.balance)-p.amount).toFixed(2),ref=crypto.randomUUID(); await c.query('UPDATE accounts SET balance=$1,updated_at=now() WHERE id=$2',[nb,a.id]); await c.query('INSERT INTO withdrawals(id,account_id,amount,note,created_by) VALUES($1,$2,$3,$4,$5)',[ref,a.id,p.amount,p.note||null,req.user.id]); await c.query('INSERT INTO ledger_entries(reference_id,account_id,entry_type,amount,balance_after,description) VALUES($1,$2,$3,$4,$5,$6)',[ref,a.id,'DEBIT',p.amount,nb,p.note||'Withdrawal']); await audit(c,req.user.id,'WITHDRAWAL_COMPLETED',{referenceId:ref,accountId:a.id,amount:p.amount}); await c.query('COMMIT'); send(res,201,{referenceId:ref},'Withdrawal completed');}catch(e){await c.query('ROLLBACK');error(res,e.status||400,e.code||'WITHDRAWAL_FAILED',e.message)}finally{c.release()}}));

app.get('/api/beneficiaries',auth,asyncRoute(async(req,res)=>{ const q=await pool.query('SELECT b.id,b.nickname,b.account_id,a.account_number FROM beneficiaries b JOIN accounts a ON a.id=b.account_id WHERE b.user_id=$1 ORDER BY b.created_at DESC',[req.user.id]); send(res,200,{rows:q.rows})}));
app.post('/api/beneficiaries',auth,asyncRoute(async(req,res)=>{const p=parse(z.object({accountId:z.string().uuid(),nickname:z.string().trim().min(1).max(60)}),req.body); const a=await pool.query('SELECT id FROM accounts WHERE id=$1',[p.accountId]); if(!a.rowCount)return error(res,404,'ACCOUNT_NOT_FOUND','Destination account not found'); try{const q=await pool.query('INSERT INTO beneficiaries(user_id,account_id,nickname) VALUES($1,$2,$3) RETURNING *',[req.user.id,p.accountId,p.nickname]);send(res,201,{beneficiary:q.rows[0]},'Beneficiary saved')}catch(e){if(e.code==='23505')return error(res,409,'DUPLICATE_BENEFICIARY','Beneficiary already exists');throw e}}));
app.delete('/api/beneficiaries/:id',auth,asyncRoute(async(req,res)=>{await pool.query('DELETE FROM beneficiaries WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);send(res,200,{},'Beneficiary removed')}));
app.get('/api/notifications',auth,asyncRoute(async(req,res)=>{const q=await pool.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',[req.user.id]);send(res,200,{rows:q.rows})}));
app.patch('/api/notifications/:id/read',auth,asyncRoute(async(req,res)=>{await pool.query('UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);send(res,200,{},'Notification marked read')}));

app.get('/api/admin/overview',auth,roles('ADMIN','AUDITOR'),asyncRoute(async(req,res)=>{
  try {
    const q = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM users WHERE role='CUSTOMER') AS customers,
        (SELECT count(*)::int FROM accounts WHERE status='ACTIVE') AS active_accounts,
        (SELECT coalesce(sum(balance),0)::numeric FROM accounts WHERE status='ACTIVE') AS total_balances,
        (SELECT count(*)::int FROM transfers WHERE status='COMPLETED') AS total_transfers,
        (SELECT coalesce(sum(amount),0)::numeric FROM transfers WHERE status='COMPLETED') AS total_transfer_volume,
        (SELECT count(*)::int FROM accounts WHERE status='FROZEN') AS frozen_accounts,
        (SELECT count(*)::int FROM transfers WHERE status='FAILED') AS failed_transfers
    `);
    const daily = await pool.query(`
      SELECT created_at::date AS day, count(*)::int AS count, coalesce(sum(amount),0)::numeric AS total
      FROM transfers
      WHERE status='COMPLETED' AND created_at >= now() - interval '30 days'
      GROUP BY created_at::date ORDER BY day
    `);
    const r=q.rows[0];
    send(res,200,{customers:r.customers,activeAccounts:r.active_accounts,totalBalances:r.total_balances,totalTransfers:r.total_transfers,totalTransferVolume:r.total_transfer_volume,frozenAccounts:r.frozen_accounts,failedTransfers:r.failed_transfers,daily:daily.rows});
  } catch (e) {
    console.error('ADMIN_OVERVIEW_SQL_ERROR', e);
    throw Object.assign(new Error(`Admin overview database query failed: ${e.message}`),{status:500,code:'ADMIN_OVERVIEW_DB_ERROR'});
  }
}));
app.get('/api/admin/users',auth,roles('ADMIN','AUDITOR'),asyncRoute(async(_,res)=>{const q=await pool.query("SELECT id,full_name,email,role,status,created_at,last_login_at FROM users ORDER BY created_at DESC");send(res,200,{rows:q.rows})}));
app.patch('/api/admin/users/:id/status',auth,roles('ADMIN'),asyncRoute(async(req,res)=>{const p=parse(z.object({status:z.enum(['ACTIVE','SUSPENDED'])}),req.body);await pool.query('UPDATE users SET status=$1 WHERE id=$2',[p.status,req.params.id]);await pool.query('INSERT INTO audit_logs(user_id,action,metadata) VALUES($1,$2,$3)',[req.user.id,'USER_STATUS_CHANGED',JSON.stringify({target:req.params.id,status:p.status})]);send(res,200,{},'User status updated')}));
app.get('/api/admin/accounts',auth,roles('ADMIN','AUDITOR'),asyncRoute(async(_,res)=>{const q=await pool.query('SELECT a.*,u.full_name,u.email FROM accounts a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC');send(res,200,{rows:q.rows})}));
app.post('/api/admin/accounts',auth,roles('ADMIN'),asyncRoute(async(req,res)=>{const p=parse(z.object({userId:z.string().uuid(),accountType:z.enum(['SAVINGS','CURRENT']).default('SAVINGS'),initialBalance:z.coerce.number().min(0).max(100000000).default(0)}),req.body);const c=await pool.connect();try{await c.query('BEGIN');const n='SB'+crypto.randomInt(100000000000,999999999999);const a=(await c.query('INSERT INTO accounts(user_id,account_number,account_type,balance) VALUES($1,$2,$3,$4) RETURNING *',[p.userId,n,p.accountType,p.initialBalance])).rows[0];if(p.initialBalance>0){const ref=crypto.randomUUID();await c.query('INSERT INTO ledger_entries(reference_id,account_id,entry_type,amount,balance_after,description) VALUES($1,$2,$3,$4,$5,$6)',[ref,a.id,'CREDIT',p.initialBalance,p.initialBalance,'Opening balance'])}await audit(c,req.user.id,'ACCOUNT_CREATED',{accountId:a.id,userId:p.userId});await c.query('COMMIT');send(res,201,{account:a},'Account created')}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}));
app.patch('/api/admin/accounts/:id/status',auth,roles('ADMIN'),asyncRoute(async(req,res)=>{const p=parse(z.object({status:z.enum(['ACTIVE','FROZEN','CLOSED'])}),req.body);await pool.query('UPDATE accounts SET status=$1,updated_at=now() WHERE id=$2',[p.status,req.params.id]);await pool.query('INSERT INTO audit_logs(user_id,action,metadata) VALUES($1,$2,$3)',[req.user.id,'ACCOUNT_STATUS_CHANGED',JSON.stringify({accountId:req.params.id,status:p.status})]);send(res,200,{},'Account status updated')}));
app.get('/api/admin/transactions',auth,roles('ADMIN','AUDITOR'),asyncRoute(async(req,res)=>{const p=parse(z.object({search:z.string().optional(),page:z.coerce.number().int().min(1).default(1),limit:z.coerce.number().int().min(1).max(100).default(50)}),req.query);const vals=[];let where='TRUE';if(p.search){vals.push(`%${p.search}%`);where=`(t.id::text ILIKE $1 OR fa.account_number ILIKE $1 OR ta.account_number ILIKE $1 OR t.status ILIKE $1)`}vals.push(p.limit,p.limit*(p.page-1));const rows=await pool.query(`SELECT t.*,fa.account_number from_account_number,ta.account_number to_account_number,uf.full_name from_name,ut.full_name to_name FROM transfers t JOIN accounts fa ON fa.id=t.from_account JOIN accounts ta ON ta.id=t.to_account JOIN users uf ON uf.id=fa.user_id JOIN users ut ON ut.id=ta.user_id WHERE ${where} ORDER BY t.created_at DESC LIMIT $${vals.length-1} OFFSET $${vals.length}`,vals);send(res,200,{rows:rows.rows})}));
app.get('/api/admin/audit-logs',auth,roles('ADMIN','AUDITOR'),asyncRoute(async(_,res)=>{const q=await pool.query('SELECT l.*,u.full_name,u.email FROM audit_logs l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.created_at DESC LIMIT 500');send(res,200,{rows:q.rows})}));
app.get('/api/admin/reports',auth,roles('ADMIN','AUDITOR'),asyncRoute(async(_,res)=>{
  try {
    const [topCustomers,daily,byStatus] = await Promise.all([
      pool.query(`SELECT u.full_name,u.email,count(t.id)::int AS transaction_count,coalesce(sum(t.amount),0)::numeric AS volume FROM users u JOIN accounts a ON a.user_id=u.id JOIN transfers t ON t.from_account=a.id WHERE t.status='COMPLETED' GROUP BY u.id,u.full_name,u.email ORDER BY volume DESC LIMIT 10`),
      pool.query(`SELECT created_at::date AS day,count(*)::int AS count,coalesce(sum(amount),0)::numeric AS volume FROM transfers WHERE status='COMPLETED' AND created_at>=now()-interval '30 days' GROUP BY created_at::date ORDER BY day`),
      pool.query(`SELECT status,count(*)::int AS count FROM transfers GROUP BY status ORDER BY count DESC`)
    ]);
    send(res,200,{topCustomers:topCustomers.rows,daily:daily.rows,byStatus:byStatus.rows});
  } catch (e) {
    console.error('ADMIN_REPORTS_SQL_ERROR', e);
    throw Object.assign(new Error(`Reports database query failed: ${e.message}`),{status:500,code:'ADMIN_REPORTS_DB_ERROR'});
  }
}));

app.use((req,res)=>error(res,404,'NOT_FOUND','Endpoint not found'));
app.use((err,req,res,next)=>{ console.error(err); if(res.headersSent)return next(err); error(res,err.status||500,err.code||'INTERNAL_ERROR',err.status?err.message:'Internal server error'); });

async function seed(){
  const c=await pool.connect(); try{const count=(await c.query('SELECT count(*)::int count FROM users')).rows[0].count;if(count>0)return;await c.query('BEGIN');
    const ah=await bcrypt.hash('Admin@12345',12); const admin=(await c.query("INSERT INTO users(full_name,email,password_hash,role) VALUES('System Admin','admin@securebank.local',$1,'ADMIN') RETURNING id",[ah])).rows[0]; await c.query("INSERT INTO accounts(user_id,account_number,balance) VALUES($1,'SBADMIN000001',100000)",[admin.id]);
    const uh=await bcrypt.hash('User@12345',12); const u=(await c.query("INSERT INTO users(full_name,email,password_hash) VALUES('Demo Customer','user@securebank.local',$1) RETURNING id",[uh])).rows[0]; const a=(await c.query("INSERT INTO accounts(user_id,account_number,balance) VALUES($1,'SBDEMO000001',25000) RETURNING id",[u.id])).rows[0];
    const u2=(await c.query("INSERT INTO users(full_name,email,password_hash) VALUES('Alex Sharma','alex@securebank.local',$1) RETURNING id",[uh])).rows[0]; const a2=(await c.query("INSERT INTO accounts(user_id,account_number,balance) VALUES($1,'SBDEMO000002',15000) RETURNING id",[u2.id])).rows[0];
    await c.query('INSERT INTO ledger_entries(reference_id,account_id,entry_type,amount,balance_after,description) VALUES($1,$2,$3,$4,$5,$6),($7,$8,$9,$10,$11,$12)',[crypto.randomUUID(),a.id,'CREDIT',25000,25000,'Opening balance',crypto.randomUUID(),a2.id,'CREDIT',15000,15000,'Opening balance']);
    await c.query('COMMIT'); console.log('Seeded demo accounts.');
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}

async function start(){
  for(let i=0;i<30;i++){
    try{
      await pool.query('SELECT 1');
      await ensureSchema();
      await seed();
      app.listen(PORT,()=>console.log(`SecureBank API listening on ${PORT}`));
      return;
    }catch(e){
      console.log(`Waiting for PostgreSQL/schema... ${e.message}`);
      await new Promise(r=>setTimeout(r,2000));
    }
  }
  console.error('SecureBank could not initialize PostgreSQL schema.');
  process.exit(1);
}
start();

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const ROOT = process.cwd();
const SKIP = new Set(['20250101000005_storage_and_alerts.sql','20250101000019_push.sql','20250101000024_push_delivery.sql']);
const names = readdirSync(join(ROOT,'supabase/migrations')).filter(n=>/^\d+_.*\.sql$/.test(n)).sort();
const read = n => readFileSync(join(ROOT,'supabase/migrations',n),'utf8');
const harness = readFileSync(join(ROOT,'scripts/pg/support-tickets-harness.mjs'),'utf8');
const shim = harness.split('const SUPABASE_SHIM = `')[1].split('`;')[0];

const SENDER = '11111111-1111-1111-1111-111111111111';
const DRIVER = '33333333-3333-3333-3333-333333333333';
const ADMIN  = '44444444-4444-4444-4444-444444444444';

const db = await PGlite.create();
await db.exec(shim);
for (const n of names) if (!SKIP.has(n)) await db.exec(read(n));

await db.exec(`
  create table public.who (id uuid);
  create or replace function auth.uid() returns uuid language sql stable as $fn$
    select id from public.who limit 1 $fn$;
  grant select on public.who to authenticated;
  insert into auth.users (id, email, phone) values
    ('${SENDER}','s@pkrelay.test','08030000001'),
    ('${DRIVER}','d@pkrelay.test','08030000002'),
    ('${ADMIN}','a@pkrelay.test','08030000003');
  update public.profiles set full_name='Test Sender' where id='${SENDER}';
  update public.profiles set full_name='Test Driver' where id='${DRIVER}';
  update public.profiles set full_name='Test Admin', is_admin=true where id='${ADMIN}';
  insert into public.sender_identity (user_id, status, verified_at)
    values ('${SENDER}','verified',now())
    on conflict (user_id) do update set status='verified', verified_at=now();
  insert into public.driver_applications (
    user_id, reference, full_name, phone, email, nin, address, state,
    vehicle_type, plate_number, license_id,
    guarantor_name, guarantor_phone, guarantor_relationship, guarantor_address, guarantor_nin,
    bank_name, account_number, account_name, kin_name, kin_phone, kin_relationship, status
  ) values (
    '${DRIVER}','PKR-D-1','Test Driver','08030000002','d@pkrelay.test','12345678901','1 Rd','Lagos',
    'bike','ABC-1','DL-1','G','08030000004','Brother','2 Rd','12345678902',
    'Bank','0123456789','Test Driver','K','08030000005','Sister','approved');
  alter table public.driver_applications disable trigger user;
  update public.driver_applications set status='approved', reviewed_at=now() where user_id='${DRIVER}';
  alter table public.driver_applications enable trigger user;
`);

const asUser = async (id) => {
  await db.exec(`reset role; delete from public.who; insert into public.who (id) values ('${id}');`);
  await db.exec('set role authenticated');
};

await db.exec('reset role');
const session = await db.query(
  `insert into public.photo_capture_sessions (owner_id, photo_path, completed_at, liveness_status, liveness_environment, liveness_checked_at)
   values ($1, 'sender-photo/x.jpg', now(), 'passed', 'sandbox', now()) returning id`, [SENDER]);

await asUser(SENDER);
const parcel = await db.query(
  `insert into public.bookings
     (tracking_id, delivery_type, pickup_mode, dropoff_mode, origin_city, destination_city,
      item_description, category, weight, estimated_fee, sender_id, status, capture_session_id)
   values ('PKR-A-1','local','hub','hub','Ibadan','Ibadan','A box','documents',2,2800,$1,'Booked',$2)
   returning id, driver, driver_id`, [SENDER, session.rows[0].id]);

console.log('parcel created:', JSON.stringify(parcel.rows[0]));

await asUser(ADMIN);
try {
  await db.query('select public.admin_assign_parcel($1, $2)', [parcel.rows[0].id, DRIVER]);
  await db.exec('reset role');
  const after = await db.query('select driver_id, driver, status from public.bookings where id = $1', [parcel.rows[0].id]);
  console.log('ASSIGN OK ->', JSON.stringify(after.rows[0]));
} catch (error) {
  console.log('ASSIGN FAILED ->', error.message);
}
await db.close();

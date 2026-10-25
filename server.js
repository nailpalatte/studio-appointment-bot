import express from 'express';
import Database from 'better-sqlite3';

const {
  TOKEN, PHONE_ID, VERIFY_TOKEN,
  STAFF = '',            // allowed numbers, e.g. 919876543210,919812345678
  CAPACITY = '1',        // number of nail technicians working at the same time
  OPEN = '10:00', CLOSE = '20:00', PORT = 3000,
} = process.env;

const staff = STAFF.split(',').map(s => s.trim()).filter(Boolean);
const cap = Number(CAPACITY);
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const openMin = toMin(OPEN), closeMin = toMin(CLOSE);

const db = new Database(process.env.DB_PATH || 'salon.db');
db.exec(`create table if not exists appt(
  id integer primary key autoincrement, date text, start_min int, end_min int,
  name text, phone text, service text, status text default 'booked')`);

// ---------- helpers ----------
const pad = n => String(n).padStart(2, '0');
const fmt = m => { let h = Math.floor(m / 60); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${pad(m % 60)} ${ap}`; };
const ist = () => new Date(Date.now() + 5.5 * 3600e3);
const iso = d => d.toISOString().slice(0, 10);
const dd = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

function pDate(s = '') {
  s = s.toLowerCase();
  if (s === 'today') return iso(ist());
  if (s === 'tomorrow') return iso(new Date(ist().getTime() + 864e5));
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/);
  if (!m) throw new Error('Date not understood. Use 28/10, today or tomorrow.');
  let y = m[3] ? Number(m[3]) : ist().getUTCFullYear();
  if (y < 100) y += 2000;
  const d = new Date(Date.UTC(y, m[2] - 1, m[1]));
  if (d.getUTCMonth() !== m[2] - 1) throw new Error('Invalid date.');
  return iso(d);
}

function pTime(s = '') {
  const m = s.toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) throw new Error('Time not understood. Use 3pm, 3:30pm or 15:00.');
  let h = Number(m[1]); const mi = Number(m[2] || 0);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (!m[3] && h < 9) h += 12; // no am/pm: 3 -> 3 PM
  if (h > 23 || mi > 59) throw new Error('Invalid time.');
  return h * 60 + mi;
}

const line = r => `#${r.id}  ${fmt(r.start_min)}–${fmt(r.end_min)}  ${r.name} (${r.phone})  ${r.service}`;
const rowsFor = date => db.prepare(`select * from appt where date=? and status='booked' order by start_min`).all(date);

// returns conflicting rows if the new slot would exceed capacity, else null
function conflicts(date, s, e, ignoreId = 0) {
  const rows = db.prepare(
    `select * from appt where date=? and status='booked' and id!=? and start_min<? and end_min>?`
  ).all(date, ignoreId, e, s);
  const points = [s, ...rows.map(r => r.start_min).filter(x => x > s)];
  for (const p of points) {
    const busy = rows.filter(r => r.start_min <= p && r.end_min > p);
    if (busy.length >= cap) return busy;
  }
  return null;
}

function checkHours(s, e) {
  if (s < openMin || e > closeMin) throw new Error(`Outside working hours (${fmt(openMin)}–${fmt(closeMin)}).`);
}

// ---------- commands ----------
const HELP = `*Salon bot commands*
book 28/10 3pm, Priya, 9876543210, Gel manicure, 60
list  |  list tomorrow  |  list 28/10
upcoming  |  upcoming 14   (next N days, default 7)
free 28/10   (open slots)
move 12 29/10 4pm
cancel 12
(last number in "book" = minutes, default 60)`;

function book(arg) {
  const p = arg.split(',').map(x => x.trim());
  if (p.length < 4) throw new Error('Format: book 28/10 3pm, Name, Phone, Service, [minutes]');
  const [d, t] = p[0].split(/\s+/);
  const date = pDate(d), s = pTime(t), dur = Number(p[4] || 60);
  if (!dur || dur < 10) throw new Error('Duration must be minutes, e.g. 60.');
  const e = s + dur;
  checkHours(s, e);
  const c = conflicts(date, s, e);
  if (c) return `❌ Clash with:\n${c.map(line).join('\n')}\n\nSend "free ${d}" to see open slots.`;
  const id = db.prepare(`insert into appt(date,start_min,end_min,name,phone,service) values(?,?,?,?,?,?)`)
    .run(date, s, e, p[1], p[2], p[3]).lastInsertRowid;
  return `✅ Booked #${id}\n${dd(date)}  ${fmt(s)}–${fmt(e)}\n${p[1]} (${p[2]}) – ${p[3]}`;
}

function list(arg) {
  const date = pDate(arg);
  const rows = rowsFor(date);
  if (!rows.length) return `📅 ${dd(date)} — no appointments.`;
  return `📅 *${dd(date)}* — ${rows.length} appointment(s)\n\n${rows.map(line).join('\n')}`;
}

function upcoming(arg) {
  const n = Math.min(Number(arg) || 7, 60);
  const from = iso(ist());
  const to = iso(new Date(ist().getTime() + n * 864e5));
  const rows = db.prepare(
    `select * from appt where status='booked' and date>=? and date<=? order by date, start_min`
  ).all(from, to);
  if (!rows.length) return `No appointments in the next ${n} days.`;
  const byDate = {};
  for (const r of rows) (byDate[r.date] ||= []).push(r);
  return Object.entries(byDate)
    .map(([d, rs]) => `📅 *${dd(d)}* (${rs.length})\n${rs.map(line).join('\n')}`)
    .join('\n\n');
}

function free(arg) {
  const date = pDate(arg);
  const rows = rowsFor(date);
  const out = []; let from = null;
  for (let m = openMin; m < closeMin; m += 30) {
    const busy = rows.filter(r => r.start_min < m + 30 && r.end_min > m).length >= cap;
    if (!busy && from === null) from = m;
    if (busy && from !== null) { out.push(`${fmt(from)}–${fmt(m)}`); from = null; }
  }
  if (from !== null) out.push(`${fmt(from)}–${fmt(closeMin)}`);
  return `🟢 Free on ${dd(date)}:\n${out.join('\n') || 'Fully booked'}`;
}

function cancel(arg) {
  const id = Number(arg.replace('#', ''));
  const r = db.prepare(`select * from appt where id=? and status='booked'`).get(id);
  if (!r) throw new Error('Appointment not found.');
  db.prepare(`update appt set status='cancelled' where id=?`).run(id);
  return `🗑️ Cancelled\n${dd(r.date)} ${line(r)}`;
}

function move(arg) {
  const [idRaw, d, t] = arg.split(/\s+/);
  const id = Number(String(idRaw).replace('#', ''));
  const r = db.prepare(`select * from appt where id=? and status='booked'`).get(id);
  if (!r) throw new Error('Appointment not found.');
  const date = pDate(d), s = pTime(t), e = s + (r.end_min - r.start_min);
  checkHours(s, e);
  const c = conflicts(date, s, e, id);
  if (c) return `❌ Clash with:\n${c.map(line).join('\n')}`;
  db.prepare(`update appt set date=?, start_min=?, end_min=? where id=?`).run(date, s, e, id);
  return `🔁 Moved #${id} to ${dd(date)} ${fmt(s)}–${fmt(e)}`;
}

function handle(text) {
  const m = text.trim().match(/^(\w+)\s*([\s\S]*)$/);
  if (!m) return HELP;
  const cmd = m[1].toLowerCase(), arg = m[2].trim();
  try {
    if (cmd === 'book') return book(arg);
    if (cmd === 'list') return list(arg || 'today');
    if (cmd === 'upcoming') return upcoming(arg);
    if (cmd === 'free') return free(arg || 'today');
    if (cmd === 'cancel') return cancel(arg);
    if (cmd === 'move') return move(arg);
  } catch (e) { return '❌ ' + e.message; }
  return HELP;
}

// ---------- WhatsApp Cloud API ----------
async function send(to, body) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  if (!r.ok) console.error('Send failed', await r.text());
}

const app = express();
app.use(express.json());

app.get('/webhook', (q, r) =>
  q.query['hub.verify_token'] === VERIFY_TOKEN ? r.send(q.query['hub.challenge']) : r.sendStatus(403));

app.post('/webhook', async (q, r) => {
  r.sendStatus(200);
  try {
    const m = q.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!m || m.type !== 'text') return;
    if (staff.length && !staff.includes(m.from)) return send(m.from, 'Not authorised.');
    await send(m.from, handle(m.text.body));
  } catch (e) { console.error(e); }
});

app.get('/', (_, r) => r.send('Salon bot running'));
app.listen(PORT, () => console.log('Listening on', PORT));

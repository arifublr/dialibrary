'use strict';
/** Circulation desk: librarians and admins. */
const express = require('express');
const crypto = require('crypto');
const { sql, nosql } = require('../db');
const circ = require('../circ');
const settings = require('../settings');
const A = require('../auth');
const { wrap, str, int, HttpError, bad, DAY } = require('../util');

const r = express.Router();
r.use(A.requireRole('librarian', 'admin'));

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

r.get('/stats', wrap(async (req, res) => {
  const now = new Date().toISOString();
  const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
  const open = (await sql.prepare(`SELECT COUNT(*) c FROM loans WHERE returned_at IS NULL`).get()).c;
  const overdue = (await sql.prepare(`SELECT COUNT(*) c FROM loans WHERE returned_at IS NULL AND due_at < ?`).get(now)).c;
  const dueToday = (await sql.prepare(`SELECT COUNT(*) c FROM loans WHERE returned_at IS NULL AND due_at >= ? AND due_at <= ?`).get(now, endToday.toISOString())).c;
  const since = new Date(Date.now() - 7 * DAY).toISOString();
  const out7 = await sql.prepare(`SELECT substr(out_at,1,10) d, COUNT(*) c FROM loans WHERE out_at >= ? GROUP BY d`).all(since);
  const waiting = await nosql.holds.countAsync({ status: 'waiting' });
  const pending = await nosql.holds.countAsync({ status: 'pending' });
  const fines = await nosql.fines.findAsync({ status: 'unpaid' });
  const titles = (await sql.prepare('SELECT COUNT(*) c FROM biblio').get()).c;
  const items = (await sql.prepare('SELECT COUNT(*) c FROM items').get()).c;
  res.json({
    openLoans: open, overdue, dueToday, holdsWaiting: waiting, holdsPending: pending,
    unpaidFines: fines.reduce((t, f) => t + f.amount, 0), unpaidCount: fines.length,
    students: await nosql.users.countAsync({ role: 'student', active: true }),
    titles, items,
    loansPerDay: out7,
  });
}));

/* ----- patrons ----- */
const patronRow = (u) => ({ id: u._id, name: u.name, cardNumber: u.cardNumber, username: u.username, className: u.className || '', department: u.department || '', email: u.email || '', active: u.active });

r.get('/patrons', wrap(async (req, res) => {
  const q = str(req.query.q, { max: 60 });
  const base = { role: 'student' };
  if (q) { const re = new RegExp(escRe(q), 'i'); base.$or = [{ name: re }, { cardNumber: re }, { username: re }, { className: re }, { department: re }]; }
  const list = await nosql.users.findAsync(base).sort({ name: 1 }).limit(60);
  const out = [];
  for (const u of list) {
    const loans = await circ.openLoansFor(u._id);
    out.push({ ...patronRow(u), loans: loans.length, overdue: loans.filter((l) => l.overdue).length, owed: await circ.unpaidTotal(u._id) });
  }
  res.json({ patrons: out });
}));

r.get('/patrons/:id', wrap(async (req, res) => {
  const u = await nosql.users.findOneAsync({ _id: req.params.id, role: 'student' });
  if (!u) throw new HttpError(404, 'Student not found');
  const openLoans = await circ.openLoansFor(u._id);
  const loans = await circ.annotateRenewable(openLoans);
  res.json({
    patron: { ...patronRow(u), joined: u.createdAt, lastLogin: u.lastLogin || null, passkeys: (u.passkeys || []).length },
    loans, history: await circ.historyFor(u._id, 25),
    fines: await nosql.fines.findAsync({ patronId: u._id }).sort({ createdAt: -1 }),
    holds: await nosql.holds.findAsync({ patronId: u._id, status: { $in: ['pending', 'waiting'] } }),
    owed: await circ.unpaidTotal(u._id), accruing: loans.reduce((t, l) => t + l.accruedFine, 0),
  });
}));

r.post('/patrons', wrap(async (req, res) => {
  const name = str(req.body.name, { max: 80, min: 2, name: 'Name' });
  let card = str(req.body.cardNumber, { max: 20 });
  if (!card) {
    do { card = 'S' + new Date().getFullYear() + String(crypto.randomInt(0, 10000)).padStart(4, '0'); }
    while (await nosql.users.findOneAsync({ cardNumber: card }));
  }
  const username = (str(req.body.username, { max: 40 }) || card).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw bad('Username may use letters, numbers, dot, dash and underscore (3 to 40)');
  if (await nosql.users.findOneAsync({ $or: [{ username }, { cardNumber: card }] })) throw new HttpError(409, 'That username or card number is already in use');
  const temp = crypto.randomBytes(6).toString('base64url') + crypto.randomInt(10, 99);
  const doc = await nosql.users.insertAsync({
    role: 'student', name, username, cardNumber: card, email: str(req.body.email, { max: 120 }),
    className: str(req.body.className, { max: 40 }), department: str(req.body.department, { max: 60 }),
    passHash: await A.hashPassword(temp), mustChangePassword: true, active: true, passkeys: [], createdAt: new Date().toISOString(),
  });
  await A.audit(req, 'patron.create', { card });
  res.json({ patron: patronRow(doc), tempPassword: temp });
}));

/* ----- circulation ----- */
r.post('/checkout', wrap(async (req, res) => {
  const out = await circ.checkout({
    staff: req.user, cardNumber: str(req.body.cardNumber, { max: 30, min: 1, name: 'Card number' }),
    barcode: str(req.body.barcode, { max: 40, min: 1, name: 'Item barcode' }), override: req.body.override === true,
  });
  await A.audit(req, 'checkout', { loanId: out.loanId, override: !!req.body.override });
  res.json(out);
}));
r.post('/checkin', wrap(async (req, res) => {
  const out = await circ.checkin({ barcode: str(req.body.barcode, { max: 40, min: 1, name: 'Item barcode' }) });
  await A.audit(req, 'checkin', { barcode: req.body.barcode, fine: out.fine ? out.fine.amount : 0 });
  res.json(out);
}));
r.post('/renew/:loanId', wrap(async (req, res) => {
  const out = await circ.renew(int(req.params.loanId, { min: 1, name: 'loan' }));
  await A.audit(req, 'loan.renew', { loanId: req.params.loanId, by: 'staff' });
  res.json(out);
}));

r.get('/loans', wrap(async (req, res) => {
  const mode = req.query.mode === 'overdue' ? 'overdue' : 'out';
  const isOverdue = mode === 'overdue';
  const query = `${circ.LOAN_SELECT} WHERE l.returned_at IS NULL ${isOverdue ? 'AND l.due_at < ?' : ''} ORDER BY l.due_at LIMIT 300`;
  const args = isOverdue ? [new Date().toISOString()] : [];
  const rows = (await sql.prepare(query).all(...args)).map((l) => circ.decorateLoan(l));
  const card = {};
  for (const l of rows) if (!(l.patronId in card)) { const u = await nosql.users.findOneAsync({ _id: l.patronId }); card[l.patronId] = u ? u.cardNumber : ''; }
  res.json({ loans: rows.map((l) => ({ ...l, cardNumber: card[l.patronId] })) });
}));

r.get('/holds', wrap(async (req, res) => {
  const holds = await nosql.holds.findAsync({ status: { $in: ['pending', 'waiting'] } }).sort({ createdAt: 1 });
  const mapped = await Promise.all(holds.map(async (h) => {
    const b = (await sql.prepare('SELECT title FROM biblio WHERE id=?').get(h.biblioId)) || {};
    return { id: h._id, title: b.title, patronName: h.patronName, status: h.status, barcode: h.barcode, expiresAt: h.expiresAt, createdAt: h.createdAt };
  }));
  res.json({ holds: mapped });
}));

/* ----- fines ----- */
r.post('/fines/:id/pay', wrap(async (req, res) => {
  const n = await nosql.fines.updateAsync({ _id: req.params.id, status: 'unpaid' },
    { $set: { status: 'paid', paidAt: new Date().toISOString(), receivedBy: req.user.name } });
  if (!n) throw new HttpError(404, 'Unpaid fine not found');
  await A.audit(req, 'fine.pay', { id: req.params.id });
  res.json({ ok: true });
}));
r.post('/fines/:id/waive', A.requireRole('admin'), wrap(async (req, res) => {
  const note = str(req.body.note, { max: 120, min: 3, name: 'Reason' });
  const n = await nosql.fines.updateAsync({ _id: req.params.id, status: 'unpaid' },
    { $set: { status: 'waived', paidAt: new Date().toISOString(), receivedBy: req.user.name, note } });
  if (!n) throw new HttpError(404, 'Unpaid fine not found');
  await A.audit(req, 'fine.waive', { id: req.params.id, note });
  res.json({ ok: true });
}));

/* ----- cataloguing ----- */
r.post('/biblio', wrap(async (req, res) => {
  const title = str(req.body.title, { max: 200, min: 1, name: 'Title' });
  const b = {
    author: str(req.body.author, { max: 150 }), isbn: str(req.body.isbn, { max: 20 }).replace(/[^0-9Xx-]/g, ''),
    publisher: str(req.body.publisher, { max: 100 }), year: req.body.year ? int(req.body.year, { min: 1000, max: 2100, name: 'Year' }) : null,
    language: str(req.body.language, { max: 40 }) || 'English',
    subjects: str(req.body.subjects, { max: 200 }).split(/[|;,]/).map((x) => x.trim()).filter(Boolean).join('|'),
    searchAliases: str(req.body.searchAliases, { max: 1000 }).split(/[|;]/).map((x) => x.trim()).filter(Boolean).join('|'),
    callNumber: str(req.body.callNumber, { max: 40 }), description: str(req.body.description, { max: 1500 }),
  };
  const copies = int(req.body.copies, { min: 1, max: 20, def: 1, name: 'Copies' });
  const info = await sql.prepare(`INSERT INTO biblio (title,author,isbn,publisher,year,language,subjects,search_aliases,call_number,description) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(title, b.author, b.isbn, b.publisher, b.year, b.language, b.subjects, b.searchAliases, b.callNumber, b.description);
  const barcodes = [];
  for (let i = 0; i < copies; i++) {
    barcodes.push(await addItem(info.lastInsertRowid, str(req.body.location, { max: 60 }) || 'Main Shelves', undefined,
      str(req.body.shelfNumber, { max: 40 })));
  }
  await A.audit(req, 'biblio.create', { id: info.lastInsertRowid, title });
  res.json({ id: info.lastInsertRowid, barcodes });
}));

async function nextBarcode() {
  const row = await sql.prepare(`SELECT MAX(CAST(substr(barcode,2) AS INTEGER)) m FROM items WHERE barcode LIKE 'B%'`).get();
  return 'B' + String((row?.m || 0) + 1).padStart(6, '0');
}
async function addItem(biblioId, location, barcode, shelfNumber = '') {
  const code = barcode || (await nextBarcode());
  await sql.prepare(`INSERT INTO items (biblio_id,barcode,location,shelf_number) VALUES (?,?,?,?)`).run(biblioId, code, location, shelfNumber);
  return code;
}
r.post('/items', wrap(async (req, res) => {
  const biblioId = int(req.body.biblioId, { min: 1, name: 'Record' });
  if (!(await sql.prepare('SELECT 1 FROM biblio WHERE id=?').get(biblioId))) throw new HttpError(404, 'Record not found');
  const bc = str(req.body.barcode, { max: 40 });
  if (bc && (await sql.prepare('SELECT 1 FROM items WHERE barcode=?').get(bc))) throw new HttpError(409, 'That barcode already exists');
  const code = await addItem(biblioId, str(req.body.location, { max: 60 }) || 'Main Shelves', bc,
    str(req.body.shelfNumber, { max: 40 }));
  await A.audit(req, 'item.create', { barcode: code });
  res.json({ barcode: code });
}));

r.patch('/items/:barcode', wrap(async (req, res) => {
  const hasStatus = 'status' in req.body;
  const hasShelfNumber = 'shelfNumber' in req.body;
  if (!hasStatus && !hasShelfNumber) throw bad('Nothing to update');
  const status = hasStatus ? str(req.body.status, { max: 20 }) : null;
  if (hasStatus && !['available', 'lost', 'withdrawn', 'repair'].includes(status)) throw bad('Status must be available, lost, withdrawn or repair');
  const shelfNumber = hasShelfNumber ? str(req.body.shelfNumber, { max: 40 }) : null;
  const it = await sql.prepare(`SELECT i.*, b.title FROM items i JOIN biblio b ON b.id=i.biblio_id WHERE i.barcode=?`).get(req.params.barcode);
  if (!it) throw new HttpError(404, 'Item not found');
  const loan = await sql.prepare(`SELECT * FROM loans WHERE item_id=? AND returned_at IS NULL`).get(it.id);
  if (hasStatus && loan && status !== 'lost') throw new HttpError(409, 'Check the item in before changing its status');
  if (hasStatus && loan && status === 'lost') {
    const s = settings.get();
    await sql.prepare(`UPDATE loans SET returned_at=? WHERE id=?`).run(new Date().toISOString(), loan.id);
    await nosql.fines.insertAsync({
      patronId: loan.patron_id, patronName: loan.patron_name, loanId: loan.id, kind: 'lost', title: it.title, barcode: it.barcode,
      dueAt: loan.due_at, returnedAt: null, daysOverdue: circ.overdueDays(loan.due_at, new Date()), billableDays: 0, ratePerDay: 0,
      amount: s.lostCharge, status: 'unpaid', createdAt: new Date().toISOString(),
    });
  }
  if (hasStatus) {
    await sql.prepare(`UPDATE items SET status=? WHERE id=?`).run(status, it.id);
    if (status === 'available') await circ.promoteNextHold(it.biblio_id);
  }
  if (hasShelfNumber) await sql.prepare('UPDATE items SET shelf_number=? WHERE id=?').run(shelfNumber, it.id);
  await A.audit(req, hasStatus ? 'item.status' : 'item.shelf_number', {
    barcode: it.barcode, ...(hasStatus ? { status } : {}), ...(hasShelfNumber ? { shelfNumber } : {}),
  });
  res.json({ ok: true, ...(hasStatus ? { status } : {}), ...(hasShelfNumber ? { shelfNumber } : {}) });
}));

module.exports = r;
module.exports.addItem = addItem;
module.exports.nextBarcode = nextBarcode;

# Crimson Page Library

An animated library website with three portals, modelled on the everyday features of Koha.

| Who | What they get |
|---|---|
| Student | OPAC search with facets, reservations, renewals, reading list, fines with days and rate |
| Librarian | Check in and out, every student's profile, overdue tracking, holds, cataloguing, fine payment |
| Admin | Everything above, plus Settings (loan rules, fines, grace period), CSV uploads, accounts, activity log, backups |

## Run it

```bash
npm install        # Node 22.5 or newer; nothing is compiled
npm run seed        # optional: demo books, students and loans (password: Library@2026)
npm start           # http://localhost:3000
```

Without the seed, the first start creates an `admin` account and prints a one-time password in the terminal.

Demo sign-ins after seeding: `admin`, `librarian`, `student` (card S20260001), all with `Library@2026`.

## Two databases

* **SQL (SQLite built into Node, `data/catalogue.sqlite`)**: titles, copies, loans, with full-text search. Counts always add up because loans and item status change in one transaction.
* **NoSQL (NeDB, `data/*.db`)**: users and passkeys, sessions, settings, holds, fines, audit log, reading lists.

## Sign-in and security

* Passkeys (WebAuthn) with user verification required, so fingerprint, face or device PIN. The server only stores public keys.
* Passwords hashed with scrypt, unique salt, constant-time compare, 10 character minimum, lockout after 5 failures for 15 minutes, same error for unknown users, forced change of temporary passwords.
* Sessions: random token in an HttpOnly, SameSite=Strict cookie (`__Host-` prefix in production), stored only as a hash, 30 minute idle and 8 hour absolute limits, all other sessions revoked on password change.
* CSRF: same-origin check, JSON only, per-session token header.
* Strict Content Security Policy (no inline scripts, no third-party hosts), HSTS in production, frame denial, Permissions-Policy, rate limits on the API and tighter limits on sign-in.
* Server-side role checks on every route, input validation, parameterised SQL, escaped HTML output, CSV export protected against formula injection.
* Every sensitive action is written to the activity log.

## Going live

Passkeys need HTTPS (localhost is exempt). Set these environment variables:

```bash
NODE_ENV=production
ORIGIN=https://library.example.edu     # exact public address
RP_ID=library.example.edu              # hostname only
TRUST_PROXY=1                          # when behind nginx, Caddy or a load balancer
PORT=3000
DATA_DIR=/var/lib/library              # persistent folder, back it up
```

## Uploading data

Admin > Settings > Upload data. Download the template for the column names. Student uploads return temporary passwords once, as a CSV you can hand out.

## Notes

* This is inspired by Koha's features. It does not connect to a Koha server or import MARC records.
* There is no email or SMS reminder yet. Overdue lists are on the librarian Loans page.
* NeDB is an embedded database suited to a single college library. For several servers, swap `server/db.js` for MongoDB.
"# library" 

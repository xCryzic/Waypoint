# WAYPOINT

A personal goal and roadmap tracker styled like a faded old PC quest log.

## Run locally

Requires Node.js 22.5 or newer.

```sh
npm install
npm start
```

Open `http://localhost:3000`. Register with a username and a password of at least eight characters. Application data is stored in `data/waypoint.db`; that directory is created automatically on first launch.

## Development

```sh
npm run dev
npm test
```

Authentication uses 64-byte scrypt password hashes with unique salts. Login sessions are random server-side tokens stored as SHA-256 hashes in SQLite and sent through HttpOnly, SameSite cookies.

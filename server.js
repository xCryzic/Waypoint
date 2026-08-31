import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'waypoint.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '◆',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','COMPLETED')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    completed INTEGER NOT NULL DEFAULT 0,
    x REAL NOT NULL DEFAULT 100,
    y REAL NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    source_milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
    target_milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
    UNIQUE(goal_id, source_milestone_id, target_milestone_id),
    CHECK(source_milestone_id != target_milestone_id)
  );
  CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_milestones_goal ON milestones(goal_id);
`);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const sha256 = value => createHash('sha256').update(value).digest('hex');
const isoAfterDays = days => new Date(Date.now() + days * 86400000).toISOString();

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(v => v.length === 2));
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function passwordMatches(password, stored) {
  const [salt, expectedHex] = stored.split(':');
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function issueSession(res, userId) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, isoAfterDays(30));
  res.cookie('waypoint_session', token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 86400000, path: '/' });
}

function auth(req, res, next) {
  const token = parseCookies(req.headers.cookie).waypoint_session;
  const user = token && db.prepare(`SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?`).get(sha256(token), new Date().toISOString());
  if (!user) return res.status(401).json({ error: 'Sign in to continue.' });
  req.user = user;
  next();
}

function cleanText(value, max, required = false) {
  if (typeof value !== 'string') return required ? null : '';
  const clean = value.trim().slice(0, max);
  return required && !clean ? null : clean;
}

function goalForUser(id, userId) {
  return db.prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?').get(id, userId);
}

function publicGoal(row) {
  return {
    id: row.id, title: row.title, description: row.description, category: row.category, icon: row.icon,
    status: row.status, createdAt: row.created_at, completedAt: row.completed_at,
    completedMilestones: Number(row.completed_milestones || 0), milestoneCount: Number(row.milestone_count || 0)
  };
}

app.post('/api/auth/register', (req, res) => {
  const username = cleanText(req.body.username, 24, true);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!username || !/^[a-zA-Z0-9_-]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–24 letters, numbers, dashes, or underscores.' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8–128 characters.' });
  try {
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
    issueSession(res, Number(result.lastInsertRowid));
    res.status(201).json({ user: { id: Number(result.lastInsertRowid), username } });
  } catch (error) {
    if (String(error).includes('UNIQUE')) return res.status(409).json({ error: 'That username is already in use.' });
    throw error;
  }
});

app.post('/api/auth/login', (req, res) => {
  const username = cleanText(req.body.username, 24, true);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = username && db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !passwordMatches(password, user.password_hash)) return res.status(401).json({ error: 'Incorrect username or password.' });
  issueSession(res, user.id);
  res.json({ user: { id: user.id, username: user.username } });
});

app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }));

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).waypoint_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie('waypoint_session', { path: '/' });
  res.status(204).end();
});

app.get('/api/goals', auth, (req, res) => {
  const rows = db.prepare(`SELECT g.*, COUNT(m.id) milestone_count, COALESCE(SUM(m.completed), 0) completed_milestones FROM goals g LEFT JOIN milestones m ON m.goal_id = g.id WHERE g.user_id = ? GROUP BY g.id ORDER BY CASE g.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, g.created_at DESC`).all(req.user.id);
  res.json({ goals: rows.map(publicGoal) });
});

app.post('/api/goals', auth, (req, res) => {
  const title = cleanText(req.body.title, 80, true);
  if (!title) return res.status(400).json({ error: 'Give this quest a name.' });
  const description = cleanText(req.body.description, 500);
  const category = cleanText(req.body.category, 32);
  const icon = cleanText(req.body.icon, 4) || '◆';
  const result = db.prepare('INSERT INTO goals (user_id, title, description, category, icon) VALUES (?, ?, ?, ?, ?)').run(req.user.id, title, description, category, icon);
  res.status(201).json({ goal: publicGoal(goalForUser(Number(result.lastInsertRowid), req.user.id)) });
});

app.get('/api/goals/:id', auth, (req, res) => {
  const goal = db.prepare(`SELECT g.*, COUNT(m.id) milestone_count, COALESCE(SUM(m.completed), 0) completed_milestones FROM goals g LEFT JOIN milestones m ON m.goal_id = g.id WHERE g.id = ? AND g.user_id = ? GROUP BY g.id`).get(req.params.id, req.user.id);
  if (!goal) return res.status(404).json({ error: 'Quest not found.' });
  const milestones = db.prepare('SELECT id, title, description, notes, completed, x, y, created_at createdAt, completed_at completedAt FROM milestones WHERE goal_id = ? ORDER BY id').all(goal.id).map(m => ({ ...m, completed: Boolean(m.completed) }));
  const connections = db.prepare('SELECT id, source_milestone_id sourceId, target_milestone_id targetId FROM connections WHERE goal_id = ?').all(goal.id);
  res.json({ goal: publicGoal(goal), milestones, connections });
});

app.patch('/api/goals/:id', auth, (req, res) => {
  const goal = goalForUser(req.params.id, req.user.id);
  if (!goal) return res.status(404).json({ error: 'Quest not found.' });
  let status = goal.status;
  if (req.body.status !== undefined) {
    if (!['ACTIVE', 'COMPLETED'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid quest status.' });
    status = req.body.status;
  }
  const title = req.body.title === undefined ? goal.title : cleanText(req.body.title, 80, true);
  if (!title) return res.status(400).json({ error: 'Quest name cannot be empty.' });
  const description = req.body.description === undefined ? goal.description : cleanText(req.body.description, 500);
  const category = req.body.category === undefined ? goal.category : cleanText(req.body.category, 32);
  const icon = req.body.icon === undefined ? goal.icon : (cleanText(req.body.icon, 4) || '◆');
  const completedAt = status === 'COMPLETED' ? (goal.completed_at || new Date().toISOString()) : null;
  db.prepare('UPDATE goals SET title=?, description=?, category=?, icon=?, status=?, completed_at=? WHERE id=?').run(title, description, category, icon, status, completedAt, goal.id);
  res.json({ goal: publicGoal(goalForUser(goal.id, req.user.id)) });
});

app.delete('/api/goals/:id', auth, (req, res) => {
  const result = db.prepare('DELETE FROM goals WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Quest not found.' });
  res.status(204).end();
});

app.post('/api/goals/:id/milestones', auth, (req, res) => {
  const goal = goalForUser(req.params.id, req.user.id);
  if (!goal) return res.status(404).json({ error: 'Quest not found.' });
  const title = cleanText(req.body.title, 60, true);
  if (!title) return res.status(400).json({ error: 'Give this milestone a title.' });
  const x = Math.max(24, Math.min(1376, Number(req.body.x) || 100));
  const y = Math.max(24, Math.min(876, Number(req.body.y) || 100));
  const result = db.prepare('INSERT INTO milestones (goal_id, title, description, notes, x, y) VALUES (?, ?, ?, ?, ?, ?)').run(goal.id, title, cleanText(req.body.description, 400), cleanText(req.body.notes, 2000), x, y);
  const milestone = db.prepare('SELECT id, title, description, notes, completed, x, y, created_at createdAt, completed_at completedAt FROM milestones WHERE id=?').get(Number(result.lastInsertRowid));
  res.status(201).json({ milestone: { ...milestone, completed: false } });
});

app.patch('/api/milestones/:id', auth, (req, res) => {
  const old = db.prepare('SELECT m.* FROM milestones m JOIN goals g ON g.id=m.goal_id WHERE m.id=? AND g.user_id=?').get(req.params.id, req.user.id);
  if (!old) return res.status(404).json({ error: 'Milestone not found.' });
  const title = req.body.title === undefined ? old.title : cleanText(req.body.title, 60, true);
  if (!title) return res.status(400).json({ error: 'Milestone title cannot be empty.' });
  const completed = req.body.completed === undefined ? old.completed : (req.body.completed ? 1 : 0);
  const x = req.body.x === undefined ? old.x : Math.max(24, Math.min(1376, Number(req.body.x) || 24));
  const y = req.body.y === undefined ? old.y : Math.max(24, Math.min(876, Number(req.body.y) || 24));
  const description = req.body.description === undefined ? old.description : cleanText(req.body.description, 400);
  const notes = req.body.notes === undefined ? old.notes : cleanText(req.body.notes, 2000);
  const completedAt = completed ? (old.completed_at || new Date().toISOString()) : null;
  db.prepare('UPDATE milestones SET title=?, description=?, notes=?, completed=?, x=?, y=?, completed_at=? WHERE id=?').run(title, description, notes, completed, x, y, completedAt, old.id);
  const m = db.prepare('SELECT id, title, description, notes, completed, x, y, created_at createdAt, completed_at completedAt FROM milestones WHERE id=?').get(old.id);
  res.json({ milestone: { ...m, completed: Boolean(m.completed) } });
});

app.delete('/api/milestones/:id', auth, (req, res) => {
  const result = db.prepare('DELETE FROM milestones WHERE id IN (SELECT m.id FROM milestones m JOIN goals g ON g.id=m.goal_id WHERE m.id=? AND g.user_id=?)').run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Milestone not found.' });
  res.status(204).end();
});

app.post('/api/goals/:id/connections', auth, (req, res) => {
  const goal = goalForUser(req.params.id, req.user.id);
  if (!goal) return res.status(404).json({ error: 'Quest not found.' });
  const sourceId = Number(req.body.sourceId), targetId = Number(req.body.targetId);
  const count = db.prepare('SELECT COUNT(*) count FROM milestones WHERE goal_id=? AND id IN (?, ?)').get(goal.id, sourceId, targetId).count;
  if (sourceId === targetId || count !== 2) return res.status(400).json({ error: 'Choose two different milestones from this quest.' });
  try {
    const result = db.prepare('INSERT INTO connections (goal_id, source_milestone_id, target_milestone_id) VALUES (?, ?, ?)').run(goal.id, sourceId, targetId);
    res.status(201).json({ connection: { id: Number(result.lastInsertRowid), sourceId, targetId } });
  } catch (error) {
    if (String(error).includes('UNIQUE')) return res.status(409).json({ error: 'Those milestones are already connected.' });
    throw error;
  }
});

app.delete('/api/connections/:id', auth, (req, res) => {
  const result = db.prepare('DELETE FROM connections WHERE id IN (SELECT c.id FROM connections c JOIN goals g ON g.id=c.goal_id WHERE c.id=? AND g.user_id=?)').run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Path not found.' });
  res.status(204).end();
});

app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Nothing was found here.' }));
app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'The system hit an unexpected snag.' });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`WAYPOINT is running at http://localhost:${port}`));
}

export { app, db, hashPassword, passwordMatches };

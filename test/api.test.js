import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('full quest API journey persists safely', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'waypoint-test-'));
  process.env.DATA_DIR = dataDir;
  const { app, db } = await import(`../server.js?test=${Date.now()}`);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.close(); db.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function request(route, options = {}) {
    const response = await fetch(base + route, { ...options, headers: { 'Content-Type': 'application/json', cookie, ...options.headers } });
    const session = response.headers.getSetCookie?.()[0];
    if (session) cookie = session.split(';')[0];
    const body = response.status === 204 ? null : await response.json();
    return { response, body };
  }

  let result = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'mapmaker', password: 'a-valid-password' }) });
  assert.equal(result.response.status, 201);
  assert.match(cookie, /^waypoint_session=/);
  const stored = db.prepare('SELECT password_hash FROM users WHERE username=?').get('mapmaker').password_hash;
  assert.notEqual(stored, 'a-valid-password');
  assert.equal(stored.includes('a-valid-password'), false);

  result = await request('/api/goals', { method: 'POST', body: JSON.stringify({ title: 'Learn Blender', description: 'Make a small scene', category: 'CRAFT', icon: '▣' }) });
  assert.equal(result.response.status, 201);
  const goalId = result.body.goal.id;

  result = await request(`/api/goals/${goalId}/milestones`, { method: 'POST', body: JSON.stringify({ title: 'Learn modeling', x: 120, y: 160 }) });
  const firstId = result.body.milestone.id;
  result = await request(`/api/goals/${goalId}/milestones`, { method: 'POST', body: JSON.stringify({ title: 'Build a scene', x: 420, y: 360 }) });
  const secondId = result.body.milestone.id;

  result = await request(`/api/goals/${goalId}/connections`, { method: 'POST', body: JSON.stringify({ sourceId: firstId, targetId: secondId }) });
  assert.equal(result.response.status, 201);
  await request(`/api/milestones/${firstId}`, { method: 'PATCH', body: JSON.stringify({ completed: true, notes: 'Finished the basics', x: 180 }) });
  await request(`/api/goals/${goalId}`, { method: 'PATCH', body: JSON.stringify({ status: 'COMPLETED' }) });

  result = await request(`/api/goals/${goalId}`);
  assert.equal(result.body.goal.status, 'COMPLETED');
  assert.ok(result.body.goal.completedAt);
  assert.equal(result.body.milestones.length, 2);
  assert.equal(result.body.milestones[0].completed, true);
  assert.equal(result.body.milestones[0].x, 180);
  assert.equal(result.body.connections.length, 1);

  await request('/api/auth/logout', { method: 'POST' });
  cookie = '';
  result = await request('/api/goals');
  assert.equal(result.response.status, 401);
});

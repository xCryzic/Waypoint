const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  user: null,
  goals: [],
  filter: 'ACTIVE',
  currentGoal: null,
  milestones: [],
  connections: [],
  goalEdit: false,
  milestoneEditId: null,
  connectMode: false,
  removePathMode: false,
  connectSource: null,
  drag: null
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.user) showAuth();
    throw new Error(data.error || 'Something went wrong.');
  }
  return data;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function showAuth() {
  state.user = null;
  $('#auth-screen').classList.remove('hidden');
  $('#app-screen').classList.add('hidden');
}

async function enterApp(user) {
  state.user = user;
  $('#player-name').textContent = `USER: ${user.username.toUpperCase()}`;
  $('#auth-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  await loadGoals();
  showHome();
}

async function loadGoals() {
  const data = await api('/api/goals');
  state.goals = data.goals;
  $('#active-count').textContent = state.goals.filter(g => g.status === 'ACTIVE').length;
  $('#complete-count').textContent = state.goals.filter(g => g.status === 'COMPLETED').length;
  renderGoals();
}

function renderGoals() {
  const goals = state.goals.filter(goal => goal.status === state.filter);
  const list = $('#goal-list');
  if (!goals.length) {
    const active = state.filter === 'ACTIVE';
    list.innerHTML = `<div class="empty-state"><span class="empty-glyph">${active ? '◇' : '▧'}</span><strong>${active ? 'NO ACTIVE QUESTS' : 'ARCHIVE IS EMPTY'}</strong><p>${active ? 'A blank map can be a fine place to start.' : 'Completed quests will be recorded here.'}</p>${active ? '<button class="button primary" data-empty-new>BEGIN A QUEST</button>' : ''}</div>`;
    list.querySelector('[data-empty-new]')?.addEventListener('click', openNewGoal);
    return;
  }
  list.innerHTML = goals.map((goal, index) => {
    const percent = goal.milestoneCount ? Math.round(goal.completedMilestones / goal.milestoneCount * 100) : 0;
    const completedDate = goal.completedAt ? new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(goal.completedAt)) : '';
    return `<button class="goal-row ${goal.status === 'COMPLETED' ? 'completed' : ''}" data-goal-id="${goal.id}">
      <span class="goal-number">${String(index + 1).padStart(2, '0')}</span>
      <span class="goal-name"><strong>${escapeHtml(goal.icon)} ${escapeHtml(goal.title)}</strong><small>${goal.status === 'COMPLETED' ? `COMPLETED ${escapeHtml(completedDate.toUpperCase())}` : escapeHtml(goal.category || 'UNCATEGORIZED')}</small></span>
      <span class="mini-progress"><span><i>${goal.completedMilestones} / ${goal.milestoneCount} MILESTONES</i><i>${percent}%</i></span><span class="mini-bar"><i style="width:${percent}%"></i></span></span>
      <span class="status-stamp">${goal.status}</span><span class="row-arrow">›</span>
    </button>`;
  }).join('');
  $$('.goal-row').forEach(row => row.addEventListener('click', () => openGoal(row.dataset.goalId)));
}

function showHome() {
  cancelBoardModes();
  $('#roadmap-view').classList.add('hidden');
  $('#home-view').classList.remove('hidden');
  window.scrollTo(0, 0);
}

async function openGoal(id) {
  try {
    const data = await api(`/api/goals/${id}`);
    state.currentGoal = data.goal;
    state.milestones = data.milestones;
    state.connections = data.connections;
    $('#home-view').classList.add('hidden');
    $('#roadmap-view').classList.remove('hidden');
    renderRoadmap();
    window.scrollTo(0, 0);
  } catch (error) { toast(error.message); }
}

function renderRoadmap() {
  const goal = state.currentGoal;
  const complete = goal.status === 'COMPLETED';
  $('#quest-icon').textContent = goal.icon;
  $('#quest-category').textContent = `${complete ? 'ARCHIVED QUEST' : (goal.category || 'ACTIVE QUEST')} / RECORD ${String(goal.id).padStart(4, '0')}`;
  $('#quest-title').textContent = goal.title;
  $('#quest-description').textContent = goal.description || 'No quest description recorded.';
  const done = state.milestones.filter(m => m.completed).length;
  const total = state.milestones.length;
  const percent = total ? Math.round(done / total * 100) : 0;
  $('#progress-label').textContent = `${done} / ${total} · ${percent}%`;
  $('#progress-bar').style.width = `${percent}%`;
  $('#complete-goal-button').textContent = complete ? '[ REOPEN QUEST ]' : '[ COMPLETE QUEST ]';
  $('#complete-goal-button').classList.toggle('complete', !complete);
  $('#board-empty').classList.toggle('hidden', total > 0);
  renderNodes();
  renderConnections();
}

function renderNodes() {
  const layer = $('#node-layer');
  layer.innerHTML = state.milestones.map(m => `<article class="milestone-node ${m.completed ? 'complete' : ''}" data-milestone-id="${m.id}" style="left:${m.x}px;top:${m.y}px" tabindex="0" role="button" aria-label="${escapeHtml(m.title)}, ${m.completed ? 'complete' : 'active'}">
    <span class="node-dot"></span><strong>${escapeHtml(m.title)}</strong><small>${m.completed ? 'COMPLETE' : 'MILESTONE'}</small>
  </article>`).join('');
  $$('.milestone-node').forEach(node => {
    node.addEventListener('pointerdown', startNodePointer);
    node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); nodeAction(Number(node.dataset.milestoneId)); } });
  });
}

function renderConnections() {
  const nodeById = new Map(state.milestones.map(m => [m.id, m]));
  $('#connection-lines').innerHTML = state.connections.map(connection => {
    const source = nodeById.get(connection.sourceId), target = nodeById.get(connection.targetId);
    if (!source || !target) return '';
    const x1 = source.x + 84, y1 = source.y + 31, x2 = target.x + 84, y2 = target.y + 31;
    const bend = Math.max(45, Math.abs(y2 - y1) * .42);
    const direction = y2 >= y1 ? 1 : -1;
    const d = `M ${x1} ${y1} C ${x1} ${y1 + bend * direction}, ${x2} ${y2 - bend * direction}, ${x2} ${y2}`;
    return `<path class="connection" d="${d}"></path><path class="connection hit" data-connection-id="${connection.id}" d="${d}"></path>`;
  }).join('');
  $$('.connection.hit').forEach(path => path.addEventListener('click', () => removeConnection(Number(path.dataset.connectionId))));
}

function startNodePointer(event) {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  const id = Number(event.currentTarget.dataset.milestoneId);
  if (state.connectMode) { event.preventDefault(); selectConnectionNode(id); return; }
  if (state.removePathMode) return;
  const milestone = state.milestones.find(m => m.id === id);
  state.drag = { id, node: event.currentTarget, startX: event.clientX, startY: event.clientY, x: milestone.x, y: milestone.y, moved: false };
  event.currentTarget.setPointerCapture(event.pointerId);
  event.currentTarget.addEventListener('pointermove', moveNodePointer);
  event.currentTarget.addEventListener('pointerup', endNodePointer, { once: true });
  event.currentTarget.addEventListener('pointercancel', endNodePointer, { once: true });
}

function moveNodePointer(event) {
  if (!state.drag) return;
  const dx = event.clientX - state.drag.startX, dy = event.clientY - state.drag.startY;
  if (Math.abs(dx) + Math.abs(dy) > 4) state.drag.moved = true;
  const x = Math.max(24, Math.min(1208, state.drag.x + dx));
  const y = Math.max(24, Math.min(820, state.drag.y + dy));
  state.drag.node.style.left = `${x}px`;
  state.drag.node.style.top = `${y}px`;
  const milestone = state.milestones.find(m => m.id === state.drag.id);
  milestone.x = x; milestone.y = y;
  renderConnections();
}

async function endNodePointer(event) {
  if (!state.drag) return;
  const drag = state.drag;
  drag.node.removeEventListener('pointermove', moveNodePointer);
  state.drag = null;
  if (!drag.moved) return nodeAction(drag.id);
  const milestone = state.milestones.find(m => m.id === drag.id);
  try { await api(`/api/milestones/${drag.id}`, { method: 'PATCH', body: JSON.stringify({ x: Math.round(milestone.x), y: Math.round(milestone.y) }) }); }
  catch (error) { toast(error.message); }
}

function nodeAction(id) {
  if (state.connectMode) return selectConnectionNode(id);
  if (!state.removePathMode) openMilestone(id);
}

function cancelBoardModes() {
  state.connectMode = false; state.removePathMode = false; state.connectSource = null;
  $('#roadmap-board')?.classList.remove('path-remove-mode');
  $('#connect-button')?.classList.remove('primary');
  $('#remove-path-button')?.classList.remove('primary');
  $$('.milestone-node').forEach(n => n.classList.remove('connect-source'));
  if ($('#board-hint')) $('#board-hint').textContent = 'DRAG TO ARRANGE • CLICK TO INSPECT';
}

function toggleConnectMode() {
  const turnOn = !state.connectMode;
  cancelBoardModes();
  state.connectMode = turnOn;
  $('#connect-button').classList.toggle('primary', turnOn);
  $('#board-hint').textContent = turnOn ? 'SELECT THE FIRST MILESTONE' : 'DRAG TO ARRANGE • CLICK TO INSPECT';
}

function toggleRemovePathMode() {
  const turnOn = !state.removePathMode;
  cancelBoardModes();
  state.removePathMode = turnOn;
  $('#remove-path-button').classList.toggle('primary', turnOn);
  $('#roadmap-board').classList.toggle('path-remove-mode', turnOn);
  $('#board-hint').textContent = turnOn ? 'CLICK A PATH TO REMOVE IT' : 'DRAG TO ARRANGE • CLICK TO INSPECT';
}

async function selectConnectionNode(id) {
  if (!state.connectSource) {
    state.connectSource = id;
    $(`.milestone-node[data-milestone-id="${id}"]`)?.classList.add('connect-source');
    $('#board-hint').textContent = 'NOW SELECT THE DESTINATION';
    return;
  }
  if (state.connectSource === id) { cancelBoardModes(); return; }
  try {
    const data = await api(`/api/goals/${state.currentGoal.id}/connections`, { method: 'POST', body: JSON.stringify({ sourceId: state.connectSource, targetId: id }) });
    state.connections.push(data.connection);
    renderConnections();
    toast('PATH CONNECTED');
  } catch (error) { toast(error.message); }
  cancelBoardModes();
}

async function removeConnection(id) {
  if (!state.removePathMode) return;
  try {
    await api(`/api/connections/${id}`, { method: 'DELETE' });
    state.connections = state.connections.filter(c => c.id !== id);
    renderConnections();
    toast('PATH REMOVED');
  } catch (error) { toast(error.message); }
  cancelBoardModes();
}

function openNewGoal() {
  state.goalEdit = false;
  $('#goal-dialog-title').textContent = 'NEW QUEST';
  $('#goal-title-input').value = '';
  $('#goal-description-input').value = '';
  $('#goal-category-input').value = '';
  $('#goal-icon-input').value = '◆';
  $('#delete-goal-button').classList.add('hidden');
  $('#goal-error').textContent = '';
  $('#goal-dialog').showModal();
  setTimeout(() => $('#goal-title-input').focus(), 0);
}

function openEditGoal() {
  const goal = state.currentGoal;
  state.goalEdit = true;
  $('#goal-dialog-title').textContent = 'EDIT QUEST';
  $('#goal-title-input').value = goal.title;
  $('#goal-description-input').value = goal.description;
  $('#goal-category-input').value = goal.category;
  $('#goal-icon-input').value = goal.icon;
  $('#delete-goal-button').classList.remove('hidden');
  $('#goal-error').textContent = '';
  $('#goal-dialog').showModal();
}

function openNewMilestone() {
  state.milestoneEditId = null;
  $('#milestone-dialog-title').textContent = 'NEW MILESTONE';
  $('#milestone-title-input').value = '';
  $('#milestone-description-input').value = '';
  $('#milestone-notes-input').value = '';
  $('#milestone-complete-row').classList.add('hidden');
  $('#delete-milestone-button').classList.add('hidden');
  $('#milestone-error').textContent = '';
  $('#milestone-dialog').showModal();
  setTimeout(() => $('#milestone-title-input').focus(), 0);
}

function openMilestone(id) {
  const milestone = state.milestones.find(m => m.id === id);
  state.milestoneEditId = id;
  $('#milestone-dialog-title').textContent = 'EDIT MILESTONE';
  $('#milestone-title-input').value = milestone.title;
  $('#milestone-description-input').value = milestone.description;
  $('#milestone-notes-input').value = milestone.notes;
  $('#milestone-complete-input').checked = milestone.completed;
  $('#milestone-complete-row').classList.remove('hidden');
  $('#delete-milestone-button').classList.remove('hidden');
  $('#milestone-error').textContent = '';
  $('#milestone-dialog').showModal();
}

function askConfirmation(title, copy, actionLabel = 'CONFIRM') {
  $('#confirm-title').textContent = title;
  $('#confirm-copy').textContent = copy;
  $('#confirm-action').textContent = actionLabel;
  const dialog = $('#confirm-dialog');
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}

async function refreshCurrentGoal() {
  const data = await api(`/api/goals/${state.currentGoal.id}`);
  state.currentGoal = data.goal; state.milestones = data.milestones; state.connections = data.connections;
  renderRoadmap();
}

$$('[data-auth-mode]').forEach(tab => tab.addEventListener('click', () => {
  $$('[data-auth-mode]').forEach(other => { other.classList.toggle('active', other === tab); other.setAttribute('aria-selected', other === tab); });
  const register = tab.dataset.authMode === 'register';
  $('#auth-submit').textContent = register ? 'CREATE QUEST LOG' : 'ENTER QUEST LOG';
  $('#auth-password').autocomplete = register ? 'new-password' : 'current-password';
  $('#auth-error').textContent = '';
}));

$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const mode = $('[data-auth-mode].active').dataset.authMode;
  const button = $('#auth-submit'); button.disabled = true; button.textContent = mode === 'register' ? 'CREATING...' : 'CHECKING...';
  try {
    const data = await api(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify({ username: $('#auth-username').value, password: $('#auth-password').value }) });
    $('#auth-form').reset();
    await enterApp(data.user);
  } catch (error) { $('#auth-error').textContent = error.message; }
  finally { button.disabled = false; button.textContent = mode === 'register' ? 'CREATE QUEST LOG' : 'ENTER QUEST LOG'; }
});

$('#logout-button').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); showAuth(); });
$$('[data-nav="home"]').forEach(button => button.addEventListener('click', async () => { await loadGoals(); showHome(); }));
$('#new-goal-button').addEventListener('click', openNewGoal);
$$('.quest-tab').forEach(tab => tab.addEventListener('click', () => {
  state.filter = tab.dataset.status;
  $$('.quest-tab').forEach(t => t.classList.toggle('active', t === tab));
  renderGoals();
}));

$('#goal-form').addEventListener('submit', async event => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const payload = { title: $('#goal-title-input').value, description: $('#goal-description-input').value, category: $('#goal-category-input').value, icon: $('#goal-icon-input').value };
  try {
    if (state.goalEdit) {
      const data = await api(`/api/goals/${state.currentGoal.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      state.currentGoal = { ...state.currentGoal, ...data.goal };
      $('#goal-dialog').close(); renderRoadmap(); toast('QUEST RECORD UPDATED');
    } else {
      const data = await api('/api/goals', { method: 'POST', body: JSON.stringify(payload) });
      $('#goal-dialog').close(); await openGoal(data.goal.id); toast('NEW QUEST RECORDED');
    }
  } catch (error) { $('#goal-error').textContent = error.message; }
});

$('#edit-goal-button').addEventListener('click', openEditGoal);
$('#add-milestone-button').addEventListener('click', openNewMilestone);
$('#connect-button').addEventListener('click', toggleConnectMode);
$('#remove-path-button').addEventListener('click', toggleRemovePathMode);

$('#delete-goal-button').addEventListener('click', async () => {
  const goal = state.currentGoal;
  $('#goal-dialog').close();
  if (!await askConfirmation('DELETE QUEST?', `Permanently remove “${goal.title}”, its milestones, notes, and paths?`, 'DELETE')) return;
  try {
    await api(`/api/goals/${goal.id}`, { method: 'DELETE' });
    await loadGoals(); showHome(); toast('QUEST RECORD REMOVED');
  } catch (error) { toast(error.message); }
});

$('#milestone-form').addEventListener('submit', async event => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const payload = { title: $('#milestone-title-input').value, description: $('#milestone-description-input').value, notes: $('#milestone-notes-input').value };
  try {
    if (state.milestoneEditId) {
      payload.completed = $('#milestone-complete-input').checked;
      await api(`/api/milestones/${state.milestoneEditId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      const board = $('#roadmap-board');
      payload.x = Math.min(1120, board.scrollLeft + board.clientWidth / 2 - 84);
      payload.y = Math.min(760, board.scrollTop + board.clientHeight / 2 - 31);
      await api(`/api/goals/${state.currentGoal.id}/milestones`, { method: 'POST', body: JSON.stringify(payload) });
    }
    $('#milestone-dialog').close(); await refreshCurrentGoal(); toast(state.milestoneEditId ? 'MILESTONE UPDATED' : 'WAYPOINT ADDED');
  } catch (error) { $('#milestone-error').textContent = error.message; }
});

$('#delete-milestone-button').addEventListener('click', async () => {
  const milestone = state.milestones.find(m => m.id === state.milestoneEditId);
  $('#milestone-dialog').close();
  if (!await askConfirmation('DELETE MILESTONE?', `Remove “${milestone.title}” and every path connected to it?`, 'DELETE')) return;
  try { await api(`/api/milestones/${milestone.id}`, { method: 'DELETE' }); await refreshCurrentGoal(); toast('MILESTONE REMOVED'); }
  catch (error) { toast(error.message); }
});

$('#complete-goal-button').addEventListener('click', async () => {
  const complete = state.currentGoal.status !== 'COMPLETED';
  if (!complete && !await askConfirmation('REOPEN QUEST?', 'Move this quest back into your active log?', 'REOPEN')) return;
  if (complete && !await askConfirmation('COMPLETE QUEST?', 'This is your call. The roadmap will be preserved in the archive.', 'COMPLETE')) return;
  try {
    await api(`/api/goals/${state.currentGoal.id}`, { method: 'PATCH', body: JSON.stringify({ status: complete ? 'COMPLETED' : 'ACTIVE' }) });
    await refreshCurrentGoal();
    if (complete) {
      $('#completion-icon').textContent = state.currentGoal.icon;
      $('#completion-title').textContent = state.currentGoal.title;
      $('#completion-stats').textContent = `${state.milestones.filter(m => m.completed).length} OF ${state.milestones.length} MILESTONES COMPLETE`;
      $('#complete-dialog').showModal();
    } else toast('QUEST RETURNED TO ACTIVE LOG');
  } catch (error) { toast(error.message); }
});

$('#archive-button').addEventListener('click', async () => {
  $('#complete-dialog').close();
  state.filter = 'COMPLETED';
  $$('.quest-tab').forEach(t => t.classList.toggle('active', t.dataset.status === 'COMPLETED'));
  await loadGoals(); showHome();
});

document.addEventListener('keydown', event => { if (event.key === 'Escape' && (state.connectMode || state.removePathMode)) cancelBoardModes(); });

(async function boot() {
  try { const data = await api('/api/auth/me'); await enterApp(data.user); }
  catch { showAuth(); }
})();

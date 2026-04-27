const filters = [
  { id: 'decision', label: 'Needs decision' },
  { id: 'all', label: 'All' },
  { id: 'unprocessed', label: 'Unprocessed' },
  { id: 'queued', label: 'Queued' },
  { id: 'transcribed', label: 'Transcribed' },
  { id: 'needs_review', label: 'Needs review' },
  { id: 'integrated', label: 'Integrated' },
  { id: 'failed', label: 'Failed' },
  { id: 'skipped', label: 'Skipped' },
];

const decisionStates = new Set(['unprocessed', 'transcribed', 'needs_review', 'failed']);

let state = {
  queue: [],
  jobs: [],
  actions: [],
  warnings: [],
  claudeAvailable: false,
  ytDlpAvailable: false,
  activeFilter: 'decision',
  currentId: '',
  selectedAction: 'integrate-source',
};

let renderedVideoId = null;

const els = {
  topStatus: document.querySelector('.top-status span:last-child'),
  queueList: document.getElementById('queueList'),
  queueCount: document.getElementById('queueCount'),
  filterRow: document.getElementById('filterRow'),
  videoFrame: document.getElementById('videoFrame'),
  currentTitle: document.getElementById('currentTitle'),
  currentUrl: document.getElementById('currentUrl'),
  watchStatePill: document.getElementById('watchStatePill'),
  processingStatePill: document.getElementById('processingStatePill'),
  watchNotes: document.getElementById('watchNotes'),
  processingCount: document.getElementById('processingCount'),
  processingSummary: document.getElementById('processingSummary'),
  processingHistory: document.getElementById('processingHistory'),
  skillOptions: document.getElementById('skillOptions'),
  extraPrompt: document.getElementById('extraPrompt'),
  promptPreview: document.getElementById('promptPreview'),
  jobList: document.getElementById('jobList'),
  jobCount: document.getElementById('jobCount'),
  videoUrl: document.getElementById('videoUrl'),
  mockPlaylist: document.getElementById('mockPlaylist'),
  runSkill: document.getElementById('runSkill'),
  removeItem: document.getElementById('removeItem'),
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body;
}

function currentItem() {
  return state.queue.find((item) => item.id === state.currentId) || state.queue[0] || null;
}

function selectedAction() {
  return state.actions.find((action) => action.id === state.selectedAction) || state.actions[0] || null;
}

function matchesFilter(item, filterId) {
  if (filterId === 'all') return true;
  if (filterId === 'decision') return decisionStates.has(item.processingState);
  if (filterId === 'skipped') return item.watchState === 'skipped';
  return item.processingState === filterId;
}

function filteredQueue() {
  return state.queue.filter((item) => matchesFilter(item, state.activeFilter));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function pillClassForProcessing(value) {
  if (value === 'integrated' || value === 'transcribed') return 'green';
  if (value === 'queued' || value === 'transcribing' || value === 'running_skill') return 'amber';
  if (value === 'needs_review') return 'violet';
  if (value === 'failed') return 'red';
  return '';
}

function formatState(value) {
  return String(value || '').replaceAll('_', ' ');
}

function renderFilters() {
  els.filterRow.innerHTML = filters.map((filter) => {
    const count = state.queue.filter((item) => matchesFilter(item, filter.id)).length;
    const active = filter.id === state.activeFilter ? ' active' : '';
    return `<button class="filter-chip${active}" data-filter="${filter.id}">${escapeHtml(filter.label)} <span>${count}</span></button>`;
  }).join('');
  document.querySelectorAll('.filter-chip').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeFilter = button.dataset.filter;
      const visible = filteredQueue();
      if (visible.length && !visible.some((item) => item.id === state.currentId)) {
        state.currentId = visible[0].id;
      }
      render();
    });
  });
}

function renderQueue() {
  const visible = filteredQueue();
  els.queueCount.textContent = `${visible.length}/${state.queue.length} shown`;
  els.queueList.innerHTML = visible.map((item) => {
    const active = item.id === state.currentId ? ' active' : '';
    const thumb = item.thumbnail || (item.videoId ? `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg` : '');
    return `
      <button class="queue-item${active}" data-id="${item.id}">
        <span class="thumb">${thumb ? `<img src="${escapeHtml(thumb)}" alt="">` : '<i data-lucide="video"></i>'}</span>
        <span class="item-text">
          <span class="item-title">${escapeHtml(item.title)}</span>
          <span class="item-meta">
            <span>${escapeHtml(item.source || 'Manual')}</span>
            <span class="pill blue">${escapeHtml(item.watchState)}</span>
            <span class="pill ${pillClassForProcessing(item.processingState)}">${escapeHtml(formatState(item.processingState))}</span>
          </span>
        </span>
      </button>`;
  }).join('') || `
    <div class="empty">
      <div class="empty-inner"><i data-lucide="filter"></i><div>No videos match this filter.</div></div>
    </div>`;
  document.querySelectorAll('.queue-item').forEach((button) => {
    button.addEventListener('click', () => {
      state.currentId = button.dataset.id;
      render();
    });
  });
}

function renderCurrent() {
  const item = currentItem();
  if (!item) {
    els.currentTitle.textContent = 'Add a video to begin';
    els.currentUrl.textContent = '';
    els.watchNotes.value = '';
    if (renderedVideoId !== null) {
      renderedVideoId = null;
      els.videoFrame.innerHTML = '<div class="empty"><div class="empty-inner"><i data-lucide="video"></i><div>No playable YouTube video selected.</div></div></div>';
    }
    return;
  }
  els.currentTitle.textContent = item.title;
  els.currentUrl.textContent = item.canonicalUrl || item.inputUrl || '';
  els.watchStatePill.textContent = `watch: ${item.watchState}`;
  els.processingStatePill.textContent = `processing: ${formatState(item.processingState)}`;
  els.processingStatePill.className = `pill ${pillClassForProcessing(item.processingState)}`;
  if (document.activeElement !== els.watchNotes) {
    els.watchNotes.value = item.notes || '';
  }
  if (item.videoId && renderedVideoId !== item.videoId) {
    renderedVideoId = item.videoId;
    els.videoFrame.innerHTML = `<iframe src="https://www.youtube.com/embed/${escapeHtml(item.videoId)}" title="${escapeHtml(item.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`;
  } else if (!item.videoId && renderedVideoId !== null) {
    renderedVideoId = null;
    els.videoFrame.innerHTML = '<div class="empty"><div class="empty-inner"><i data-lucide="video"></i><div>No playable YouTube video selected.</div></div></div>';
  }
  renderProcessing(item);
}

function renderProcessing(item) {
  const history = item.history || [];
  els.processingCount.textContent = `${history.length} ${history.length === 1 ? 'run' : 'runs'}`;
  const artifacts = (item.artifacts || []).length;
  els.processingSummary.innerHTML = `
    <div>Watch state: <strong>${escapeHtml(item.watchState)}</strong></div>
    <div>Processing state: <strong>${escapeHtml(formatState(item.processingState))}</strong></div>
    <div>Review outcome: <strong>${escapeHtml(item.reviewOutcome || 'not set')}</strong></div>
    <div>Artifacts: <strong>${artifacts}</strong></div>`;
  els.processingHistory.innerHTML = history.map((entry) => `
    <div class="timeline-item">
      <div class="timeline-time">${escapeHtml(new Date(entry.time).toLocaleString())}</div>
      <div class="timeline-body">
        <div class="timeline-title">${escapeHtml(entry.title)}</div>
        <div class="timeline-detail">${escapeHtml(entry.detail || '')}</div>
      </div>
    </div>`).join('') || `
    <div class="timeline-item">
      <div class="timeline-time">Now</div>
      <div class="timeline-body">
        <div class="timeline-title">No processing yet</div>
        <div class="timeline-detail">Choose a skill action when this video is worth transcribing, scanning, or integrating.</div>
      </div>
    </div>`;
}

function renderActions() {
  els.skillOptions.innerHTML = state.actions.map((action) => `
    <label class="skill-option">
      <input type="radio" name="skill" value="${escapeHtml(action.id)}" ${action.id === state.selectedAction ? 'checked' : ''} ${action.available ? '' : 'disabled'}>
      <span>
        <span class="skill-name">${escapeHtml(action.label)}${action.available ? '' : ' unavailable'}</span>
        <span class="skill-desc">${escapeHtml(action.description || '')}</span>
        <span class="skill-desc">cwd: ${escapeHtml(action.cwd || '')} · source: ${escapeHtml(action.source || '')}</span>
      </span>
    </label>`).join('');
  document.querySelectorAll('input[name="skill"]').forEach((input) => {
    input.addEventListener('change', () => {
      state.selectedAction = input.value;
      renderPreview();
    });
  });
}

function buildInvocation() {
  const item = currentItem();
  const action = selectedAction();
  if (!item || !action) return 'No video or action selected.';
  const videoUrl = item.canonicalUrl || item.inputUrl;
  const base = action.template.replaceAll('{{videoUrl}}', videoUrl);
  return [
    `cwd: ${action.cwd}`,
    '',
    "claude -p <<'PROMPT'",
    base,
    '',
    'Video context:',
    `- title: ${item.title}`,
    `- url: ${videoUrl}`,
    `- videoId: ${item.videoId || ''}`,
    `- channel: ${item.channel || ''}`,
    `- watchState: ${item.watchState}`,
    `- processingState: ${item.processingState}`,
    item.notes ? `- watchNotes: ${item.notes}` : '- watchNotes: none yet',
    '',
    'Extra user direction:',
    els.extraPrompt.value.trim() || 'none',
    'PROMPT',
  ].join('\n');
}

function renderPreview() {
  els.promptPreview.textContent = buildInvocation();
}

function renderJobs() {
  els.jobCount.textContent = `${state.jobs.length} ${state.jobs.length === 1 ? 'job' : 'jobs'}`;
  const waitingOrder = [...state.jobs].reverse().filter((job) => job.status === 'waiting' || job.status === 'queued');
  els.jobList.innerHTML = state.jobs.map((job) => `
    <div class="job">
      <div class="job-top">
        <div class="job-title">${escapeHtml(job.actionLabel || job.actionId)}${job.status === 'waiting' || job.status === 'queued' ? ` · #${waitingOrder.findIndex((entry) => entry.id === job.id) + 1} waiting` : ''}</div>
        <span class="pill ${job.status === 'failed' ? 'red' : job.status === 'succeeded' ? 'green' : 'amber'}">${escapeHtml(job.status)}</span>
      </div>
      <div class="log">${escapeHtml((job.stdout || job.stderr || job.error || 'No output yet.').slice(-1200))}</div>
    </div>`).join('');
}

function renderStatus() {
  const warnings = state.warnings.length ? ` · ${state.warnings.length} warning${state.warnings.length === 1 ? '' : 's'}` : '';
  els.topStatus.textContent = `Claude ${state.claudeAvailable ? 'available' : 'missing'} · yt-dlp ${state.ytDlpAvailable ? 'available' : 'missing'}${warnings}`;
  els.runSkill.disabled = !state.claudeAvailable || !currentItem();
  els.removeItem.disabled = !currentItem();
}

function render() {
  renderStatus();
  renderFilters();
  renderQueue();
  renderCurrent();
  renderActions();
  renderPreview();
  renderJobs();
  if (window.lucide) lucide.createIcons();
}

async function refresh() {
  const [health, queue] = await Promise.all([api('/api/health'), api('/api/queue')]);
  state = {
    ...state,
    ...health,
    queue: queue.queue,
    jobs: queue.jobs,
  };
  if (!state.currentId || !state.queue.some((item) => item.id === state.currentId)) {
    state.currentId = state.queue.find((item) => decisionStates.has(item.processingState))?.id || state.queue[0]?.id || '';
  }
  if (!state.actions.some((action) => action.id === state.selectedAction)) {
    state.selectedAction = state.actions[0]?.id || '';
  }
  render();
}

async function addVideo() {
  const url = els.videoUrl.value.trim();
  if (!url) return;
  const result = await api('/api/queue/video', {
    method: 'POST',
    body: JSON.stringify({ url, source: 'Manual' }),
  });
  state.currentId = result.item.id;
  els.videoUrl.value = '';
  await refresh();
}

async function importPlaylist() {
  const url = els.videoUrl.value.trim();
  if (!url) {
    alert('Paste a public YouTube playlist URL first.');
    return;
  }
  els.mockPlaylist.disabled = true;
  try {
    const result = await api('/api/queue/playlist', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    state.currentId = result.added[0]?.id || state.currentId;
    await refresh();
    alert(`Imported ${result.added.length}; skipped ${result.skipped.length} duplicates.`);
  } finally {
    els.mockPlaylist.disabled = false;
  }
}

async function patchCurrent(patch) {
  const item = currentItem();
  if (!item) return;
  await api(`/api/queue/${item.id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  await refresh();
}

async function removeCurrent() {
  const item = currentItem();
  if (!item) return;
  const confirmed = window.confirm(`Remove "${item.title}" from the queue?\n\nRun logs are preserved, but this queue item will be removed.`);
  if (!confirmed) return;
  await api(`/api/queue/${item.id}`, { method: 'DELETE' });
  const visible = filteredQueue().filter((entry) => entry.id !== item.id);
  state.currentId = visible[0]?.id || state.queue.find((entry) => entry.id !== item.id)?.id || '';
  await refresh();
}

async function runSkill() {
  const item = currentItem();
  const action = selectedAction();
  if (!item || !action) return;
  await api('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      itemId: item.id,
      actionId: action.id,
      extraPrompt: els.extraPrompt.value.trim(),
    }),
  });
  await refresh();
}

document.getElementById('addVideo').addEventListener('click', () => addVideo().catch((err) => alert(err.message)));
els.videoUrl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addVideo().catch((err) => alert(err.message));
});
els.mockPlaylist.addEventListener('click', () => importPlaylist().catch((err) => alert(err.message)));
document.getElementById('markWatched').addEventListener('click', () => patchCurrent({ watchState: 'watched' }));
document.getElementById('skipItem').addEventListener('click', () => patchCurrent({ watchState: 'skipped' }));
els.removeItem.addEventListener('click', () => removeCurrent().catch((err) => alert(err.message)));
els.watchNotes.addEventListener('input', () => {
  const item = currentItem();
  if (item) item.notes = els.watchNotes.value;
  renderPreview();
});
els.watchNotes.addEventListener('blur', () => patchCurrent({ notes: els.watchNotes.value }));
els.extraPrompt.addEventListener('input', renderPreview);
els.runSkill.addEventListener('click', () => runSkill().catch((err) => alert(err.message)));
document.getElementById('copyPreview').addEventListener('click', () => navigator.clipboard?.writeText(buildInvocation()));

await refresh();
setInterval(refresh, 2500);

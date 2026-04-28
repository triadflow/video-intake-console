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
  labels: [],
  jobs: [],
  playlists: [],
  removedVideos: [],
  actions: [],
  warnings: [],
  claudeAvailable: false,
  ytDlpAvailable: false,
  activeFilter: 'decision',
  activeLabelId: '',
  currentId: '',
  selectedAction: 'transcribe',
};

let notesSaveTimer = null;
let notesSaveInFlight = Promise.resolve();
let timestampSaveTimer = null;
let timestampSaveInFlight = Promise.resolve();

const els = {
  topStatus: document.querySelector('.top-status span:last-child'),
  queueList: document.getElementById('queueList'),
  playlistList: document.getElementById('playlistList'),
  queueCount: document.getElementById('queueCount'),
  filterRow: document.getElementById('filterRow'),
  videoFrame: document.getElementById('videoFrame'),
  currentTitle: document.getElementById('currentTitle'),
  currentUrl: document.getElementById('currentUrl'),
  watchStatePill: document.getElementById('watchStatePill'),
  processingStatePill: document.getElementById('processingStatePill'),
  resumeStatePill: document.getElementById('resumeStatePill'),
  labelCount: document.getElementById('labelCount'),
  labelList: document.getElementById('labelList'),
  labelName: document.getElementById('labelName'),
  labelColor: document.getElementById('labelColor'),
  addLabel: document.getElementById('addLabel'),
  videoDescription: document.getElementById('videoDescription'),
  timestampText: document.getElementById('timestampText'),
  timestampFocus: document.getElementById('timestampFocus'),
  timestampCount: document.getElementById('timestampCount'),
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

const playbackSaveMs = 5000;
const nearEndSeconds = 10;
const nearEndRatio = 0.95;

let youtubeApiReady = false;
let youtubeApiLoading = false;
let youtubePlayer = null;
let renderedVideoKey = '';
let playbackTimer = null;
let playbackSaveInFlight = Promise.resolve();
const descriptionFetches = new Map();

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

function matchesLabelFilter(item) {
  return !state.activeLabelId || (item.labelIds || []).includes(state.activeLabelId);
}

function filteredQueue() {
  return state.queue.filter((item) => matchesFilter(item, state.activeFilter) && matchesLabelFilter(item));
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

function formatTimestamp(value) {
  return value ? new Date(value).toISOString() : '';
}

function safeLabelColor(color) {
  const value = String(color || '').trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : '#66717f';
}

function labelPillStyle(label) {
  const color = safeLabelColor(label.color);
  return `style="color:${color};border-color:${color}66;background:${color}14"`;
}

function labelDotStyle(label) {
  return `style="background:${safeLabelColor(label.color)}"`;
}

function labelById(labelId) {
  return state.labels.find((label) => label.id === labelId) || null;
}

function labelsForItem(item) {
  return (item?.labelIds || []).map(labelById).filter(Boolean);
}

function labelsText(item) {
  const labels = labelsForItem(item).map((label) => label.name);
  return labels.length ? labels.join(', ') : 'none';
}

function renderLabelPills(item, { max = 3 } = {}) {
  const labels = labelsForItem(item);
  if (!labels.length) return '';
  const shown = labels.slice(0, max).map((label) => (
    `<span class="label-pill" ${labelPillStyle(label)}>${escapeHtml(label.name)}</span>`
  ));
  if (labels.length > max) shown.push(`<span class="pill">+${labels.length - max}</span>`);
  return shown.join('');
}

function playbackKey(item) {
  if (!item) return '';
  if (item.videoId) return `youtube:${item.videoId}`;
  return item.canonicalUrl || item.inputUrl || item.id || '';
}

function shouldRestartFromBeginning(seconds, duration) {
  if (!duration || duration < 1) return false;
  return duration - seconds <= nearEndSeconds || seconds / duration >= nearEndRatio;
}

function playbackPosition(item) {
  return item?.playbackPosition || null;
}

function resumeSecondsFor(item) {
  const position = playbackPosition(item);
  if (!position || position.completed) return 0;
  const seconds = Number(position.seconds) || 0;
  const duration = Number(position.duration || item.duration) || 0;
  if (shouldRestartFromBeginning(seconds, duration)) return 0;
  return Math.max(0, Math.floor(seconds));
}

function playbackPayload(item, seconds, duration, completed = false) {
  const safeDuration = Number.isFinite(duration) && duration > 0
    ? duration
    : Number(item?.duration || item?.playbackPosition?.duration) || 0;
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const isComplete = completed || shouldRestartFromBeginning(safeSeconds, safeDuration);
  return {
    seconds: isComplete ? 0 : Math.floor(safeSeconds),
    duration: safeDuration ? Math.floor(safeDuration) : 0,
    completed: isComplete,
    updatedAt: new Date().toISOString(),
  };
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function parseTimestampValue(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const hms = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (hms && (hms[1] || hms[2] || hms[3])) {
    return (Number(hms[1] || 0) * 3600) + (Number(hms[2] || 0) * 60) + Number(hms[3] || 0);
  }
  if (/^\d{1,2}(?::\d{2}){1,2}$/.test(raw)) {
    const parts = raw.split(':').map(Number);
    if (parts.length === 2) return (parts[0] * 60) + parts[1];
    return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  }
  return null;
}

function normalizeTimestampRanges(ranges) {
  return (Array.isArray(ranges) ? ranges : [])
    .map((range) => ({
      id: range.id || `ts-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      startSeconds: Number(range.startSeconds),
      endSeconds: range.endSeconds === null || range.endSeconds === undefined || range.endSeconds === '' ? null : Number(range.endSeconds),
      label: String(range.label || '').trim(),
      source: String(range.source || 'manual').trim() || 'manual',
    }))
    .filter((range) => Number.isFinite(range.startSeconds) && range.startSeconds >= 0)
    .filter((range) => range.endSeconds === null || (Number.isFinite(range.endSeconds) && range.endSeconds >= range.startSeconds))
    .slice(0, 80);
}

function timestampRangesToText(ranges) {
  return normalizeTimestampRanges(ranges).map((range) => {
    const time = range.endSeconds === null
      ? formatDuration(range.startSeconds)
      : `${formatDuration(range.startSeconds)}-${formatDuration(range.endSeconds)}`;
    return `${time}${range.label ? ` - ${range.label}` : ''}`;
  }).join('\n');
}

function parseTimestampText(value) {
  const ranges = [];
  for (const line of String(value || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d{1,2}(?::\d{2}){1,2}|\d+h\d*m?\d*s?|\d+m\d*s?|\d+s?|\d+)(?:\s*[-–—]\s*(\d{1,2}(?::\d{2}){1,2}|\d+h\d*m?\d*s?|\d+m\d*s?|\d+s?|\d+))?(?:\s*[-–—:|]\s*(.*))?$/i);
    if (!match) continue;
    const start = parseTimestampValue(match[1]);
    const end = match[2] ? parseTimestampValue(match[2]) : null;
    if (start === null) continue;
    ranges.push({
      startSeconds: start,
      endSeconds: end !== null && end > start ? end : null,
      label: String(match[3] || '').trim(),
      source: 'manual',
    });
  }
  return normalizeTimestampRanges(ranges);
}

function timestampSummary(item) {
  const count = normalizeTimestampRanges(item?.timestampRanges).length;
  return `${count} ${count === 1 ? 'range' : 'ranges'}`;
}

function playbackLabel(item) {
  const position = playbackPosition(item);
  if (!position) return 'resume: start';
  if (position.completed) return 'resume: watched';
  const seconds = resumeSecondsFor(item);
  return seconds > 0 ? `resume: ${formatDuration(seconds)}` : 'resume: start';
}

function queueSourceLabel(item) {
  const channel = String(item?.channel || '').trim();
  const source = String(item?.source || 'Manual').trim();
  if (channel && source && !source.includes(channel)) return `${channel} · ${source}`;
  return channel || source || 'Manual';
}

function shouldFetchDescription(item) {
  if (!item?.id || !item.videoId) return false;
  if (String(item.description || '').trim()) return false;
  if (descriptionFetches.has(item.id)) return false;
  return true;
}

function renderDescription(item, status = '') {
  const description = String(item?.description || '').trim();
  if (description) {
    els.videoDescription.textContent = description;
    els.videoDescription.className = 'description-text';
    return;
  }
  els.videoDescription.textContent = status || 'No description saved.';
  els.videoDescription.className = 'description-text empty-copy';
}

function renderLabels(item) {
  const assigned = new Set(item?.labelIds || []);
  els.labelCount.textContent = `${state.labels.length} ${state.labels.length === 1 ? 'label' : 'labels'}`;
  if (!item) {
    els.labelList.innerHTML = '<div class="empty-copy">Select a video to apply labels.</div>';
    return;
  }
  els.labelList.innerHTML = state.labels.map((label) => `
    <div class="label-row" data-label-id="${escapeHtml(label.id)}">
      <input class="label-apply" type="checkbox" aria-label="Apply ${escapeHtml(label.name)}" ${assigned.has(label.id) ? 'checked' : ''}>
      <input class="label-color-input" type="color" value="${escapeHtml(safeLabelColor(label.color))}" aria-label="Label color">
      <input class="label-name-input" type="text" value="${escapeHtml(label.name)}" aria-label="Label name">
      <button class="icon-btn label-save" type="button" title="Save label" aria-label="Save label">
        <i data-lucide="save"></i>
      </button>
      <button class="icon-btn label-delete" type="button" title="Delete label" aria-label="Delete label">
        <i data-lucide="trash-2"></i>
      </button>
    </div>
  `).join('') || '<div class="empty-copy">Create a label to start.</div>';
  document.querySelectorAll('.label-apply').forEach((input) => {
    input.addEventListener('change', () => {
      const row = input.closest('.label-row');
      setCurrentLabel(row.dataset.labelId, input.checked).catch((err) => alert(err.message));
    });
  });
  document.querySelectorAll('.label-save').forEach((button) => {
    button.addEventListener('click', () => {
      const row = button.closest('.label-row');
      const name = row.querySelector('.label-name-input').value;
      const color = row.querySelector('.label-color-input').value;
      updateLabel(row.dataset.labelId, { name, color }).catch((err) => alert(err.message));
    });
  });
  document.querySelectorAll('.label-delete').forEach((button) => {
    button.addEventListener('click', () => {
      const row = button.closest('.label-row');
      deleteLabel(row.dataset.labelId).catch((err) => alert(err.message));
    });
  });
}

function relatedJobs(itemId) {
  return state.jobs.filter((job) => job.itemId === itemId);
}

function buildQueueItemContext(item) {
  const jobs = relatedJobs(item.id);
  const artifacts = item.artifacts || [];
  const recentHistory = (item.history || []).slice(0, 5);
  const lines = [
    'Video context:',
    `- title: ${item.title || ''}`,
    `- url: ${item.canonicalUrl || item.inputUrl || ''}`,
    `- videoId: ${item.videoId || ''}`,
    `- channel: ${item.channel || ''}`,
    `- source: ${item.source || ''}`,
    item.playlistId ? `- playlistId: ${item.playlistId}` : '',
    item.description ? `- description: ${item.description}` : '- description: none saved',
    `- watchState: ${item.watchState || ''}`,
    `- processingState: ${item.processingState || ''}`,
    `- reviewOutcome: ${item.reviewOutcome || ''}`,
    `- labels: ${labelsText(item)}`,
    `- playbackPosition: ${playbackLabel(item).replace('resume: ', '')}`,
    `- timestampFocus: ${item.timestampFocus ? 'yes' : 'no'}`,
    item.notes ? `- watchNotes: ${item.notes}` : '- watchNotes: none yet',
    `- queueItemId: ${item.id}`,
    `- createdAt: ${formatTimestamp(item.createdAt)}`,
    `- updatedAt: ${formatTimestamp(item.updatedAt)}`,
    '',
    'Recent jobs:',
    ...(jobs.length ? jobs.slice(0, 5).map((job) => {
      const bits = [
        `- ${job.actionLabel || job.actionId}: ${job.status}`,
        `jobId=${job.id}`,
        job.startedAt ? `started=${formatTimestamp(job.startedAt)}` : '',
        job.finishedAt ? `finished=${formatTimestamp(job.finishedAt)}` : '',
        job.durationMs ? `durationMs=${job.durationMs}` : '',
        job.error ? `error=${job.error}` : '',
        job.claudeSession?.logPath ? `claudeSession=${job.claudeSession.logPath}` : '',
      ].filter(Boolean);
      return bits.join(' | ');
    }) : ['- none']),
    '',
    'Artifacts:',
    ...(artifacts.length ? artifacts.slice(0, 5).map((artifact) => {
      const pathValue = artifact.stdoutPath || artifact.path || artifact.url || artifact.summary || artifact.id;
      return `- ${artifact.type || 'artifact'}: ${pathValue || ''}`;
    }) : ['- none']),
    '',
    'Recent history:',
    ...(recentHistory.length ? recentHistory.map((entry) => `- ${formatTimestamp(entry.time)} ${entry.title || ''}: ${entry.status || ''}${entry.detail ? ` - ${entry.detail}` : ''}`) : ['- none']),
    '',
    'Timestamp context:',
    ...(normalizeTimestampRanges(item.timestampRanges).length ? timestampRangesToText(item.timestampRanges).split('\n').map((line) => `- ${line}`) : ['- none']),
  ];
  return lines.filter((line) => line !== '').join('\n');
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function renderFilters() {
  const baseFilters = filters.map((filter) => {
    const count = state.queue.filter((item) => matchesFilter(item, filter.id) && matchesLabelFilter(item)).length;
    const active = filter.id === state.activeFilter ? ' active' : '';
    return `<button class="filter-chip${active}" data-filter="${filter.id}">${escapeHtml(filter.label)} <span>${count}</span></button>`;
  }).join('');
  const labelFilters = state.labels.map((label) => {
    const count = state.queue.filter((item) => matchesFilter(item, state.activeFilter) && (item.labelIds || []).includes(label.id)).length;
    const active = label.id === state.activeLabelId ? ' active' : '';
    return `<button class="filter-chip label-filter${active}" data-label-filter="${escapeHtml(label.id)}">
      <span class="label-dot" ${labelDotStyle(label)}></span>${escapeHtml(label.name)} <span>${count}</span>
    </button>`;
  }).join('');
  els.filterRow.innerHTML = `${baseFilters}${labelFilters}`;
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      saveCurrentPlaybackPosition();
      state.activeFilter = button.dataset.filter;
      const visible = filteredQueue();
      if (visible.length && !visible.some((item) => item.id === state.currentId)) {
        state.currentId = visible[0].id;
      }
      render();
    });
  });
  document.querySelectorAll('[data-label-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      saveCurrentPlaybackPosition();
      state.activeLabelId = state.activeLabelId === button.dataset.labelFilter ? '' : button.dataset.labelFilter;
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
    const durationBadge = item.duration ? `<span class="duration-badge">${escapeHtml(formatDuration(item.duration))}</span>` : '';
    const sourceLabel = queueSourceLabel(item);
    const resume = resumeSecondsFor(item);
    const resumePill = item.playbackPosition
      ? `<span class="pill">${resume > 0 ? `resume ${formatDuration(resume)}` : (item.playbackPosition.completed ? 'resume watched' : 'resume start')}</span>`
      : '';
    return `
      <div class="queue-card${active}">
        <button class="queue-item" data-id="${item.id}" type="button">
          <span class="thumb-wrap">
            <span class="thumb">${thumb ? `<img src="${escapeHtml(thumb)}" alt="">` : '<i class="thumb-fallback" data-lucide="video"></i>'}</span>
            ${durationBadge}
          </span>
          <span class="item-text">
            <span class="item-kicker">${escapeHtml(sourceLabel)}</span>
            <span class="item-title">${escapeHtml(item.title)}</span>
            <span class="item-meta">
              <span class="pill blue">${escapeHtml(item.watchState)}</span>
              <span class="pill ${pillClassForProcessing(item.processingState)}">${escapeHtml(formatState(item.processingState))}</span>
              ${resumePill}
              ${renderLabelPills(item)}
            </span>
          </span>
        </button>
        <button class="icon-btn queue-copy" data-id="${item.id}" type="button" title="Copy video context" aria-label="Copy video context">
          <i data-lucide="copy"></i>
        </button>
      </div>`;
  }).join('') || `
    <div class="empty">
      <div class="empty-inner"><i data-lucide="filter"></i><div>No videos match this filter.</div></div>
    </div>`;
  document.querySelectorAll('.queue-item').forEach((button) => {
    button.addEventListener('click', () => {
      saveCurrentPlaybackPosition();
      state.currentId = button.dataset.id;
      render();
    });
  });
  document.querySelectorAll('.queue-copy').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = state.queue.find((entry) => entry.id === button.dataset.id);
      if (!item) return;
      await copyText(buildQueueItemContext(item));
    });
  });
}

function renderPlaylists() {
  els.playlistList.innerHTML = state.playlists.map((playlist) => {
    const stats = playlist.lastStats || {};
    const checked = playlist.lastCheckedAt ? new Date(playlist.lastCheckedAt).toLocaleString() : 'never';
    return `
      <div class="playlist-item">
        <div class="playlist-top">
          <div>
            <div class="playlist-title">${escapeHtml(playlist.title || playlist.playlistId)}</div>
            <div class="item-meta">Last checked: ${escapeHtml(checked)}</div>
          </div>
          <button class="icon-btn playlist-refresh" title="Refresh playlist" aria-label="Refresh playlist" data-playlist-id="${escapeHtml(playlist.id)}">
            <i data-lucide="refresh-cw"></i>
          </button>
        </div>
        <div class="item-meta">
          <span class="pill green">${Number(stats.added || 0)} new</span>
          <span class="pill">${Number(stats.alreadyQueued || 0)} queued</span>
          <span class="pill amber">${Number(stats.dismissed || 0)} removed</span>
          ${playlist.status === 'failed' ? `<span class="pill red">failed</span>` : ''}
        </div>
      </div>`;
  }).join('');
  document.querySelectorAll('.playlist-refresh').forEach((button) => {
    button.addEventListener('click', () => refreshPlaylist(button.dataset.playlistId).catch((err) => alert(err.message)));
  });
}

function renderCurrent() {
  const item = currentItem();
  if (!item) {
    els.currentTitle.textContent = 'Add a video to begin';
    els.currentUrl.textContent = '';
    els.watchNotes.value = '';
    els.timestampText.value = '';
    els.timestampFocus.checked = false;
    els.timestampCount.textContent = '0 ranges';
    renderLabels(null);
    renderDescription(null);
    destroyYouTubePlayer();
    renderedVideoKey = '';
    els.videoFrame.innerHTML = '<div class="empty"><div class="empty-inner"><i data-lucide="video"></i><div>No playable YouTube video selected.</div></div></div>';
    return;
  }
  els.currentTitle.textContent = item.title;
  els.currentUrl.textContent = item.canonicalUrl || item.inputUrl || '';
  els.watchStatePill.textContent = `watch: ${item.watchState}`;
  els.processingStatePill.textContent = `processing: ${formatState(item.processingState)}`;
  els.processingStatePill.className = `pill ${pillClassForProcessing(item.processingState)}`;
  els.resumeStatePill.textContent = playbackLabel(item);
  renderLabels(item);
  renderDescription(item, shouldFetchDescription(item) ? 'Fetching description...' : '');
  if (document.activeElement !== els.timestampText) {
    els.timestampText.value = timestampRangesToText(item.timestampRanges);
  }
  els.timestampFocus.checked = Boolean(item.timestampFocus);
  els.timestampCount.textContent = timestampSummary(item);
  if (document.activeElement !== els.watchNotes) {
    els.watchNotes.value = item.notes || '';
  }
  if (item.videoId) {
    renderYouTubePlayer(item);
  } else if (!item.videoId && renderedVideoKey) {
    destroyYouTubePlayer();
    renderedVideoKey = '';
    els.videoFrame.innerHTML = '<div class="empty"><div class="empty-inner"><i data-lucide="video"></i><div>No playable YouTube video selected.</div></div></div>';
  }
  renderProcessing(item);
  ensureDescription(item);
}

function ensureDescription(item) {
  if (!shouldFetchDescription(item)) return;
  const request = api(`/api/queue/${item.id}/metadata`, { method: 'POST' })
    .then((result) => {
      const index = state.queue.findIndex((entry) => entry.id === item.id);
      if (index >= 0) state.queue[index] = result.item;
      if (state.currentId === item.id) {
        renderDescription(result.item);
        if (document.activeElement !== els.timestampText) {
          els.timestampText.value = timestampRangesToText(result.item.timestampRanges);
        }
        els.timestampCount.textContent = timestampSummary(result.item);
        renderPreview();
      }
    })
    .catch((err) => {
      console.error('[metadata] description fetch failed', err);
      if (state.currentId === item.id) renderDescription(item, 'No description saved.');
    });
  descriptionFetches.set(item.id, request);
}

function loadYouTubeApi() {
  if (youtubeApiReady || youtubeApiLoading) return;
  youtubeApiLoading = true;
  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(script);
}

window.onYouTubeIframeAPIReady = () => {
  youtubeApiReady = true;
  youtubeApiLoading = false;
  const item = currentItem();
  if (item?.videoId) renderYouTubePlayer(item, true);
};

function renderYouTubePlayer(item, force = false) {
  const key = playbackKey(item);
  if (!force && youtubePlayer && renderedVideoKey === key) return;
  destroyYouTubePlayer();
  renderedVideoKey = key;
  els.videoFrame.innerHTML = '<div id="youtubePlayerHost" style="width:100%;height:100%;"></div>';
  if (!youtubeApiReady || !window.YT?.Player) {
    loadYouTubeApi();
    return;
  }
  const start = resumeSecondsFor(item);
  youtubePlayer = new YT.Player('youtubePlayerHost', {
    videoId: item.videoId,
    playerVars: {
      playsinline: 1,
      rel: 0,
      start,
    },
    events: {
      onReady: (event) => {
        if (start > 0) event.target.seekTo(start, true);
      },
      onStateChange: handlePlayerStateChange,
    },
  });
}

function destroyYouTubePlayer() {
  stopPlaybackTimer();
  saveCurrentPlaybackPosition();
  if (!youtubePlayer) return;
  try {
    youtubePlayer.destroy();
  } catch {
    // Ignore teardown failures from partially initialized embeds.
  }
  youtubePlayer = null;
}

function handlePlayerStateChange(event) {
  const item = currentItem();
  if (!item) return;
  if (event.data === YT.PlayerState.PLAYING) {
    if (item.watchState === 'new') {
      item.watchState = 'watching';
      patchCurrent({ watchState: 'watching' }).catch((err) => console.error('[playback] watch-state save failed', err));
    }
    startPlaybackTimer();
    renderQueue();
    renderPreview();
    if (window.lucide) lucide.createIcons();
  }
  if (event.data === YT.PlayerState.PAUSED) {
    saveCurrentPlaybackPosition();
    stopPlaybackTimer();
    renderPlaybackState();
  }
  if (event.data === YT.PlayerState.ENDED) {
    item.watchState = 'watched';
    savePlaybackPosition(item, playbackPayload(item, 0, safePlayerDuration(), true));
    stopPlaybackTimer();
    patchCurrent({ watchState: 'watched', playbackPosition: item.playbackPosition }).catch((err) => console.error('[playback] completion save failed', err));
    render();
  }
}

function startPlaybackTimer() {
  if (playbackTimer) return;
  playbackTimer = window.setInterval(() => {
    saveCurrentPlaybackPosition();
    renderPlaybackState();
  }, playbackSaveMs);
}

function stopPlaybackTimer() {
  if (!playbackTimer) return;
  window.clearInterval(playbackTimer);
  playbackTimer = null;
}

function safePlayerDuration() {
  try {
    return youtubePlayer?.getDuration() || 0;
  } catch {
    return 0;
  }
}

function savePlaybackPosition(item, position) {
  if (!item || !position) return Promise.resolve();
  item.playbackPosition = position;
  playbackSaveInFlight = playbackSaveInFlight
    .catch(() => {})
    .then(() => api(`/api/queue/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ playbackPosition: position }),
    }).catch((err) => {
      console.error('[playback] save failed', err);
    }));
  return playbackSaveInFlight;
}

function saveCurrentPlaybackPosition() {
  const item = currentItem();
  if (!item || !youtubePlayer || playbackKey(item) !== renderedVideoKey) return Promise.resolve();
  if (item.watchState === 'watched' && item.playbackPosition?.completed) return Promise.resolve();
  try {
    const seconds = youtubePlayer.getCurrentTime();
    const duration = youtubePlayer.getDuration();
    if (Number.isFinite(seconds) && seconds >= 0) {
      return savePlaybackPosition(item, playbackPayload(item, seconds, duration, false));
    }
  } catch {
    // The YouTube player can throw before it has fully initialized.
  }
  return Promise.resolve();
}

function renderPlaybackState() {
  const item = currentItem();
  if (!item) return;
  els.resumeStatePill.textContent = playbackLabel(item);
  renderQueue();
  renderPreview();
  if (window.lucide) lucide.createIcons();
}

function renderProcessing(item) {
  const history = item.history || [];
  els.processingCount.textContent = `${history.length} ${history.length === 1 ? 'run' : 'runs'}`;
  const artifacts = (item.artifacts || []).length;
  els.processingSummary.innerHTML = `
    <div>Watch state: <strong>${escapeHtml(item.watchState)}</strong></div>
    <div>Processing state: <strong>${escapeHtml(formatState(item.processingState))}</strong></div>
    <div>Saved playback: <strong>${escapeHtml(playbackLabel(item).replace('resume: ', ''))}</strong></div>
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
  const shortDescriptions = {
    'integrate-source': 'Dossier/source assessment',
    transcribe: 'Transcript only',
    custom: 'Use your prompt',
  };
  els.skillOptions.innerHTML = state.actions.map((action) => `
    <label class="skill-option">
      <input type="radio" name="skill" value="${escapeHtml(action.id)}" ${action.id === state.selectedAction ? 'checked' : ''} ${action.available ? '' : 'disabled'}>
      <span>
        <span class="skill-name">${escapeHtml(action.label)}${action.available ? '' : ' unavailable'}</span>
        <span class="skill-desc">${escapeHtml(shortDescriptions[action.id] || action.description || '')}</span>
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
    item.description ? `- description: ${item.description}` : '- description: none saved',
    `- watchState: ${item.watchState}`,
    `- processingState: ${item.processingState}`,
    `- labels: ${labelsText(item)}`,
    `- playbackPosition: ${playbackLabel(item).replace('resume: ', '')}`,
    `- timestampFocus: ${item.timestampFocus ? 'yes' : 'no'}`,
    item.notes ? `- watchNotes: ${item.notes}` : '- watchNotes: none yet',
    '',
    'Timestamp context:',
    ...(normalizeTimestampRanges(item.timestampRanges).length ? timestampRangesToText(item.timestampRanges).split('\n').map((line) => `- ${line}`) : ['- none']),
    item.timestampFocus && normalizeTimestampRanges(item.timestampRanges).length
      ? 'Instruction: prioritize analysis around the timestamp context above before scanning the rest of the source.'
      : 'Instruction: use timestamp context when relevant; no timestamp-only focus requested.',
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
      ${renderClaudeSession(job)}
      <div class="log">${escapeHtml((job.stdout || job.stderr || job.error || 'No output yet.').slice(-1200))}</div>
    </div>`).join('');
}

function renderClaudeSession(job) {
  const session = job.claudeSession;
  if (!session) return '';
  const pathLabel = session.logPath ? session.logPath.split('/').pop() : 'locating session log';
  const tools = session.toolNames?.length ? ` · tools: ${session.toolNames.join(', ')}` : '';
  const counts = session.logPath
    ? `${session.eventCount || 0} events · ${session.toolUseCount || 0} tool calls · ${session.toolResultCount || 0} results · ${session.thinkingBlockCount || 0} thinking blocks`
    : 'waiting for Claude JSONL';
  return `
    <div class="job-meta" title="${escapeHtml(session.logPath || session.projectDir || '')}">
      Claude session: ${escapeHtml(pathLabel)} · ${escapeHtml(counts)}${escapeHtml(tools)}
    </div>`;
}

function renderStatus() {
  const warnings = state.warnings.length ? ` · ${state.warnings.length} warning${state.warnings.length === 1 ? '' : 's'}` : '';
  els.topStatus.textContent = `Claude ${state.claudeAvailable ? 'available' : 'missing'} · yt-dlp ${state.ytDlpAvailable ? 'available' : 'missing'}${warnings}`;
  els.runSkill.disabled = !state.claudeAvailable || !currentItem();
  els.removeItem.disabled = !currentItem();
}

function render() {
  renderStatus();
  renderPlaylists();
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
    labels: queue.labels || [],
    jobs: queue.jobs,
    playlists: queue.playlistSubscriptions || [],
    removedVideos: queue.removedVideos || [],
  };
  if (state.activeLabelId && !state.labels.some((label) => label.id === state.activeLabelId)) {
    state.activeLabelId = '';
  }
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
    alert(`Imported ${result.stats.added}; already queued ${result.stats.alreadyQueued}; previously removed ${result.stats.dismissed}.`);
  } finally {
    els.mockPlaylist.disabled = false;
  }
}

async function refreshPlaylist(playlistId) {
  await api(`/api/playlists/${encodeURIComponent(playlistId)}/refresh`, { method: 'POST' });
  await refresh();
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

async function createLabel() {
  const name = els.labelName.value.trim();
  if (!name) return;
  await api('/api/labels', {
    method: 'POST',
    body: JSON.stringify({ name, color: els.labelColor.value }),
  });
  els.labelName.value = '';
  await refresh();
}

async function updateLabel(labelId, patch) {
  await api(`/api/labels/${encodeURIComponent(labelId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  await refresh();
}

async function deleteLabel(labelId) {
  const label = labelById(labelId);
  if (!label) return;
  const confirmed = window.confirm(`Delete label "${label.name}"?\n\nIt will be removed from every video.`);
  if (!confirmed) return;
  await api(`/api/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
  if (state.activeLabelId === labelId) state.activeLabelId = '';
  await refresh();
}

async function setCurrentLabel(labelId, enabled) {
  const item = currentItem();
  if (!item) return;
  const next = new Set(item.labelIds || []);
  if (enabled) next.add(labelId);
  else next.delete(labelId);
  item.labelIds = [...next];
  await patchCurrent({ labelIds: item.labelIds });
}

function saveWatchNotes(itemId, notes) {
  notesSaveInFlight = notesSaveInFlight
    .catch(() => {})
    .then(() => api(`/api/queue/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes }),
    }).catch((err) => {
      console.error('[notes] autosave failed', err);
    }));
  return notesSaveInFlight;
}

function scheduleWatchNotesSave() {
  const item = currentItem();
  if (!item) return;
  window.clearTimeout(notesSaveTimer);
  notesSaveTimer = window.setTimeout(() => {
    saveWatchNotes(item.id, els.watchNotes.value);
  }, 700);
}

async function flushWatchNotes() {
  const item = currentItem();
  window.clearTimeout(notesSaveTimer);
  notesSaveTimer = null;
  if (!item) return notesSaveInFlight;
  await notesSaveInFlight;
  return saveWatchNotes(item.id, els.watchNotes.value);
}

function saveTimestamps(itemId, timestampRanges, timestampFocus) {
  timestampSaveInFlight = timestampSaveInFlight
    .catch(() => {})
    .then(() => api(`/api/queue/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ timestampRanges, timestampFocus }),
    }).catch((err) => {
      console.error('[timestamps] autosave failed', err);
    }));
  return timestampSaveInFlight;
}

function scheduleTimestampSave() {
  const item = currentItem();
  if (!item) return;
  window.clearTimeout(timestampSaveTimer);
  timestampSaveTimer = window.setTimeout(() => {
    saveTimestamps(item.id, normalizeTimestampRanges(item.timestampRanges), Boolean(item.timestampFocus));
  }, 700);
}

async function flushTimestamps() {
  const item = currentItem();
  window.clearTimeout(timestampSaveTimer);
  timestampSaveTimer = null;
  if (!item) return timestampSaveInFlight;
  await timestampSaveInFlight;
  return saveTimestamps(item.id, normalizeTimestampRanges(item.timestampRanges), Boolean(item.timestampFocus));
}

async function removeCurrent() {
  const item = currentItem();
  if (!item) return;
  await saveCurrentPlaybackPosition();
  await flushTimestamps();
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
  await saveCurrentPlaybackPosition();
  await flushWatchNotes();
  await flushTimestamps();
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
els.addLabel.addEventListener('click', () => createLabel().catch((err) => alert(err.message)));
els.labelName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') createLabel().catch((err) => alert(err.message));
});
document.getElementById('markWatched').addEventListener('click', () => {
  const item = currentItem();
  if (!item) return;
  stopPlaybackTimer();
  const playbackPosition = playbackPayload(item, 0, safePlayerDuration(), true);
  item.watchState = 'watched';
  item.playbackPosition = playbackPosition;
  patchCurrent({ watchState: 'watched', playbackPosition });
});
document.getElementById('skipItem').addEventListener('click', () => {
  saveCurrentPlaybackPosition();
  patchCurrent({ watchState: 'skipped' });
});
els.removeItem.addEventListener('click', () => removeCurrent().catch((err) => alert(err.message)));
els.watchNotes.addEventListener('input', () => {
  const item = currentItem();
  if (item) item.notes = els.watchNotes.value;
  renderPreview();
  scheduleWatchNotesSave();
});
els.watchNotes.addEventListener('blur', () => flushWatchNotes());
els.timestampText.addEventListener('input', () => {
  const item = currentItem();
  if (!item) return;
  item.timestampRanges = parseTimestampText(els.timestampText.value);
  els.timestampCount.textContent = timestampSummary(item);
  renderPreview();
  scheduleTimestampSave();
});
els.timestampText.addEventListener('blur', () => flushTimestamps());
els.timestampFocus.addEventListener('change', () => {
  const item = currentItem();
  if (!item) return;
  item.timestampFocus = els.timestampFocus.checked;
  renderPreview();
  scheduleTimestampSave();
});
els.extraPrompt.addEventListener('input', renderPreview);
els.runSkill.addEventListener('click', () => runSkill().catch((err) => alert(err.message)));
document.getElementById('copyPreview').addEventListener('click', () => navigator.clipboard?.writeText(buildInvocation()));
window.addEventListener('beforeunload', () => {
  saveCurrentPlaybackPosition();
  flushTimestamps();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    saveCurrentPlaybackPosition();
    flushTimestamps();
  }
});

await refresh();
setInterval(refresh, 2500);

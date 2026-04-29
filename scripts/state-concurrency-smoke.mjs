#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'video-intake-state-'));
const dataDir = path.join(tempRoot, 'data');
const statePath = path.join(dataDir, 'state.json');
const port = 45000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const itemId = 'video_concurrency_smoke';

async function request(route, options = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${route} failed: ${res.status} ${body.error || ''}`);
  return body;
}

async function waitForServer(child) {
  const deadline = Date.now() + 7000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      await request('/api/health');
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error('server did not start');
}

await mkdir(dataDir, { recursive: true });
await writeFile(statePath, `${JSON.stringify({
  queue: [{
    id: itemId,
    canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    inputUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    videoId: 'dQw4w9WgXcQ',
    title: 'Concurrency smoke video',
    channel: 'Smoke',
    thumbnail: '',
    duration: 213,
    description: '',
    source: 'Smoke',
    playlistId: '',
    watchState: 'new',
    processingState: 'unprocessed',
    reviewOutcome: '',
    notes: '',
    labelIds: [],
    timestampRanges: [],
    timestampFocus: false,
    playbackPosition: { seconds: 0, duration: 213, completed: false, updatedAt: null },
    artifacts: [],
    history: [],
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }],
  labels: [],
  filterViews: [],
  jobs: [],
  removedVideos: [],
  playlistSubscriptions: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}, null, 2)}\n`);

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(port),
    VIDEO_INTAKE_DATA_DIR: dataDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  await waitForServer(child);
  const createdLabel = await request('/api/labels', {
    method: 'POST',
    body: JSON.stringify({ name: 'Research', color: '#1d6fd8' }),
  });
  const labelId = createdLabel.label.id;
  await Promise.all([
    request(`/api/queue/${itemId}`, { method: 'PATCH', body: JSON.stringify({ notes: 'concurrent notes' }) }),
    request(`/api/queue/${itemId}`, { method: 'PATCH', body: JSON.stringify({ reviewOutcome: 'keep' }) }),
    request(`/api/queue/${itemId}`, { method: 'PATCH', body: JSON.stringify({ watchState: 'watching' }) }),
    request(`/api/queue/${itemId}`, { method: 'PATCH', body: JSON.stringify({ description: 'description survived overlap' }) }),
    request(`/api/queue/${itemId}`, { method: 'PATCH', body: JSON.stringify({ labelIds: [labelId] }) }),
    request(`/api/queue/${itemId}`, { method: 'PATCH', body: JSON.stringify({ playbackPosition: { seconds: 42, duration: 213, completed: false, updatedAt: new Date().toISOString() } }) }),
    request(`/api/queue/${itemId}`, { method: 'PATCH', body: JSON.stringify({ timestampFocus: true, timestampRanges: [{ startSeconds: 30, endSeconds: 60, label: 'overlap range', source: 'manual' }] }) }),
  ]);
  await request(`/api/labels/${labelId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Research review', color: '#178558' }),
  });
  const createdView = await request('/api/filter-views', {
    method: 'POST',
    body: JSON.stringify({ name: 'Smoke view', query: 'created:today label:Research' }),
  });
  const viewId = createdView.view.id;
  await request(`/api/filter-views/${viewId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Smoke review', query: 'status:decision OR label:Research' }),
  });

  const finalState = JSON.parse(await readFile(statePath, 'utf8'));
  const item = finalState.queue.find((entry) => entry.id === itemId);
  const label = finalState.labels.find((entry) => entry.id === labelId);
  const view = finalState.filterViews.find((entry) => entry.id === viewId);
  const failures = [];
  if (!item) failures.push('queue item missing');
  if (!label) failures.push('label missing');
  if (label?.name !== 'Research review') failures.push('label update lost');
  if (label?.color !== '#178558') failures.push('label color update lost');
  if (!view) failures.push('filter view missing');
  if (view?.name !== 'Smoke review') failures.push('filter view update lost');
  if (view?.query !== 'status:decision OR label:Research') failures.push('filter view query update lost');
  if (item?.notes !== 'concurrent notes') failures.push('notes patch lost');
  if (item?.reviewOutcome !== 'keep') failures.push('review outcome patch lost');
  if (item?.watchState !== 'watching') failures.push('watch state patch lost');
  if (item?.description !== 'description survived overlap') failures.push('description patch lost');
  if (!item?.labelIds?.includes(labelId)) failures.push('label assignment patch lost');
  if (item?.playbackPosition?.seconds !== 42) failures.push('playback patch lost');
  if (item?.timestampFocus !== true) failures.push('timestamp focus patch lost');
  if (item?.timestampRanges?.[0]?.startSeconds !== 30) failures.push('timestamp range patch lost');
  if (failures.length) throw new Error(failures.join('; '));
  await request(`/api/labels/${labelId}`, { method: 'DELETE' });
  await request(`/api/filter-views/${viewId}`, { method: 'DELETE' });
  const deletedState = JSON.parse(await readFile(statePath, 'utf8'));
  const deletedItem = deletedState.queue.find((entry) => entry.id === itemId);
  if (deletedState.labels.some((entry) => entry.id === labelId)) throw new Error('label delete lost');
  if (deletedState.filterViews.some((entry) => entry.id === viewId)) throw new Error('filter view delete lost');
  if (deletedItem?.labelIds?.includes(labelId)) throw new Error('deleted label still assigned to queue item');
  console.log('state concurrency smoke passed');
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) {
    await new Promise((resolve) => child.once('close', resolve));
  }
  await rm(tempRoot, { recursive: true, force: true });
}

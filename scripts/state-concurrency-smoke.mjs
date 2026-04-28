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
    playbackPosition: { seconds: 0, duration: 213, completed: false, updatedAt: null },
    artifacts: [],
    history: [],
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }],
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
  await Promise.all([
    request(`/api/queue/${itemId}`, { method: 'PATCH', body: JSON.stringify({ notes: 'concurrent notes' }) }),
    request(`/api/queue/${itemId}`, { method: 'PATCH', body: JSON.stringify({ reviewOutcome: 'keep' }) }),
    request(`/api/queue/${itemId}`, { method: 'PATCH', body: JSON.stringify({ watchState: 'watching' }) }),
    request(`/api/queue/${itemId}`, { method: 'PATCH', body: JSON.stringify({ description: 'description survived overlap' }) }),
    request(`/api/queue/${itemId}`, { method: 'PATCH', body: JSON.stringify({ playbackPosition: { seconds: 42, duration: 213, completed: false, updatedAt: new Date().toISOString() } }) }),
  ]);

  const finalState = JSON.parse(await readFile(statePath, 'utf8'));
  const item = finalState.queue.find((entry) => entry.id === itemId);
  const failures = [];
  if (!item) failures.push('queue item missing');
  if (item?.notes !== 'concurrent notes') failures.push('notes patch lost');
  if (item?.reviewOutcome !== 'keep') failures.push('review outcome patch lost');
  if (item?.watchState !== 'watching') failures.push('watch state patch lost');
  if (item?.description !== 'description survived overlap') failures.push('description patch lost');
  if (item?.playbackPosition?.seconds !== 42) failures.push('playback patch lost');
  if (failures.length) throw new Error(failures.join('; '));
  console.log('state concurrency smoke passed');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('close', resolve));
  await rm(tempRoot, { recursive: true, force: true });
}

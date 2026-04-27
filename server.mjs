#!/usr/bin/env node
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4177);
const DATA_DIR = process.env.VIDEO_INTAKE_DATA_DIR || path.join(__dirname, '.video-intake-data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const MAX_BODY = 2_000_000;
const RUN_TIMEOUT_MS = Number(process.env.VIDEO_INTAKE_RUN_TIMEOUT_MS || 10 * 60 * 1000);

const LIVING_DOC_CWD = '/Users/rene/projects/living-doc-compositor';

const CONFIG = {
  skillRoots: [
    path.join(LIVING_DOC_CWD, '.claude/skills'),
  ],
  actions: [
    {
      id: 'integrate-source',
      skillName: 'integrate-source',
      label: '/integrate-source',
      description: 'Transcribe if needed, score relevance across monitoring docs, update living docs and dossier pieces when warranted.',
      cwd: LIVING_DOC_CWD,
      template: '/integrate-source {{videoUrl}}',
      successProcessingState: 'needs_review',
    },
    {
      id: 'dossier-scan',
      skillName: 'integrate-source',
      label: '/dossier scan',
      description: 'Assess whether the current published dossier corpus should be refreshed from this source.',
      cwd: LIVING_DOC_CWD,
      template: '/integrate-source {{videoUrl}}\n\nAfter source assessment, report whether the current published dossier corpus should be refreshed. Do not commit or push downstream changes.',
      successProcessingState: 'needs_review',
    },
    {
      id: 'transcribe',
      skillName: 'transcribe',
      label: '/transcribe',
      description: 'Create a local transcript and attach it to the queue item for later decisions.',
      cwd: LIVING_DOC_CWD,
      template: '/transcribe {{videoUrl}}',
      successProcessingState: 'transcribed',
      allowWithoutSkill: true,
    },
    {
      id: 'custom',
      skillName: null,
      label: 'Custom prompt',
      description: 'Send video context, notes, and your freeform instruction to Claude Code without a preset skill.',
      cwd: __dirname,
      template: 'Use this YouTube source as context: {{videoUrl}}',
      successProcessingState: 'needs_review',
      manual: true,
    },
  ],
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

let state = null;
const activeJobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function commandAvailable(command) {
  return spawnSync('which', [command], { stdio: 'ignore' }).status === 0;
}

async function loadState() {
  if (state) return state;
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  try {
    state = JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch {
    state = { queue: [], jobs: [], createdAt: nowIso(), updatedAt: nowIso() };
    await saveState();
  }
  state.queue ||= [];
  state.jobs ||= [];
  return state;
}

async function saveState() {
  state.updatedAt = nowIso();
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, details = undefined) {
  sendJson(res, status, { error: message, details });
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function parseYoutube(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Invalid URL');
  }

  const host = url.hostname.replace(/^www\./, '');
  let videoId = '';
  if (host === 'youtu.be') videoId = url.pathname.split('/').filter(Boolean)[0] || '';
  if (host.endsWith('youtube.com')) {
    if (url.searchParams.get('v')) videoId = url.searchParams.get('v') || '';
    const embed = url.pathname.match(/\/embed\/([^/?]+)/);
    if (embed) videoId = embed[1];
    const shorts = url.pathname.match(/\/shorts\/([^/?]+)/);
    if (shorts) videoId = shorts[1];
  }

  const playlistId = url.searchParams.get('list') || '';
  const isPlaylist = Boolean(playlistId) && !videoId;
  const canonicalUrl = videoId
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    : input;

  return { input, canonicalUrl, videoId, playlistId, isPlaylist };
}

function runJsonCommand(command, args, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || stdout || `${command} exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`Could not parse ${command} JSON output: ${err.message}`));
      }
    });
  });
}

async function resolveVideoMetadata(url, parsed) {
  if (!commandAvailable('yt-dlp')) {
    return {
      title: parsed.videoId ? `YouTube video ${parsed.videoId}` : 'Unresolved YouTube source',
      channel: '',
      thumbnail: parsed.videoId ? `https://i.ytimg.com/vi/${parsed.videoId}/mqdefault.jpg` : '',
      duration: null,
      metadataSource: 'fallback',
    };
  }
  try {
    const info = await runJsonCommand('yt-dlp', ['--dump-single-json', '--no-playlist', url], 45_000);
    const id = info.id || parsed.videoId;
    return {
      title: info.title || (id ? `YouTube video ${id}` : 'Unresolved YouTube source'),
      channel: info.channel || info.uploader || '',
      thumbnail: info.thumbnail || (id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : ''),
      duration: info.duration || null,
      metadataSource: 'yt-dlp',
      videoId: id,
    };
  } catch (err) {
    return {
      title: parsed.videoId ? `YouTube video ${parsed.videoId}` : 'Unresolved YouTube source',
      channel: '',
      thumbnail: parsed.videoId ? `https://i.ytimg.com/vi/${parsed.videoId}/mqdefault.jpg` : '',
      duration: null,
      metadataSource: 'fallback',
      metadataError: err.message,
    };
  }
}

function findQueueItemByVideoId(videoId) {
  return state.queue.find((item) => item.videoId && item.videoId === videoId);
}

function itemFromVideo({ parsed, metadata, source }) {
  const videoId = metadata.videoId || parsed.videoId;
  return {
    id: makeId('video'),
    canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    inputUrl: parsed.input,
    videoId,
    title: metadata.title || `YouTube video ${videoId}`,
    channel: metadata.channel || '',
    thumbnail: metadata.thumbnail || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    duration: metadata.duration ?? null,
    source: source || 'Manual',
    playlistId: parsed.playlistId || '',
    watchState: 'new',
    processingState: 'unprocessed',
    reviewOutcome: '',
    notes: '',
    artifacts: [],
    history: [],
    metadata,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function buildPrompt(action, item, extraPrompt) {
  const videoUrl = item.canonicalUrl || item.inputUrl;
  const base = action.template.replaceAll('{{videoUrl}}', videoUrl);
  const artifacts = (item.artifacts || []).map((artifact) => `- ${artifact.type}: ${artifact.path || artifact.url || artifact.summary || artifact.id}`).join('\n') || '- none';
  return [
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
    'Prior artifacts:',
    artifacts,
    '',
    'Extra user direction:',
    extraPrompt || 'none',
  ].join('\n');
}

async function discoverActions() {
  const warnings = [];
  const discovered = new Map();
  for (const root of CONFIG.skillRoots) {
    if (!existsSync(root)) {
      warnings.push(`Skill root not found: ${root}`);
      continue;
    }
    const names = await import('node:fs/promises').then((fs) => fs.readdir(root, { withFileTypes: true }));
    for (const dirent of names) {
      if (!dirent.isDirectory()) continue;
      const skillPath = path.join(root, dirent.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      try {
        const raw = await readFile(skillPath, 'utf8');
        const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
        const meta = { name: dirent.name, description: '' };
        if (frontmatter) {
          for (const line of frontmatter[1].split('\n')) {
            const match = line.match(/^([A-Za-z0-9_-]+):\s*"?(.+?)"?$/);
            if (match) meta[match[1]] = match[2].replace(/^"|"$/g, '');
          }
        }
        discovered.set(meta.name || dirent.name, { ...meta, root, skillPath });
      } catch (err) {
        warnings.push(`Could not read ${skillPath}: ${err.message}`);
      }
    }
  }

  const actions = CONFIG.actions.map((action) => {
    const skill = action.skillName ? discovered.get(action.skillName) : null;
    return {
      ...action,
      description: action.description || skill?.description || '',
      source: skill ? 'discovered+config' : (action.manual ? 'manual' : 'config'),
      skillPath: skill?.skillPath || '',
      available: action.manual || action.allowWithoutSkill || !action.skillName || Boolean(skill),
    };
  });
  return { actions, warnings };
}

async function changedFiles(cwd) {
  const r = spawnSync('git', ['status', '--short'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, files: [], error: r.stderr || r.stdout };
  const files = r.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return { ok: true, files };
}

async function appendLog(job, stream, text) {
  const field = stream === 'stderr' ? 'stderr' : 'stdout';
  job[field] += text;
  await writeFile(path.join(LOG_DIR, `${job.id}.${field}.log`), job[field]);
}

async function startJob({ itemId, actionId, extraPrompt }) {
  const item = state.queue.find((entry) => entry.id === itemId);
  if (!item) throw new Error('Queue item not found');
  const { actions } = await discoverActions();
  const action = actions.find((entry) => entry.id === actionId);
  if (!action) throw new Error('Action not found');
  if (!action.available) throw new Error(`Action is unavailable: ${action.label}`);
  if (!commandAvailable('claude')) throw new Error('claude CLI is not available on PATH');

  const duplicate = state.jobs.find((job) => job.itemId === itemId && job.actionId === actionId && ['queued', 'running'].includes(job.status));
  if (duplicate) throw new Error(`A ${action.label} job is already active for this video`);

  const prompt = buildPrompt(action, item, extraPrompt || '');
  const job = {
    id: makeId('job'),
    itemId,
    actionId,
    actionLabel: action.label,
    cwd: action.cwd,
    prompt,
    status: 'queued',
    stdout: '',
    stderr: '',
    exitCode: null,
    error: '',
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    downstreamStatus: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.jobs.unshift(job);
  item.processingState = actionId === 'transcribe' ? 'queued' : 'queued';
  item.history ||= [];
  item.history.unshift({
    id: makeId('hist'),
    time: nowIso(),
    title: `${action.label} queued`,
    status: 'queued',
    detail: 'Job persisted before spawning local Claude Code.',
    jobId: job.id,
  });
  item.updatedAt = nowIso();
  await saveState();

  runJob(job.id).catch((err) => {
    console.error('[job] unhandled failure', err);
  });
  return job;
}

async function runJob(jobId) {
  await loadState();
  const job = state.jobs.find((entry) => entry.id === jobId);
  if (!job) return;
  const item = state.queue.find((entry) => entry.id === job.itemId);
  const action = CONFIG.actions.find((entry) => entry.id === job.actionId);
  job.status = 'running';
  job.startedAt = nowIso();
  job.updatedAt = nowIso();
  if (item) {
    item.processingState = job.actionId === 'transcribe' ? 'transcribing' : 'running_skill';
    item.updatedAt = nowIso();
  }
  await saveState();

  const start = Date.now();
  const child = spawn('claude', ['-p', '-'], {
    cwd: job.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  activeJobs.set(job.id, child);
  child.stdin.write(job.prompt);
  child.stdin.end();

  const timer = setTimeout(() => {
    job.error = `Timed out after ${RUN_TIMEOUT_MS}ms`;
    child.kill('SIGTERM');
  }, RUN_TIMEOUT_MS);

  child.stdout.on('data', (chunk) => {
    appendLog(job, 'stdout', chunk.toString()).catch(console.error);
  });
  child.stderr.on('data', (chunk) => {
    appendLog(job, 'stderr', chunk.toString()).catch(console.error);
  });
  child.on('error', async (err) => {
    clearTimeout(timer);
    activeJobs.delete(job.id);
    await finishJob(job, item, action, null, err.message, Date.now() - start);
  });
  child.on('close', async (code) => {
    clearTimeout(timer);
    activeJobs.delete(job.id);
    await finishJob(job, item, action, code, job.error, Date.now() - start);
  });
}

async function finishJob(job, item, action, code, error, durationMs) {
  job.exitCode = code;
  job.durationMs = durationMs;
  job.finishedAt = nowIso();
  job.error = error || '';
  job.status = code === 0 && !error ? 'succeeded' : 'failed';
  job.updatedAt = nowIso();
  if (action?.cwd && existsSync(path.join(action.cwd, '.git'))) {
    job.downstreamStatus = await changedFiles(action.cwd);
  }

  if (item) {
    const changed = job.downstreamStatus?.files?.length > 0;
    if (job.status === 'failed') item.processingState = 'failed';
    else if (action?.successProcessingState === 'transcribed') item.processingState = 'transcribed';
    else item.processingState = changed ? 'needs_review' : action?.successProcessingState || 'needs_review';
    item.history ||= [];
    item.history.unshift({
      id: makeId('hist'),
      time: nowIso(),
      title: `${job.actionLabel} ${job.status}`,
      status: job.status,
      detail: job.status === 'failed'
        ? (job.error || `Process exited ${code}`)
        : (changed ? 'Run completed and downstream files need review.' : 'Run completed without detected downstream file changes.'),
      jobId: job.id,
      durationMs,
      changedFiles: job.downstreamStatus?.files || [],
    });
    if (job.status === 'succeeded') {
      item.artifacts ||= [];
      item.artifacts.unshift({
        id: makeId('artifact'),
        type: 'run-log',
        summary: `${job.actionLabel} ${job.status}`,
        stdoutPath: path.join(LOG_DIR, `${job.id}.stdout.log`),
        stderrPath: path.join(LOG_DIR, `${job.id}.stderr.log`),
        createdAt: nowIso(),
      });
    }
    item.updatedAt = nowIso();
  }
  await saveState();
}

async function handleApi(req, res, pathname) {
  await loadState();
  if (req.method === 'GET' && pathname === '/api/health') {
    const discovered = await discoverActions();
    sendJson(res, 200, {
      ok: true,
      claudeAvailable: commandAvailable('claude'),
      ytDlpAvailable: commandAvailable('yt-dlp'),
      dataDir: DATA_DIR,
      ...discovered,
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/queue') {
    sendJson(res, 200, { queue: state.queue, jobs: state.jobs });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/queue/video') {
    const body = await readJson(req);
    const parsed = parseYoutube(body.url || '');
    if (!parsed.videoId) throw new Error('No YouTube video id found');
    const existing = findQueueItemByVideoId(parsed.videoId);
    if (existing) {
      sendJson(res, 200, { item: existing, duplicate: true, message: 'Video already exists in queue' });
      return;
    }
    const metadata = await resolveVideoMetadata(body.url, parsed);
    const item = itemFromVideo({ parsed, metadata, source: body.source || 'Manual' });
    state.queue.unshift(item);
    await saveState();
    sendJson(res, 201, { item, duplicate: false });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/queue/playlist') {
    const body = await readJson(req);
    const parsed = parseYoutube(body.url || '');
    if (!parsed.playlistId) throw new Error('No YouTube playlist id found');
    if (!commandAvailable('yt-dlp')) throw new Error('yt-dlp is required for playlist import and is not available on PATH');
    const info = await runJsonCommand('yt-dlp', ['--flat-playlist', '--dump-single-json', body.url], 90_000);
    const entries = Array.isArray(info.entries) ? info.entries : [];
    const added = [];
    const skipped = [];
    for (const entry of entries) {
      const videoId = entry.id || '';
      if (!videoId) continue;
      const itemParsed = {
        input: `https://www.youtube.com/watch?v=${videoId}`,
        canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
        videoId,
        playlistId: parsed.playlistId,
      };
      if (findQueueItemByVideoId(videoId)) {
        skipped.push(videoId);
        continue;
      }
      const metadata = {
        title: entry.title || `YouTube video ${videoId}`,
        channel: entry.channel || entry.uploader || '',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        duration: entry.duration || null,
        metadataSource: 'yt-dlp-flat-playlist',
      };
      added.push(itemFromVideo({
        parsed: itemParsed,
        metadata,
        source: info.title ? `Playlist: ${info.title}` : `Playlist: ${parsed.playlistId}`,
      }));
    }
    state.queue.unshift(...added);
    await saveState();
    sendJson(res, 201, { added, skipped, playlist: { id: parsed.playlistId, title: info.title || '' } });
    return;
  }
  const queuePatch = pathname.match(/^\/api\/queue\/([^/]+)$/);
  if (req.method === 'DELETE' && queuePatch) {
    const itemId = queuePatch[1];
    const itemIndex = state.queue.findIndex((entry) => entry.id === itemId);
    if (itemIndex < 0) throw new Error('Queue item not found');
    const activeJob = state.jobs.find((job) => job.itemId === itemId && ['queued', 'running'].includes(job.status));
    if (activeJob) {
      sendError(res, 409, 'Cannot remove a video while a job is active for it', { jobId: activeJob.id });
      return;
    }
    const [removed] = state.queue.splice(itemIndex, 1);
    const relatedJobs = state.jobs.filter((job) => job.itemId === itemId);
    for (const job of relatedJobs) {
      job.orphanedQueueItem = {
        id: removed.id,
        title: removed.title,
        videoId: removed.videoId,
        canonicalUrl: removed.canonicalUrl,
        removedAt: nowIso(),
      };
      job.updatedAt = nowIso();
    }
    await saveState();
    sendJson(res, 200, { removed, preservedJobs: relatedJobs.length });
    return;
  }
  if (req.method === 'PATCH' && queuePatch) {
    const body = await readJson(req);
    const item = state.queue.find((entry) => entry.id === queuePatch[1]);
    if (!item) throw new Error('Queue item not found');
    for (const key of ['watchState', 'processingState', 'notes', 'reviewOutcome']) {
      if (Object.hasOwn(body, key)) item[key] = body[key];
    }
    item.updatedAt = nowIso();
    await saveState();
    sendJson(res, 200, { item });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/jobs') {
    const body = await readJson(req);
    const job = await startJob(body);
    sendJson(res, 201, { job });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/jobs') {
    sendJson(res, 200, { jobs: state.jobs });
    return;
  }
  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && jobMatch) {
    const job = state.jobs.find((entry) => entry.id === jobMatch[1]);
    if (!job) throw new Error('Job not found');
    sendJson(res, 200, { job });
    return;
  }
  sendError(res, 404, 'API route not found');
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(__dirname, `.${requested}`);
  if (!filePath.startsWith(__dirname) || !existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

await loadState();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Video Intake Console running at http://127.0.0.1:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});

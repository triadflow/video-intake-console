#!/usr/bin/env node
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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
const DEFAULT_RUN_TIMEOUT_MS = Number(process.env.VIDEO_INTAKE_RUN_TIMEOUT_MS || 10 * 60 * 1000);

const LIVING_DOC_CWD = '/Users/rene/projects/living-doc-compositor';
const USER_CLAUDE_SKILLS = path.join(process.env.HOME || '/Users/rene', '.claude/skills');
const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME || '/Users/rene', '.claude/projects');

const CONFIG = {
  skillRoots: [
    USER_CLAUDE_SKILLS,
    path.join(LIVING_DOC_CWD, '.claude/skills'),
  ],
  actions: [
    {
      id: 'integrate-source',
      skillName: 'integrate-source',
      label: '/integrate-source',
      description: 'Assess the source against monitoring living docs and dossier relevance.',
      cwd: LIVING_DOC_CWD,
      template: '/integrate-source {{videoUrl}}',
      successProcessingState: 'needs_review',
      timeoutMs: 45 * 60 * 1000,
      permissionMode: 'acceptEdits',
    },
    {
      id: 'transcribe',
      skillName: 'transcribe',
      label: '/transcribe',
      description: 'Create a local transcript and attach it to the queue item for later decisions.',
      cwd: LIVING_DOC_CWD,
      template: '/transcribe {{videoUrl}}',
      successProcessingState: 'transcribed',
      timeoutMs: 30 * 60 * 1000,
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
let currentJobId = null;
let workerStarting = false;

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
  state.removedVideos ||= [];
  state.playlistSubscriptions ||= [];
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

function findRemovedVideoByVideoId(videoId) {
  return state.removedVideos.find((item) => item.videoId && item.videoId === videoId);
}

function forgetRemovedVideo(videoId) {
  const before = state.removedVideos.length;
  state.removedVideos = state.removedVideos.filter((item) => item.videoId !== videoId);
  return before !== state.removedVideos.length;
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

function playlistUrlFromId(playlistId) {
  return `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
}

function upsertPlaylistSubscription({ playlistId, url, title }) {
  let subscription = state.playlistSubscriptions.find((item) => item.playlistId === playlistId);
  if (!subscription) {
    subscription = {
      id: makeId('playlist'),
      playlistId,
      url: url || playlistUrlFromId(playlistId),
      title: title || `Playlist ${playlistId}`,
      createdAt: nowIso(),
      lastCheckedAt: null,
      lastStats: null,
      status: 'new',
      error: '',
    };
    state.playlistSubscriptions.unshift(subscription);
  } else {
    subscription.url = url || subscription.url || playlistUrlFromId(playlistId);
    subscription.title = title || subscription.title;
  }
  subscription.updatedAt = nowIso();
  return subscription;
}

async function refreshPlaylistSubscription(subscription, { save = true } = {}) {
  if (!commandAvailable('yt-dlp')) throw new Error('yt-dlp is required for playlist refresh and is not available on PATH');
  const info = await runJsonCommand('yt-dlp', ['--flat-playlist', '--dump-single-json', subscription.url], 90_000);
  const parsed = parseYoutube(subscription.url);
  const playlistId = parsed.playlistId || subscription.playlistId;
  subscription.playlistId = playlistId;
  subscription.title = info.title || subscription.title || `Playlist ${playlistId}`;
  subscription.url = subscription.url || playlistUrlFromId(playlistId);

  const stats = { added: 0, alreadyQueued: 0, dismissed: 0, skipped: 0, failed: 0 };
  const added = [];
  const skipped = { alreadyQueued: [], dismissed: [], failed: [] };
  const entries = Array.isArray(info.entries) ? info.entries : [];
  for (const entry of entries) {
    const videoId = entry.id || '';
    if (!videoId) {
      stats.skipped++;
      stats.failed++;
      continue;
    }
    if (findQueueItemByVideoId(videoId)) {
      stats.alreadyQueued++;
      skipped.alreadyQueued.push(videoId);
      continue;
    }
    if (findRemovedVideoByVideoId(videoId)) {
      stats.dismissed++;
      skipped.dismissed.push(videoId);
      continue;
    }
    const itemParsed = {
      input: `https://www.youtube.com/watch?v=${videoId}`,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      playlistId,
    };
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
      source: subscription.title ? `Playlist: ${subscription.title}` : `Playlist: ${playlistId}`,
    }));
    stats.added++;
  }
  if (added.length) state.queue.unshift(...added);
  subscription.lastCheckedAt = nowIso();
  subscription.lastStats = stats;
  subscription.status = 'ok';
  subscription.error = '';
  subscription.updatedAt = nowIso();
  if (save) await saveState();
  return { subscription, added, skipped, stats };
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

function claudeProjectDirForCwd(cwd) {
  return path.join(CLAUDE_PROJECTS_DIR, cwd.replaceAll('/', '-'));
}

async function listClaudeSessionFiles(cwd, startedAt, finishedAt = null) {
  const projectDir = claudeProjectDirForCwd(cwd);
  if (!existsSync(projectDir)) return { projectDir, files: [] };
  const startedMs = Date.parse(startedAt || '') || 0;
  const finishedMs = finishedAt ? Date.parse(finishedAt) + 30_000 : Date.now() + 30_000;
  const dirents = await readdir(projectDir, { withFileTypes: true });
  const files = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.jsonl')) continue;
    const logPath = path.join(projectDir, dirent.name);
    const info = await stat(logPath);
    if (info.mtimeMs < startedMs - 10_000 || info.birthtimeMs > finishedMs) continue;
    files.push({ logPath, mtimeMs: info.mtimeMs, birthtimeMs: info.birthtimeMs, size: info.size });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { projectDir, files };
}

function summarizeClaudeSessionJsonl(raw, file) {
  const summary = {
    status: 'linked',
    logPath: file.logPath,
    sessionId: '',
    modifiedAt: new Date(file.mtimeMs).toISOString(),
    size: file.size,
    eventCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    toolResultCount: 0,
    thinkingBlockCount: 0,
    toolNames: [],
    lastTimestamp: '',
  };
  const toolNames = new Set();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    summary.eventCount += 1;
    summary.sessionId ||= entry.sessionId || '';
    summary.lastTimestamp = entry.timestamp || summary.lastTimestamp;
    if (entry.type === 'user') summary.userMessageCount += 1;
    if (entry.type === 'assistant') summary.assistantMessageCount += 1;
    const content = entry.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        summary.toolUseCount += 1;
        if (block.name) toolNames.add(block.name);
      }
      if (block.type === 'tool_result') summary.toolResultCount += 1;
      if (block.type === 'thinking') summary.thinkingBlockCount += 1;
    }
  }
  summary.toolNames = [...toolNames].slice(0, 8);
  return summary;
}

async function refreshClaudeSessionForJob(job) {
  if (!job?.cwd || !job.startedAt) return false;
  const { projectDir, files } = await listClaudeSessionFiles(job.cwd, job.startedAt, job.finishedAt);
  const promptNeedle = (job.prompt || '').split('\n').find((line) => line.trim())?.trim() || '';
  for (const file of files) {
    let raw = '';
    try {
      raw = await readFile(file.logPath, 'utf8');
    } catch {
      continue;
    }
    if (promptNeedle && !raw.includes(promptNeedle)) continue;
    const nextSession = { ...summarizeClaudeSessionJsonl(raw, file), projectDir };
    const changed = JSON.stringify(job.claudeSession || {}) !== JSON.stringify(nextSession);
    job.claudeSession = nextSession;
    return changed;
  }
  const nextSession = {
    status: 'locating',
    projectDir,
    logPath: '',
    sessionId: '',
    eventCount: 0,
    toolUseCount: 0,
    toolResultCount: 0,
    thinkingBlockCount: 0,
    toolNames: [],
  };
  const changed = JSON.stringify(job.claudeSession || {}) !== JSON.stringify(nextSession);
  job.claudeSession = nextSession;
  return changed;
}

async function refreshClaudeSessionsForJobs(jobs) {
  let changed = false;
  for (const job of jobs) {
    if (!job.startedAt) continue;
    if (job.claudeSession?.status === 'linked' && job.status !== 'running') continue;
    changed = await refreshClaudeSessionForJob(job) || changed;
  }
  if (changed) await saveState();
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

  const duplicate = state.jobs.find((job) => job.itemId === itemId && job.actionId === actionId && ['queued', 'waiting', 'running'].includes(job.status));
  if (duplicate) throw new Error(`A ${action.label} job is already active for this video`);

  const prompt = buildPrompt(action, item, extraPrompt || '');
  const job = {
    id: makeId('job'),
    itemId,
    actionId,
    actionLabel: action.label,
    cwd: action.cwd,
    prompt,
    timeoutMs: action.timeoutMs || DEFAULT_RUN_TIMEOUT_MS,
    permissionMode: action.permissionMode || 'default',
    status: 'waiting',
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
    status: 'waiting',
    detail: 'Job persisted and is waiting for the serial worker.',
    jobId: job.id,
  });
  item.updatedAt = nowIso();
  await saveState();

  processNextJob().catch((err) => console.error('[job-queue] unhandled failure', err));
  return job;
}

async function processNextJob() {
  await loadState();
  if (currentJobId || workerStarting) return;
  workerStarting = true;
  try {
    const next = [...state.jobs].reverse().find((job) => job.status === 'waiting' || job.status === 'queued');
    if (!next) return;
    currentJobId = next.id;
    await runJob(next.id);
  } finally {
    workerStarting = false;
  }
}

async function runJob(jobId) {
  await loadState();
  const job = state.jobs.find((entry) => entry.id === jobId);
  if (!job) return;
  if (!['waiting', 'queued'].includes(job.status)) return;
  const item = state.queue.find((entry) => entry.id === job.itemId);
  const action = CONFIG.actions.find((entry) => entry.id === job.actionId);
  job.status = 'running';
  job.startedAt = nowIso();
  job.updatedAt = nowIso();
  job.claudeSession = {
    status: 'locating',
    projectDir: claudeProjectDirForCwd(job.cwd),
    logPath: '',
    sessionId: '',
    eventCount: 0,
    toolUseCount: 0,
    toolResultCount: 0,
    thinkingBlockCount: 0,
    toolNames: [],
  };
  if (item) {
    item.processingState = job.actionId === 'transcribe' ? 'transcribing' : 'running_skill';
    item.history ||= [];
    item.history.unshift({
      id: makeId('hist'),
      time: nowIso(),
      title: `${job.actionLabel} started`,
      status: 'running',
      detail: 'Serial worker started local Claude Code for this job.',
      jobId: job.id,
    });
    item.updatedAt = nowIso();
  }
  await saveState();

  const start = Date.now();
  const timeoutMs = job.timeoutMs || action?.timeoutMs || DEFAULT_RUN_TIMEOUT_MS;
  const permissionMode = job.permissionMode || action?.permissionMode || 'default';
  const claudeArgs = ['-p', '--permission-mode', permissionMode, '-'];
  const child = spawn('claude', claudeArgs, {
    cwd: job.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  activeJobs.set(job.id, child);
  child.stdin.write(job.prompt);
  child.stdin.end();

  const timer = setTimeout(() => {
    job.error = `Timed out after ${timeoutMs}ms`;
    child.kill('SIGTERM');
  }, timeoutMs);

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
  await refreshClaudeSessionForJob(job);

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
  if (currentJobId === job.id) currentJobId = null;
  processNextJob().catch((err) => console.error('[job-queue] unhandled failure', err));
}

async function recoverInterruptedJobs() {
  await loadState();
  let changed = false;
  for (const job of state.jobs) {
    if (job.status === 'queued') {
      job.status = 'waiting';
      job.updatedAt = nowIso();
      changed = true;
    }
    if (job.status === 'running') {
      job.status = 'failed';
      job.error = 'Server restarted while this job was running; job marked interrupted.';
      job.finishedAt = nowIso();
      job.updatedAt = nowIso();
      const item = state.queue.find((entry) => entry.id === job.itemId);
      if (item) {
        item.processingState = 'failed';
        item.history ||= [];
        item.history.unshift({
          id: makeId('hist'),
          time: nowIso(),
          title: `${job.actionLabel} interrupted`,
          status: 'failed',
          detail: job.error,
          jobId: job.id,
        });
        item.updatedAt = nowIso();
      }
      changed = true;
    }
  }
  if (changed) await saveState();
}

async function refreshAllPlaylistsOnStartup() {
  await loadState();
  for (const subscription of state.playlistSubscriptions) {
    try {
      await refreshPlaylistSubscription(subscription);
      console.log(`[playlist] refreshed ${subscription.title || subscription.playlistId}`);
    } catch (err) {
      subscription.status = 'failed';
      subscription.error = err.message;
      subscription.lastCheckedAt = nowIso();
      subscription.updatedAt = nowIso();
      await saveState();
      console.error(`[playlist] refresh failed for ${subscription.title || subscription.playlistId}: ${err.message}`);
    }
  }
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
    await refreshClaudeSessionsForJobs(state.jobs.slice(0, 10));
    sendJson(res, 200, {
      queue: state.queue,
      jobs: state.jobs,
      playlistSubscriptions: state.playlistSubscriptions,
      removedVideos: state.removedVideos,
    });
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
    forgetRemovedVideo(item.videoId);
    state.queue.unshift(item);
    await saveState();
    sendJson(res, 201, { item, duplicate: false });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/queue/playlist') {
    const body = await readJson(req);
    const parsed = parseYoutube(body.url || '');
    if (!parsed.playlistId) throw new Error('No YouTube playlist id found');
    const subscription = upsertPlaylistSubscription({ playlistId: parsed.playlistId, url: body.url });
    const result = await refreshPlaylistSubscription(subscription);
    sendJson(res, 201, result);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/playlists') {
    sendJson(res, 200, { playlistSubscriptions: state.playlistSubscriptions });
    return;
  }
  const playlistRefresh = pathname.match(/^\/api\/playlists\/([^/]+)\/refresh$/);
  if (req.method === 'POST' && playlistRefresh) {
    const id = decodeURIComponent(playlistRefresh[1]);
    const subscription = state.playlistSubscriptions.find((item) => item.id === id || item.playlistId === id);
    if (!subscription) throw new Error('Playlist subscription not found');
    const result = await refreshPlaylistSubscription(subscription);
    sendJson(res, 200, result);
    return;
  }
  const queuePatch = pathname.match(/^\/api\/queue\/([^/]+)$/);
  if (req.method === 'DELETE' && queuePatch) {
    const itemId = queuePatch[1];
    const itemIndex = state.queue.findIndex((entry) => entry.id === itemId);
    if (itemIndex < 0) throw new Error('Queue item not found');
    const activeJob = state.jobs.find((job) => job.itemId === itemId && ['queued', 'waiting', 'running'].includes(job.status));
    if (activeJob) {
      sendError(res, 409, 'Cannot remove a video while a job is active for it', { jobId: activeJob.id });
      return;
    }
    const [removed] = state.queue.splice(itemIndex, 1);
    forgetRemovedVideo(removed.videoId);
    state.removedVideos.unshift({
      id: makeId('removed'),
      videoId: removed.videoId,
      title: removed.title,
      canonicalUrl: removed.canonicalUrl,
      playlistId: removed.playlistId || '',
      source: removed.source || '',
      removedAt: nowIso(),
    });
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
    await refreshClaudeSessionsForJobs(state.jobs.slice(0, 20));
    sendJson(res, 200, { jobs: state.jobs });
    return;
  }
  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && jobMatch) {
    const job = state.jobs.find((entry) => entry.id === jobMatch[1]);
    if (!job) throw new Error('Job not found');
    if (await refreshClaudeSessionForJob(job)) await saveState();
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
await recoverInterruptedJobs();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Video Intake Console running at http://127.0.0.1:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  processNextJob().catch((err) => console.error('[job-queue] startup failure', err));
  refreshAllPlaylistsOnStartup().catch((err) => console.error('[playlist] startup refresh failure', err));
});

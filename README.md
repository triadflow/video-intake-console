# Video Intake Console

Local-first web console for turning YouTube watching into a durable queue of Claude Code skill work.

The use case is simple: you are watching videos that may contain useful material, but you do not always have the focus to decide where that material should go. This app lets you keep watching, capture notes, queue videos and playlists, then run local Claude Code skills later with the video context attached.

It is built for workflows where Claude Code is already used locally across nearby repos. The app does **not** call Anthropic or OpenAI APIs directly. It shells out to the local `claude` CLI with configured skill actions.

## What It Does

- Load and watch a YouTube video inside a local browser GUI.
- Add single videos or public playlists to a durable local queue.
- Keep imported playlist items even if you do not process them immediately.
- Remember removed/dismissed videos so playlist refresh does not re-add them.
- Track separate watch and processing states.
- Filter by decision and processing status.
- Autosave watch notes per video.
- Capture timestamp ranges and choose whether a skill should focus on them.
- Add extra directions for the selected skill run.
- Select configured Claude Code skill actions from the GUI.
- Run one background job at a time through a serial worker.
- Capture run logs, job history, artifacts, timestamps, and downstream git status.
- Link jobs to Claude session JSONL logs when available.
- Copy a queue item's metadata/state for use in a terminal or another agent session.

## Why This Exists

The pain point is not "how do I summarize a video?"

The pain point is:

> I am watching a lot of potentially useful material, but at that moment I may not have the mental capacity to decide which pipeline should use it.

Video Intake Console separates those jobs:

1. Watch and capture lightweight notes.
2. Preserve the source in a queue.
3. Decide later which local skill should process it.
4. Run that skill with structured video context.
5. Review the output and downstream changes.

The first target workflow is feeding videos into `living-doc-compositor` skills such as `/transcribe` and `/integrate-source`, but the app is intentionally shaped for more local Claude Code skills later.

## Current Status

This repo is open source under MIT.

- Epic: <https://github.com/triadflow/video-intake-console/issues/1>

## Requirements

- Node.js 18+.
- Claude Code CLI available as `claude`.
- `yt-dlp` for YouTube metadata and playlist import.
- Existing local Claude Code skills if you want real processing actions.

The app is intentionally dependency-light: the server uses Node's standard library.

## Run Locally

```bash
npm start
```

Open:

```text
http://127.0.0.1:4177
```

Local state is stored in:

```text
.video-intake-data/
```

That directory is ignored by git.

## Checks

```bash
npm run check
npm run smoke:concurrency
```

Useful API probes while the server is running:

```bash
curl -sS http://127.0.0.1:4177/api/health
curl -sS http://127.0.0.1:4177/api/queue
```

## Local Claude Code Routing

The runner invokes Claude Code locally:

```bash
claude -p -
```

Configured actions define:

- display label
- skill invocation
- target working directory
- timeout
- optional allowed tools / addDirs / permission mode

The first real target repo used during development is:

```text
/Users/rene/projects/living-doc-compositor
```

The first real action set includes:

- `/transcribe`
- `/integrate-source`
- custom prompt

## Data Model

Queue items keep video metadata and local workflow state:

- title
- URL
- video ID
- channel
- source playlist
- watch state
- processing state
- review outcome
- watch notes
- label IDs
- timestamp ranges
- timestamp focus flag
- job history
- artifacts

Labels keep shared definitions:

- name
- color
- created/updated timestamps

Jobs keep:

- action name
- prompt/context
- status
- start/finish timestamps
- duration
- stdout/stderr log paths
- exit code
- linked Claude session JSONL path when detected

## Design Principles

- **Local first.** The app assumes your skills, repos, and Claude Code sessions live on your machine.
- **No direct model API.** Processing goes through the local `claude` CLI.
- **Queue before decision.** Capturing a video should be cheaper than deciding what to do with it.
- **Serial background work.** One local processing job at a time avoids runaway processes.
- **Inspectable runs.** Every job should leave logs and enough metadata to reconstruct what happened.
- **Small UI, real workflow.** The GUI is meant to support watching and dispatching, not become another dashboard.

## Timestamp Context

Queue items can carry timestamp ranges shaped as `startSeconds`, optional `endSeconds`, label, and source. The server extracts initial ranges from YouTube URL start parameters and timestamp-like lines in descriptions when metadata is available. The review UI also exposes an editable timestamp box using one range per line:

```text
00:42 - relevant claim
03:10-04:05 - section to inspect
```

The "Focus skill on timestamps" setting is explicit and per-video. When enabled, skill prompts instruct the downstream skill to prioritize the timestamp context before scanning the rest of the source. When disabled, timestamps are still passed as context but are not treated as a timestamp-only focus request.

## Labels

Labels are custom local definitions stored in `state.labels`. Queue items store label associations as `labelIds`, so a label can be renamed or recolored without editing every video. The review UI supports creating, editing, deleting, applying, and filtering by labels, and skill prompts include the current label names as part of the video context.

## Persistence And Local-Service Assumptions

The server stores local state in `.video-intake-data/state.json` and logs under `.video-intake-data/logs/`.

- State mutations are serialized in-process.
- `state.json` writes use a temporary file followed by atomic rename.
- Job stdout/stderr log writes are ordered per job stream.
- The server binds to `127.0.0.1` and is intended for one local operator.

This is not a hardened multi-user web service. It does not provide accounts, auth, CSRF protection, rate limiting, external process isolation, or database-backed cross-process locking.

## Non-Goals For Now

- SaaS hosting.
- User accounts.
- Cloud job runners.
- Direct Anthropic/OpenAI API calls.
- Replacing Claude Code skills.
- Full transcript storage in this repo by default.

## License

MIT. See [LICENSE](LICENSE).

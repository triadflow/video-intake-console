# Video Intake Console

Local web console for collecting YouTube videos into a durable queue, watching them, and launching local Claude Code skill runs against selected videos.

## Run Locally

```bash
npm start
```

Open:

```text
http://127.0.0.1:4177
```

The app stores local state in `.video-intake-data/`, which is ignored by git.

## What Works

- add a YouTube video URL to a persistent local queue
- import a public YouTube playlist when `yt-dlp` is available
- keep `watchState` separate from `processingState`
- filter by `Needs decision`, `Unprocessed`, `Queued`, `Transcribed`, `Needs review`, `Integrated`, `Failed`, and `Skipped`
- store watch notes per video
- discover allowlisted local Claude Code skill actions
- preview the exact local `claude -p` prompt before running
- run selected actions through the local Claude Code CLI
- capture stdout, stderr, exit code, timestamps, and downstream git status
- preserve per-video history and run-log artifacts

## Local Skill Route

The first real skill root is:

```text
/Users/rene/projects/living-doc-compositor/.claude/skills
```

The first configured target cwd is:

```text
/Users/rene/projects/living-doc-compositor
```

The runner invokes Claude Code locally:

```bash
claude -p -
```

The app does not call Anthropic or OpenAI APIs directly.

## Checks

```bash
npm run check
```

Useful API probes while the server is running:

```bash
curl -sS http://127.0.0.1:4177/api/health
curl -sS http://127.0.0.1:4177/api/queue
```

## License

MIT. See [LICENSE](LICENSE).

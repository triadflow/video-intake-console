# Video Intake Console

Static mockup for a local video queue and Claude Code skill runner.

Open `index.html` in a browser. The current mockup has no backend; it models the intended workflow:

- paste or import YouTube videos into a durable queue
- watch the selected video
- add watch notes and extra instructions
- select a local Claude Code skill action
- preview the command shape that a future backend will run locally

Planned backend route:

```bash
claude -p "<skill invocation + video context + extra user direction>"
```

The first real skill root is expected to be:

```text
/Users/rene/projects/living-doc-compositor/.claude/skills
```

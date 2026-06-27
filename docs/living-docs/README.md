# Living Docs

This folder holds this project's living-doc source JSON and rendered standalone HTML.

## Project MCP server

The project-level MCP config lives at `../../.mcp.json` and must include `mcpServers.living_doc_compositor`:

```json
{
  "mcpServers": {
    "living_doc_compositor": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/Users/rene/projects/living-doc-compositor/scripts/living-doc-mcp-server.mjs"
      ]
    }
  }
}
```

Use the MCP tools when available for registry contracts, semantic context, relationship gaps, stage diagnostics, patch validation/application, and rendering.

## Render

```bash
node /Users/rene/projects/living-doc-compositor/scripts/render-living-doc.mjs <absolute-path-to-doc.json>
```

Rendered HTML should be the sibling `.html` file and must remain standalone.

## Catalog And Library

Known local living docs are cataloged in:

```text
/Users/rene/.gtd/living-docs.json
```

Refresh the compositor's local library manifest with:

```bash
node /Users/rene/projects/living-doc-compositor/scripts/export-living-doc-library.mjs
```

The convergence-type registry lives in the compositor repo. Do not copy or fork the compositor runtime or MCP server into this repo unless explicitly requested.

First-doc creation is optional and should be objective-led.

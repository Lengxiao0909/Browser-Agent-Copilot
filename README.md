# Browser Agent Copilot

A Chrome extension based AI copilot that stays available on every page, understands selected content and page context, and can optionally connect to a Chrome DevTools MCP control layer.

## Apps

- `apps/extension`: Vue 3 + TypeScript + WXT browser extension.
- `apps/api`: NestJS API with SSE streaming chat endpoint.
- `packages/shared`: Shared DTOs and tool protocol types.

## Quick Start

```powershell
pnpm install
pnpm dev:api
pnpm dev:extension
```

Load the generated extension from `apps/extension/.output/chrome-mv3` in Chrome.

## Development

- Workflow: `docs/DEVELOPMENT_WORKFLOW.md`
- Stage C agent tools spec: `docs/specs/stage-c-agent-tools.md`

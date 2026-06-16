# Browser Agent Copilot

Browser Agent Copilot is a low-friction Chrome extension that keeps an AI
assistant available on every webpage. Users can ask questions about the current
page, reference selected text, and run Agent-style browser tasks without
installing Python tools or using a CLI.

The current product path is extension-native: WXT content scripts collect page
context and execute browser actions, the background service worker coordinates
tab-level tasks, and the NestJS API handles planning, model streaming, and
conversation persistence.

## Current Capabilities

- Floating Chrome extension panel injected into normal webpages.
- Page-aware chat with selected-text references.
- Streaming model answers through the local API.
- Local and best-effort server conversation history.
- User-configurable OpenAI-compatible LLM endpoints.
- Low-risk page tools:
  - read page summary
  - extract links
  - describe page structure
  - find text
  - highlight text
  - scroll to text
  - read selected text
  - read page content
- Agent research loop:
  - plan web/literature search from natural language
  - ask for user confirmation before opening/reading external tabs
  - open search results in Agent-created tabs
  - read top result pages
  - let the model evaluate read results and request one bounded follow-up search
  - synthesize final answers from the gathered evidence

## Project Structure

```text
apps/extension       WXT + Vue 3 Chrome extension
apps/api             NestJS API, SSE chat stream, Prisma persistence
packages/shared      Shared DTOs, chat protocol, BrowserAction types
packages/agent-core  Built-in browser tool registry
prisma               Database schema and migrations
docs                 Development notes and feature specs
```

Key files:

- `apps/extension/src/App.vue`: panel UI.
- `apps/extension/src/stores/copilot.ts`: chat, workflow, history, and model state.
- `apps/extension/entrypoints/background.ts`: stream, tab, search, replan, and tool bridge coordinator.
- `apps/extension/src/utils/browserActions.ts`: content-side browser tool executor.
- `apps/extension/src/utils/pageContext.ts`: page/selection context collection.
- `apps/api/src/modules/chat/*`: planning, re-planning, prompting, and streaming.
- `packages/shared/src/chat.ts`: chat stream and Agent workflow protocol.
- `packages/shared/src/tools.ts`: browser tool contract.

## Quick Start

Requirements:

- Node.js
- pnpm 10+
- Chrome or Chromium
- PostgreSQL if you want server-side persistence

Install dependencies:

```powershell
pnpm install
```

Create `.env` from `.env.example` and fill in local settings:

```powershell
Copy-Item .env.example .env
```

Start the API:

```powershell
pnpm dev:api
```

Start the extension dev build:

```powershell
pnpm dev:extension
```

Load the unpacked Chrome extension from:

```text
apps/extension/.output/chrome-mv3
```

The API health check is:

```powershell
Invoke-RestMethod -Uri 'http://localhost:3001/health'
```

## Commands

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm prisma:generate
pnpm prisma:migrate
```

Important Windows note: stop the running API process before `pnpm build`,
`pnpm typecheck`, or `pnpm prisma:generate` if it is holding
`apps/api/generated/prisma/query_engine-windows.dll.node`.

## Agent Safety Model

Browser Agent Copilot separates browser actions by risk:

- Low-risk actions read or annotate the current page.
- Medium-risk actions can open/read Agent-created tabs and require confirmation.
- High-risk actions are reserved for future workflows that mutate user data or
  submit forms.

The model cannot directly execute arbitrary browser commands. It can only
request typed, allow-listed browser actions. Search/research re-planning is
bounded to one additional model-directed search round, and browser/page content
is treated as untrusted source data.

## Current Limitations

- The Agent loop is useful for research/search tasks, but it is still bounded
  and not a fully autonomous browser controller.
- Follow-up re-planning currently allows one additional search/read round.
- DevTools MCP and browser-use are not required for the normal-user flow and
  remain future optional adapters.
- Local PostgreSQL setup is required for reliable server persistence; the
  extension keeps local fallback history/model config when persistence fails.

## Development Notes

- Product progress has priority over heavy process work.
- Do not commit `.env` or local build/runtime output.
- `CODEX_MEMORY.md` is the local handoff file for future Codex sessions and is
  intentionally git-ignored.
- Relevant specs:
  - `docs/specs/stage-c-agent-tools.md`
  - `docs/DEVELOPMENT_WORKFLOW.md`

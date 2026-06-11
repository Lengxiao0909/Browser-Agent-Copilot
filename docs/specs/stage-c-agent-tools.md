# Spec: Stage C Agent Tools

## Objective

Stage C turns the existing low-risk BrowserAction bridge into a practical
agent tool loop. The model should be able to request safe page actions, the
extension should execute them in the active tab, and the chat UI should show
clear tool status before the final answer.

Target users are normal Chrome users who expect the copilot to understand and
act on the current page without Python, CLI setup, or developer tooling.

## Current Baseline

Implemented:

- Content-script BrowserAction executor for low-risk page actions.
- Background-to-content bridge for manual tool execution.
- Page Tools drawer in the panel.
- `/chat/plan` endpoint for lightweight low-risk action planning.
- Background execution of planned tool calls through the active tab.
- Tool result injection into `/chat/stream`.
- Chat tool status cards.

Not implemented:

- Medium/high-risk confirmation flow.
- DevTools MCP adapter.
- Agent-created tab inheritance.
- Automated extension E2E tests.

## Supported Low-Risk Tools

- `browser.get_page_summary`
- `browser.extract_links`
- `browser.describe_page_structure`
- `browser.find_text`
- `browser.highlight_text`
- `browser.scroll_to_text`
- `browser.read_selected_text`

## Commands

From the repository root:

```powershell
pnpm install
pnpm typecheck
pnpm lint
pnpm build
pnpm dev:api
pnpm dev:extension
```

API health check:

```powershell
Invoke-RestMethod -Uri 'http://localhost:3001/health'
```

Extension build output:

```text
apps/extension/.output/chrome-mv3
```

## Project Structure

- `packages/shared/src/chat.ts`: chat stream and tool result protocol.
- `packages/shared/src/tools.ts`: BrowserAction and tool execution types.
- `packages/agent-core/src/browser-actions.ts`: built-in tool registry entries.
- `apps/api/src/modules/chat/*`: planning and streaming.
- `apps/api/src/modules/tools/*`: tool registry HTTP API.
- `apps/extension/entrypoints/background.ts`: stream and bridge coordinator.
- `apps/extension/src/utils/browserActions.ts`: content-side execution.
- `apps/extension/src/stores/copilot.ts`: chat, tool, and conversation state.
- `apps/extension/src/App.vue`: panel UI and status rendering.

## Acceptance Criteria

- A user can ask for links, structure, selection, summary, find, highlight, or
  scroll actions in natural language.
- Low-risk actions are planned before the final model answer.
- Planned actions execute in the current tab through the extension bridge.
- Tool cards show running, success, or error status.
- Successful tool outputs are available to the final model response.
- Failed tools do not crash the stream; the user sees the failure state.
- `pnpm typecheck`, `pnpm lint`, and `pnpm build` pass.

## Next Tasks

- [ ] Add focused tests for `/chat/plan` intent routing.
  - Acceptance: supported low-risk intents map to expected tool calls.
  - Verify: API test command or targeted TypeScript test once test harness exists.
  - Files: `apps/api/src/modules/chat/*`.

- [ ] Add structured copy for manual Page Tools output.
  - Acceptance: users can copy the latest structured tool result from the drawer.
  - Verify: extension typecheck, build, and manual panel check.
  - Files: `apps/extension/src/App.vue`, `apps/extension/src/stores/copilot.ts`.

- [ ] Add confirmation UX for medium/high-risk actions.
  - Acceptance: non-low-risk actions cannot execute without explicit user
    confirmation in the panel.
  - Verify: typecheck, build, manual refusal/confirm paths.
  - Files: shared tool protocol, background bridge, panel UI.

- [ ] Add Agent-created tab conversation inheritance.
  - Acceptance: future agent-created tabs can inherit a parent conversation ID
    without normal browsing tabs overwriting each other.
  - Verify: background storage tests or manual tab checks.
  - Files: `apps/extension/entrypoints/background.ts`,
    `apps/extension/src/stores/copilot.ts`.

## Open Questions

- Should `/chat/plan` remain deterministic, or should it move to model-native
  tool calling after the first stable release?
- Which medium-risk browser actions should ship first?
- Should DevTools MCP remain an advanced setting or become a separate mode?

# CRITICAL RULES (HIGHEST PRIORITY)

- !!! ЗАПРЕЩЕНО при любых обстоятельствах коммитить/пушить/стягивать (fetch/pull/merge/rebase/patch) любые изменения из/в репозитории `https://github.com/lubarsky-coffee/coffee-grinder/` и `https://github.com/korel-san/coffee-grinder`. Это старые репозитории, которые НЕ являются источником правды.
- Единственный официальный source of truth: `git@github.com:lubarsky-coffee-grinder/coffee-grinder.git` (HTTPS: `https://github.com/lubarsky-coffee-grinder/coffee-grinder`). Любые git-операции выполнять только относительно этого репозитория.
- Использовать только remote `origin`; remote `personal` не использовать и не создавать.
- НИКОГДА не предлагать открывать PR через ссылку. PR создавать/управлять только через GitHub CLI (`gh pr ...`).
- НИКОГДА не делать push в `main` (запрещено). Всегда работать через отдельные ветки + PR.
- В репозитории должен быть включен pre-push hook, который блокирует push в `main` (см. `.githooks/pre-push`). Если хуки не включены, включить через `cd grinder && npm run prepare` (или `git config core.hooksPath .githooks`).

# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the root TypeScript entry point.
- `grinder/` is the pipeline app with `package.json`, `src/`, `config/`, `articles/`, and `logs/`.
- `audio/` and `img/` store generated media artifacts.

## Build, Test, and Development Commands
- Build: `npm install` then `npm run build`.
- Grinder install: `cd grinder && npm install`.
- Grinder run order: `npm run cleanup` -> `npm run load` -> `npm run summarize` -> `npm run slides` -> `npm run screenshots` -> `npm run upload-img` -> `npm run audio`.

## Coding Style & Naming Conventions
- TypeScript uses `strict` mode; keep types and avoid `any`.
- JavaScript/TypeScript files in `grinder/src` use **tabs** for indentation; keep tabs (do not reformat) unless a dedicated formatting-only change is agreed.
- Use 2-space indentation in JSON/config files; prefer single quotes in `.ts`.
- Always keep changes consistent with existing patterns. If you are unsure, follow analogous code in the repository.
- Hacks/quick fixes are only allowed by explicit agreement.
- Use `camelCase` for variables/functions and `PascalCase` for types/classes.
- Pipeline stages in `grinder/src` use numeric prefixes (`0.cleanup`, `1.load`, `2.summarize`, etc.); keep the ordering pattern.
- Legacy-совместимость, alias и fallback-ветки запрещены без явного согласования: при изменении модели сразу переводить код на целевую схему и удалять старые сущности.
- Принцип разработки: необходимое и достаточное. Держать минимум кода, переменных и сущностей; не создавать новые сущности без явной необходимости.

## Architecture Overview
- `grinder/src/store.js` loads the `news` table from Google Sheets and saves changes.
- `1.load.js` pulls RSS feeds from `grinder/config/feeds.js`, parses Google News items, and seeds `news`.
- `2.summarize.js` fetches article HTML, converts to text, and calls OpenAI Assistant to fill summaries and topics.
- `3.slides.js` creates/updates a Google Slides deck, writes `img/screenshots.txt`, and `screenshots.js` renders `img/*.jpg`. `4.audio.js` generates narration via ElevenLabs and uploads to Google Drive.

## Platform Notes (Windows vs macOS)
- This project started on Windows; `.bat` helpers (`0.prepare.bat`, `2.summarize.bat`, `3.output.bat`, `auto.bat`) automate the pipeline.
- On macOS, run steps from `grinder/` using npm scripts. The `.bat` files use `fnm use 24`, so align your Node version.
- If you don’t use `fnm`, install Node 24 with `nvm` (or your manager of choice) and set it as the project default.
- macOS quickstart:
```sh
cd grinder
npm install
npm run cleanup
npm run load
npm run summarize
npm run slides
npm run screenshots
npm run upload-img
npm run audio
```
- Screenshots use Playwright; if browsers are missing, run `npx playwright install` once.

## Testing Guidelines
- Tests live in `grinder/tests/*.test.js` and run via `cd grinder && npm test` (Node's built-in test runner).
- Prefer fast, deterministic unit/integration-style tests that run fully offline.

## Test Rules
- Use `node:test` + `--experimental-test-module-mocks` (see existing `grinder/tests/summarize.test.js`).
- Do not change pipeline script code to make it testable; tests must adapt via mocks.
- No network and no real providers in tests:
  - Never call Google APIs, OpenAI, ElevenLabs, Playwright browsers, or RSS endpoints.
  - Mock internal modules that wrap providers (`grinder/src/google-*.js`, `grinder/src/ai.js`, `grinder/src/eleven.js`, `playwright`, `fetch`, etc.).
- Keep dependencies minimal:
  - Prefer small inline fixtures in the test file.
  - If fixtures are large or reused, store them under `grinder/tests/fixtures/<stage>/...`.
- Keep tests hermetic and parallel-safe:
  - Avoid writing to shared paths; prefer mocking `fs`/`fs/promises`.
  - If a script writes to disk by design, write only to ignored paths and keep filenames unique.
  - Freeze time when scripts depend on `Date.now()` / `new Date()` for deterministic assertions.
  - Some scripts auto-run based on `process.argv[1]` (e.g. `includes('screenshots')`, `includes('upload-img')`): in tests, temporarily set `process.argv[1] = 'node'` before `import()` to prevent accidental execution during module import.
- Naming:
  - One script = one test file: `grinder/tests/<script>.test.js` (e.g. `cleanup.test.js`, `load.test.js`, etc.).
  - One PR per script test (keep diffs small and reviewable).

## Commit & Pull Request Guidelines
- Commit history uses short, imperative subjects and occasional Conventional Commit prefixes (e.g., `fix: ...`). Follow that style; `type:` prefixes are optional.

## Configuration & Secrets
- Grinder scripts load environment variables via `dotenv`. Store secrets in `grinder/.env` and keep them out of version control.
- When adding new code in touched files, prefer reading env via `dotenv` once (shared helper) instead of scattered `process.env` accesses. If a file is already using direct `process.env`, refactor to the shared helper while you are there to avoid tech debt.
- E2E tests must use real integrations (no mocks/stubs); only unit/integration tests may mock.

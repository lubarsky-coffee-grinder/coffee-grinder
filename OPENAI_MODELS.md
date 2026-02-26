# OpenAI Models For `grinder` Summarization

`grinder/src/ai.js` uses OpenAI **Chat Completions API** for article summarization.
`grinder/src/enrich.js` uses the **Responses API + `web_search` tool** for facts/videos enrichment.

## One Env Var Per Task

- `OPENAI_SUMMARIZE_MODEL` (default: `gpt-5-mini`)
- `OPENAI_FACTS_MODEL` (default: `gpt-4o`)
- `OPENAI_TITLE_LOOKUP_MODEL` (default: `OPENAI_FACTS_MODEL` or `gpt-4o`)
- `OPENAI_VIDEO_VERIFY_MODEL` (default: `gpt-4o-mini`)
- `OPENAI_FALLBACK_KEYWORDS_MODEL` (default: `gpt-4.1-mini`)
- `OPENAI_SCREENSHOT_MODEL` (default: `gpt-4o-mini`)

There is no shared `OPENAI_MODEL` alias and no model fallback chain.
Each task reads only its own model variable.

Examples:

```sh
cd grinder
OPENAI_FACTS_MODEL=gpt-4o OPENAI_SUMMARIZE_MODEL=gpt-5-mini npm run summarize
```

## Request Templates (Systematic)

All OpenAI requests are built via shared templates in `grinder/src/openai-request-templates.js`:

- `buildResponsesWebSearchRequest(...)` for facts/title tasks.
- `buildChatCompletionsRequest(...)` for summarize/video-verify/keywords/screenshots.

Behavior is deterministic by template:
- If model supports `temperature`, it is sent.
- If endpoint/model forbids `temperature`, template omits it and injects a deterministic sampling hint into system instructions.
- If model supports reasoning effort, template sets task default:
  summarize=`medium`, facts=`low`, title_lookup=`low`, video_verify=`medium`, keywords=`medium`, screenshot_vision=`medium`.
- `gpt-5.2` with temperature in Responses requires `reasoning.effort="none"` (enforced automatically).
- No retry logic is used for OpenAI model requests.

## Fallback Keywords (Alternative Source Matching)

When an article URL can't be extracted, the summarizer can search for the same event in other sources. To avoid unrelated matches, it asks GPT to select a small set of URL-slug keywords and uses them for strict `keywordOper=and` search in newsapi.ai.

Env var:

- `OPENAI_FALLBACK_KEYWORDS_MODEL` (default: `gpt-4.1-mini`)

## Video Verify (Candidate Filtering)

Video candidate verification uses OpenAI Chat Completions in `grinder/src/video-links.js`.

Env var:

- `OPENAI_VIDEO_VERIFY_MODEL` (default: `gpt-4o-mini`)

## Facts And Title Lookup

- Facts generation (`summarize:facts`) uses `OPENAI_FACTS_MODEL` + `web_search`.
- Title lookup (`summarize:title-by-url`) uses `OPENAI_TITLE_LOOKUP_MODEL` + `web_search`.
- Title lookup task is URL-based: model receives URL and returns probable article title/context (it is not a rewrite of already-loaded article body).

## GPT Model Options (IDs + Snapshots)

These are official GPT model IDs from OpenAI docs (some accounts may not have access to all of them):

- GPT‑5.2: `gpt-5.2` (`gpt-5.2-2025-12-11`)
- GPT‑5.1: `gpt-5.1` (`gpt-5.1-2025-11-13`)
- GPT‑5: `gpt-5` (`gpt-5-2025-08-07`)
- GPT‑5 mini: `gpt-5-mini` (`gpt-5-mini-2025-08-07`)
- GPT‑5 nano: `gpt-5-nano` (`gpt-5-nano-2025-08-07`)
- GPT‑4.1: `gpt-4.1` (`gpt-4.1-2025-04-14`)
- GPT‑4.1 mini: `gpt-4.1-mini` (`gpt-4.1-mini-2025-04-14`)
- GPT‑4.1 nano: `gpt-4.1-nano` (`gpt-4.1-nano-2025-04-14`)
- GPT‑4o: `gpt-4o` (`gpt-4o-2024-11-20`, `gpt-4o-2024-08-06`)
- GPT‑4o mini: `gpt-4o-mini` (`gpt-4o-mini-2024-07-18`)

Source of truth:

- Models index: https://developers.openai.com/api/docs/models
- Each model page includes snapshots and endpoint/tool support.

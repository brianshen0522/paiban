# 18 Language model settings and subtitle translation

Brian, 2026-10-07: subtitle searches often find only English ones, and he wants to translate them into Chinese with a language model. At the same time, the language model settings move out of "Sources → Auto-align" into a separate admin page, "LLM settings", which can hold several profiles and do load balancing and fallback.

## Profiles

Administrators create any number of profiles on the "LLM settings" page (`/admin/llm`). Each profile:

| Field | Description |
| --- | --- |
| Name | 1 to 60 characters, for people to read |
| Provider | OpenAI, Anthropic, Azure OpenAI, Azure AI Foundry, OpenRouter, Ollama, self-hosted OpenAI-compatible services (vLLM, LM Studio, etc.) |
| Service URL | Required for Ollama, self-hosted, Azure OpenAI and Azure AI Foundry; optional for OpenAI, Anthropic and OpenRouter (empty uses the official URL; filled in, it is a proxy in front). For Ollama, fill it in up to the port (`http://192.168.1.10:11434`); a pasted `…/v1` is removed automatically |
| API version | Only for the two Azure kinds; defaults `2024-10-21` (Azure OpenAI), `2024-05-01-preview` (Azure AI Foundry) |
| Key | Optional (self-hosted services often have none). Stored encrypted (AES-256-GCM, with `llm:<profile id>` as associated data, so it can't be moved to another profile); once saved it is never shown again, only "Key set" |
| Model | For Azure OpenAI, the deployment name |
| Priority | 1 to 9; 1 is used first |
| Weight | 1 to 100; the share of requests within the same priority |
| Enabled | Disabled profiles are never picked |
| Parameters | temperature (0 to 2, default 0.2), maximum output length (256 to 32000, default 8000), timeout (10 to 600 seconds, default 300: translating one chunk of 50 lines can take several minutes with models that "think" first; measured on 2026-10-07, the same chunk took 264 seconds on glm-5.3 with reasoning on, and 24 seconds on a model with reasoning off), concurrent requests (1 to 16, default 3), turn off reasoning (on by default: sends `reasoning_effort: "none"` to OpenAI-compatible services and `think: false` to Ollama, and drops it automatically when rejected), context length (Ollama only, `num_ctx`, 2048 to 131072, default 16384) |

### Services that don't follow the rules

- Requests always carry `stream: false`. Some gateways that route to many models still answer with `text/event-stream`: one whole JSON body followed by `data: [DONE]`, or a series of `data:` chunks (`delta`). Both are read as usual (Brian, 2026-10-07, actually ran into this).
- Some gateways replace `response_format: json_object` with their own instruction (asking the model to answer `{"answer": …}`), overriding the format we want. When an answer doesn't match the format, ask again without `response_format`, and remember not to send it to this URL.

### Why Ollama is its own kind (Brian, 2026-10-07)

Ollama also has an OpenAI-compatible interface, but translation uses its own `/api/chat`:

- Context length: Ollama's default context is small, and anything beyond it is silently cut off without an error; one translation chunk (50 lines plus 20 lines of context before and after, the summary and the answer) easily exceeds it, and the result is missing lines. The compatible interface can't adjust it; the native interface sends `options.num_ctx` with every request.
- `think: false` is more reliable than `reasoning_effort`; older Ollama versions don't necessarily recognize the latter.
- `format` takes the answer's JSON schema directly, so the model is less likely to drop or add lines.
- The model list comes from `/api/tags`.
- When an older Ollama rejects a field (400), retry by dropping `think`, then replacing `format` with `"json"`, then dropping `format`, in that order, and remember.

### Distribution: load balancing and fallback

For each request:

1. Take the enabled profiles and group them into layers by priority.
2. From the first layer, pick one at random by weight among those "not cooling down right now and not at their concurrent request limit". If all are full, wait.
3. On failure:
   - Rate-limited (429), unreachable, timed out, 5xx: that profile cools down for 60 seconds, and another profile in the same layer is tried; if none in the layer works, move to the next layer.
   - Key rejected (401, 403): cool down for 10 minutes (waiting for an administrator to fix the settings).
   - Unreadable answer, model refused: no cooldown; retry this request with the next profile.
   - When all usable profiles are cooling down: if the cooldown reason is rate limiting, timeout or unreachable, wait for the cooldown to end and then send (e.g. pressing "Resume" within a minute after a timeout doesn't fail immediately); if it is a rejected key or incomplete settings, waiting won't help, so report that reason directly.
4. One request is tried at most 4 times (with different profiles). If all fail, the last error is returned to the caller.

Cooldown state is kept only in memory (cleared when `api` restarts); the settings page shows "cooling down until when, and why" for each profile.

Every call (successful or not) writes a row to `llm_usage`: time, profile, purpose (translation, auto-align, test), user, number of requests, success or failure, error code, how long it took. The settings page lists the latest 50 rows. The program never deletes these rows automatically (they aren't files; when there are many, administrators can clear them by hand, which the first version doesn't provide).

### Who uses these profiles

Translation and auto-align ("Language model" in [08-media-pipeline.md](08-media-pipeline.md)) share the same set of profiles. The single language model setting in "Sources → Auto-align" is removed; on upgrade, `api` moves it into the first profile at startup (Anthropic → Anthropic; OpenAI-compatible → self-hosted; the key is re-encrypted), then deletes the old setting and `llmKey`. It only moves data and sends no requests.

### Floating window

Adding or editing a profile happens in a floating window (`<dialog>`), from top to bottom:

1. Name.
2. Provider (menu). "Service URL" (required) only appears for self-hosted or Azure; Azure adds "API version".
3. Key (password box, optional). When editing a profile with a key set, it shows "Set. Leave empty to keep it", with "Clear key" next to it.
4. Model: a text box plus a "Fetch models" button. Pressing it asks the service for its model list using the URL and key currently filled in (the stored key if no key is filled in yet); the result becomes suggestions for the text box (`<datalist>`), and you can also type directly. When Azure OpenAI can't return a deployment list, it says "Azure doesn't list deployments. Type the deployment name."
5. Priority, weight, enabled.
6. Parameters (collapsible).
7. "Test": sends one small translation using the values currently in the window (even unsaved), and shows "Succeeded in 1.2 seconds: 〈the model's answer〉" or the reason for failure.
8. "Save", "Cancel".

## Subtitle translation

### Where it starts

Every subtitle on the workspace's "Subtitles" tab has "Translate". Pressing it opens a floating window:

- Target language (menu, default Traditional Chinese; lists common languages, and a language code can also be typed).
- Form: "Translation only" or "Bilingual" (translation above, original below, in the same line).
- "Start translation".

When there is no usable profile, the button is disabled and says "An administrator hasn't set up a language model".

### What the model is given

- Background: TMDB's title (Chinese and original), year, genres, summary (`language=zh-TW`; YTS's English summary when there is no Chinese one).
- Chunks: 50 lines to translate per chunk. Before them, up to 10 lines with their already-finished translations; after them, up to 10 lines of original text, marked "for reference only, do not translate".
- Chunks are translated in order, and each chunk uses the previous chunk's translation as reference, so wording and names stay consistent.
- The answer must be JSON: `{"lines": [{"id": 12, "text": "..."}, ...]}`, one entry per line, where id is the number of a line to translate, and line breaks are `\n`.
- Check: the ids must be exactly the lines to translate, none missing; on missing lines, extra lines or a bad format, retry this chunk (with another profile, up to 3 times), and if it still fails, the whole translation fails.

### Results

- Only when everything is translated is it written as new subtitles: the source is "AI translation" (`provider = 'translated'`), the version name is 「AI 翻譯（〈model〉）· 〈original subtitles' version name〉」 ("AI translation (〈model〉) · …" when the person who started the translation uses the English interface), the language is the target language, and the lines map one-to-one to the original subtitles (same numbers and times).
- The sync result (segments, per-line edits, checkpoints) is copied from the original subtitles' current version, so if the original is synced, the translation doesn't need syncing again; the status is draft, and the sync must be confirmed before export.
- Lines deleted in the original subtitles are still translated (the deleted state is copied along with the sync result).
- Like other subtitles, it can be removed.

### In progress

- Runs in the background in `api` (only `api` can read the keys). The Subtitles tab shows "Translating: chunk 3 / 20" and "Cancel".
- Translated chunks are saved to `translations.lines` as they finish; after a failure or an `api` restart, pressing "Resume" continues from the chunk where it stopped, without retranslating finished ones.
- Cancel: stops sending new requests and marks this translation as cancelled; no subtitle file has been written, so there is nothing to delete.
- For the same subtitles, the same target language and form, only one translation can run at a time (`TRANSLATION_RUNNING`).
- If the same combination already has a failed or cancelled one, pressing "Translate" again resumes that one (continuing from the chunk where it stopped, not counted against the limit) instead of starting a new one (Brian, 2026-10-07: previously there would be one running and one failed, which were really the same thing). The notice says "These subtitles were half translated before; continuing from chunk N". The Subtitles tab's list shows only the latest one for each combination.

### Who can translate

Holders of the film. Each person can start at most 5 translations per hour (administrators change this on the LLM settings page, 0 to 100); beyond that, `RATE_LIMITED` is returned. "Resume" doesn't count.

## Endpoints

See the "Language models" and "Translation" sections of [04-api.md](04-api.md) and the contract `packages/shared/src/contracts/api.ts`.

## Tests

Automated tests use a local fake model service (OpenAI-compatible) and don't go online. To test: distribution (weights, cooldowns, moving between layers, all failing), fetching the model list, the test button, how chunks and reference lines are assembled, retry on missing lines, cancel, resuming from where it stopped, the content and sync result of the resulting subtitles, the rate limit, migrating the old setting.

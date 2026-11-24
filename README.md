# dsh-image-to-text

<div align="center">

<p><b>Let a text-only model read images.</b><br>
A pure-text conversation model calls an <code>ask_image</code> tool; a reader model that
is already registered in the same DSH — one that declares image input — answers, and the
text comes back as the tool result.</p>

<p>
<a href="https://www.npmjs.com/package/dsh-image-to-text"><img src="https://img.shields.io/npm/v/dsh-image-to-text?style=flat-square&labelColor=1F2328&color=2DA44E&logo=npm&logoColor=white" alt="npm version"></a>
<a href="https://www.npmjs.com/package/dsh-image-to-text"><img src="https://img.shields.io/npm/dm/dsh-image-to-text?style=flat-square&labelColor=1F2328&logo=npm&logoColor=white" alt="npm downloads"></a>
<a href="./LICENSE"><img src="https://img.shields.io/npm/l/dsh-image-to-text?style=flat-square&labelColor=1F2328&color=blue" alt="MIT license"></a>
<img src="https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.5%20%3C0.3.0-38BDF8?style=flat-square&labelColor=1F2328" alt="dsh >=0.2.1-rc.5 <0.3.0">
</p>

<p><b>English</b> · <a href="README.zh.md">简体中文</a></p>

</div>

## Why

DeepSeek Harness lets you mix models in one session. A model that accepts only text
cannot see the images in that session: the host rejects the image at admission, the
adapter replaces it with a placeholder line, and the model has no way to know what is
in the picture.

This plugin closes that gap with one tool. The text-only model decides when it needs
the picture and calls `ask_image` with a `purpose` — the question to answer, the text
to extract, the check to run. The plugin hands the image plus that purpose to a model
that declares image input, and returns its answer as text.

- **No conversion, no HTTP requests from the plugin.** The image stays inside the host:
  the plugin passes the attachment reference to the LLM service, and the selected
  reader provider sends it. Whether the image leaves the machine depends on where that
  provider runs.
- **Ask only when needed.** No image is read unless the model calls the tool, and the
  question is the model's own `purpose`, not a fixed "describe this image".
- **Works only for text-only models.** When the session model declares `image` input,
  `ask_image` disappears and the built-in `read_image` comes back.
- **One extra round trip.** Reading a picture is one more model call with one more
  tool round trip, billed to the reader provider.

## Requirements

| Requirement | Value |
|---|---|
| dsh | `>= 0.2.1-rc.5 < 0.3.0` (verified on `0.2.1-rc.5` only) |
| Host services | `llm`, `tools`, `systemPrompt`; the configuration page also needs `settings` and `webServer` |
| Reader model | a model in the catalog that declares `image` input (`inputModalities` includes `image`) |

Without `settings` and `webServer` the tool still works; there is just no configuration
page.

## Install

Open **Plugins → Add plugin** in DSH and point it at this bundle. Two targets both work:

- **Directory**: `target` is an absolute path to this repository. pnpm records it as a
  `link:`, so the copy under the profile's `node_modules` is a symlink to your working
  tree — handy while developing. See the symlink note below.
- **Tarball**: `npm pack --pack-destination ./dist` in the repo, then point `target` at
  the generated `dsh-image-to-text-<version>.tgz`. pnpm installs a real copy; moving or
  deleting the source tree later does not affect it. This is the recommended way for
  long-term use.

With a `link:` install, Node resolves `@deepseek-ai/schemastery` (the plugin's only
dependency) by walking up from the package directory, and the `~/.dsh/self-plugins/…`
path has no `node_modules` above it. Create a symlink inside the package to the copy the
profile already has, or the plugin fails to load:

```bash
mkdir -p <package-dir>/node_modules/@deepseek-ai
ln -sfn ~/.dsh/profiles/<profile>/node_modules/@deepseek-ai/schemastery \
        <package-dir>/node_modules/@deepseek-ai/schemastery
```

A tarball install has no such problem: the real copy lives under the profile's
`node_modules`, whose parent already holds `@deepseek-ai/schemastery`.

After installing or reloading, `ask_image` appears in sessions whose current model is
text-only.

## Configuration

Open **Plugins**, find the `dsh-image-to-text` row, and click **Configure**. The model
dropdown comes from the plugin's own read-only endpoint `/plugins/image-to-text/models`
and lists only models that declare image input.

| Field | Default | Purpose |
|---|---|---|
| `readerMode` | `auto` | `auto` picks a reader from the model catalog; `fixed` uses `readerProvider` / `readerModel`. |
| `readerProvider` | empty | Provider id when `fixed`; required. |
| `readerModel` | empty | Model id when `fixed`; required. |
| `preferProviders` | `[]` | Provider ids to try first under `auto`, in array order. Comma-separated in the settings page. |
| `promptTemplate` | built-in | User message sent to the reader when the caller gives a `purpose`. `{{purpose}}` and `{{maxChars}}` each replaced once; empty falls back to the built-in template. |
| `defaultPrompt` | built-in | Used when the caller gives no `purpose`; empty falls back to the built-in prompt. |
| `maxChars` | `8000` | Character cap for one reading. Over the cap it is cut with a `…[truncated]` marker; values below 1 or invalid use `8000`, above `100000` use `100000`. When the cap is too small to hold the marker the text is cut hard. |
| `timeoutSeconds` | `180` | Deadline for one reading. Values below 1 or invalid use `180`, cap `3600`. |
| `bridgeAdmission` | `true` | Declares image support to prompt admission so a text-only model can take an image into the session as a placeholder. Turning it off usually means image messages get rejected; for troubleshooting only. Read once at load time — reload the plugin to change it. |
| `pathImport` | `true` | Lets `ask_image` read a file on disk via the `path` argument (e.g. a slide the model just rendered). Off means only images already in the session. |
| `cacheEntries` | `200` | How many readings are kept in process memory; `0` disables caching, cap `5000`. |

`settingsFrom()` unwraps the volatile references the settings page writes, so a saved
change is used by the next reading. The cache key includes the prompt and `maxChars`,
so editing either never hits stale results.

## Using `ask_image`

One tool, all arguments optional:

- `image`: which image to read. Pass the 8-hex tag after `sha256:` in the placeholder
  (either case, with or without the `sha256:` prefix), or its 1-based index in the
  current session. Omitted means the most recent image.
- `path`: use this when the image is still only a file on disk — an absolute path or a
  path relative to the session's working directory. The plugin reads it once through the
  host's file service, stores it as an attachment, then hands it to the reader, so you
  do not need the built-in `read_image` first. `path` wins over `image`.
- `purpose`: what you want from the image, in the user's language — "read the third
  column", "check whether this screenshot shows an error". The reader answers the
  request instead of captioning the image. Omitted uses `defaultPrompt`.

`path` reading goes through the host's own file service: path resolution, access scope
and per-file byte limits are decided by the deployment (e.g. a remote backend resolves
paths on its machine, not on the machine running DSH). The plugin only recognizes the
format and stores the attachment; size and format limits are the deployment's.

The result is the reader's text, with a first line naming the image's `sha256:` tag and
the `provider/model` that actually served it:

```
[sha256:1a2b3c4d via provider-a/qwen-vl]
The screenshot shows …
```

The model name is there so you know who answered this extra request and whether it was
truncated.

## Only for text-only models

At every system-prompt assembly the plugin decides about the session model:

- `inputModalities` present and without `image`: text-only. `ask_image` is kept, the
  built-in `read_image` is hidden, and the usage paragraph is filled into the system
  prompt.
- `inputModalities` includes `image`: can see images. `ask_image` is hidden, the
  paragraph stays empty.
- Declaration missing, empty, or the lookup failed: treated as able to see images, so
  `ask_image` is not offered — a model with no declaration is not assumed to need it.

The current route is the first available of: pending selection → session request header
→ deployment default. The verdict for a given `provider/model` is cached and cleared on
`llm/adapters-updated`, so switching models takes effect at the next assembly. Tool
registration is global; real visibility is decided by the assembly filter and
`tools.guard`, which rejects `ask_image` only when the agent was already judged not to
be text-only.

## How the reader is chosen

`auto`:

1. Only models that explicitly declare `image` in the catalog are considered.
2. `preferProviders` order wins first.
3. Then candidates sharing the current conversation model's provider.
4. Then models whose id, name or provider mentions `vl`, `vision`, `llava`, `omni`.
5. Otherwise catalog order.
6. With no candidates the tool returns "no reader model available" and points at
   Plugins → Configure.

`fixed`:

- `readerProvider` and `readerModel` must both be set, or configuration is incomplete.
- An unresolvable, unregistered or explicitly text-only model is an error; there is no
  silent fallback.
- A model with unknown modality is allowed — unknown is not unsupported.

`auto` only guarantees a model that declares image support; it does not guarantee the
model is currently reachable. A failed call comes back to the conversation model as a
tool error; there is no automatic retry on another model.

## When things fail

A failed reading affects only that one `ask_image` call; the session keeps going. The
conversation model gets an English error it can retry or explain from:

- No reader model available, or `fixed` points at a model that does not exist.
- `fixed` points at a model that is explicitly text-only.
- The reading timed out or was cancelled.
- The reader returned empty text, or tool calls without text.
- The image selector matched nothing; the error lists the tags and indices available in
  the session.
- `path` points at a missing file, a non-regular file, an unsupported extension, bytes
  that are not an image, or a file beyond the deployment's image limits.

`lib/tool.js` maps the main messages; unknown errors keep the reader service's own text,
so the model does not need to understand internal error codes.

## Privacy and cost

> [!NOTE]
> The plugin itself uploads nothing: it passes the attachment reference to the host LLM
> service and the reader provider's adapter sends the image. Whether the image leaves
> the machine depends on where that provider runs. Each reading is an extra model
> request billed to the reader provider; the main model also spends one tool round trip
> of tokens.

- On a cache miss, every reading is an extra model request charged to the reader
  provider. Besides the image, the prompt template, the `purpose` and the session id
  are sent as call parameters.
- The cache is in-process memory keyed by "session + image + reader model + purpose +
  cap + prompt digest". It resets on restart and is never shared across processes or
  sessions.
- `maxChars` limits the returned text only; it does not resize the image sent to the
  reader.

## Known limitations

- Every reading is one extra round trip versus seeing the image directly.
- The main model may not call `ask_image` at all, especially without a clear question or
  when it thinks it already knows the answer; the plugin can only guide via the tool
  description and the prompt section.
- The tool's `timeoutMs` is fixed at registration as `timeoutSeconds * 1000 + 15000`.
  The extra 15 seconds let the reading's own timeout fire first and produce a specific
  error. Changing `timeoutSeconds` requires reloading the plugin.
- A model with a missing modality declaration is treated as able to see images, so it
  never gets `ask_image`; if it is really text-only, that is a limitation of the
  declaration.
- One image per call; the `image` selector works on the session's visible messages and
  the error lists at most the 20 most recent tags.
- `path` reading needs the host's `fs` and `attachments` services. When both are absent
  the tool returns a readable error and nothing else is affected (the plugin does not
  declare them in `inject`, so it still mounts on a minimal profile).
- The settings page's dropdown lists only models that declare image input; a model with
  unknown modality is not listed but can still be written into the config and used in
  `fixed` mode.

## Development

```bash
npm test          # node --test test/
npm run check     # node --check, syntax only
```

Tests use only `node:test` and `node:assert/strict`; no network, no `~/.dsh` access.
Files, one per module:

```
test/images.test.js
test/prompt.test.js
test/config.test.js
test/route.test.js
test/reader.test.js
test/tool.test.js
test/visibility.test.js
test/bridge.test.js
test/apply.test.js
test/import.test.js
```

The `@deepseek-ai/schemastery` and `@deepseek-ai/cosmokit` symlinks under the repo root's
`node_modules/@deepseek-ai/` exist only so tests can resolve `@deepseek-ai/schemastery`
locally. They are not runtime dependencies of the package; the host provides those at
runtime. They are git-ignored; rebuild on a new machine with:

```bash
mkdir -p node_modules/@deepseek-ai
ln -s <dsh-install>/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery
ln -s <dsh-install>/node_modules/@deepseek-ai/cosmokit   node_modules/@deepseek-ai/cosmokit
```

To sync edited code to a local install copy, `npm run sync:profile` (default target
`~/.dsh/self-plugins/dsh-image-to-text`, override with `DSH_IMAGE_TO_TEXT_TARGET`). The
script only copies files and self-checks; it does not restart the process.

## Uninstall

Disable or remove the bundle in **Plugins**. The plugin keeps no data outside the
package; there is nothing else to delete.

## License

MIT © 2026 Szleaves. See [LICENSE](LICENSE).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

---
name: tfvision-imagegen
description: Generate or edit images on Windows and macOS through TFVision's o1key asynchronous image API with Nano Banana and GPT Image 2 models. Use when the user asks to draw, generate, render, restyle, or edit an image with TFVision, o1key, Nano Banana, nano-banana-2, or GPT Image 2; supports text-to-image, local/URL references encoded uniformly as base64, ratios, resolutions, quality, batches, safe task resumption, polling, and local download.
---

# TFVision Image Generation

Use the bundled standard-library Python scripts without starting the TFVision web app.

## Prepare the runtime

1. Select a Python 3.10+ command:
   - On macOS/Linux, try `python3` first.
   - On Windows, try `python`, then `py -3`.
   - Use the same command for every example below; `<python>` means the selected command.
2. Quote the skill, config, reference-image, prompt-file, and output paths. Accept both Windows paths and macOS/POSIX paths.
3. Check masked configuration:

   ```text
   <python> <skill-dir>/scripts/configure.py --show
   ```

4. If the API key is missing, stop before any network request and ask exactly one concise question:

   `请把 API Key 临时发在当前对话中；我会把它写入本机配置文件，不在回复中复述。`

   Explain only if needed that the key persists locally in `~/.tfvision-imagegen/config.json`. Do not ask again when the saved key or `TFVISION_IMAGE_API_KEY` exists.
5. Save a provided key through private stdin where supported:

   ```text
   <python> <skill-dir>/scripts/configure.py --api-key-stdin
   ```

   Alternatively use `--api-key-env NAME` when the key already exists in an environment variable. Use hidden `--api-key` only when the execution tool offers no private stdin or environment channel. Never echo the key, put it in a workspace file, or repeat it in output.
6. Run preflight after configuration. Add `--network` to verify DNS/TLS without an API call or credit use:

   ```text
   <python> <skill-dir>/scripts/doctor.py --network --output-dir <absolute-output-dir>
   ```

## Generate or edit

Generate with the configured default, initially the exact model ID `nano-banana-2`:

```text
<python> <skill-dir>/scripts/generate_image.py "A cinematic product photo" --output-dir <absolute-output-dir>
```

Edit with one or more references:

```text
<python> <skill-dir>/scripts/generate_image.py "Change only the pose" --image <absolute-image-path> --aspect-ratio 3:4 --output-dir <absolute-output-dir>
```

Return saved absolute paths and embed local images when supported.

## Choose options

- Keep `nano-banana-2` unless the user requests another model.
- Use `--model gpt-image-2-c` for GPT Image 2 special-price routing or `--model gpt-image-2` for official routing.
- Use `--resolution 512|1K|2K|4K` for Banana. Use `1K|2K|4K` for GPT Image 2.
- Use `--aspect-ratio auto|1:1|3:4|4:3|2:3|3:2|9:16|16:9`; Banana supports additional ratios in `references/api.md`.
- Repeat `--image <path-or-url>` for up to nine references. Download URL inputs first and send every reference as a Base64 Data URL. Never send an image URL upstream.
- Use `--quality auto|high|medium|low` only for GPT Image 2.
- Use `--count 1..9` for independent tasks.
- Use `--prompt-file` when shell quoting is fragile.
- Use `--dry-run` to inspect a sanitized request without an API call.
- Use `--no-wait` only when the user wants task IDs without polling.

## Recover safely

- Preserve every printed task ID.
- After a timeout or interrupted polling process, continue the same task instead of resubmitting:

  ```text
  <python> <skill-dir>/scripts/generate_image.py --resume <task-id> --output-dir <absolute-output-dir>
  ```

- Resume several known tasks by repeating `--resume`.
- Never retry `billing_error`, authentication, permission, or invalid-parameter failures automatically.
- Never retry an interrupted POST automatically because the upstream may have created a billable task even when the response was lost.
- Allow the client to retry transient polling GET failures; it does so with bounded backoff.

Read [references/api.md](references/api.md) for request schemas and [references/troubleshooting.md](references/troubleshooting.md) for platform and failure guidance.

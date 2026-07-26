# TFVision image API reference

## Transport

- Base URL default: `https://api.o1key.cn`
- Submit: `POST /async/v1/generateImage`
- Poll: `GET /async/v1/tasks/{task_id}`
- Authentication: `Authorization: Bearer <api_key>`
- Submit success codes: `200`, `201`, or `202`
- Maximum JSON request body: 20 MB

The client scans common nested response containers (`data`, `result`, `response`, `output`, `task_result`, `content`) and accepts common task/status/result field variants.

## Configuration

Default path: `~/.tfvision-imagegen/config.json`. Override it with `TFVISION_IMAGEGEN_CONFIG` or `--config`.

Environment variable `TFVISION_IMAGE_API_KEY` overrides the saved key for the current process.

```json
{
  "api_key": "",
  "base_url": "https://api.o1key.cn",
  "defaults": {
    "model": "nano-banana-2",
    "resolution": "2K",
    "aspect_ratio": "auto",
    "quality": "auto",
    "output_format": "png",
    "poll_interval_seconds": 2.0,
    "timeout_seconds": 600
  }
}
```

Use `scripts/configure.py` instead of manually editing this file. The script merges changes, writes atomically, masks the key in `--show`, and applies owner-only permissions where supported.

Configuration helpers:

- `--api-key-stdin`: read a key without placing it in command arguments.
- `--api-key-env NAME`: copy a key from an existing environment variable.
- `--clear-api-key`: remove the saved key.
- `--show`: display only a masked key and non-secret settings.

## Banana request

```json
{
  "model": "nano-banana-2",
  "prompt": "...",
  "size": "2K",
  "aspect_ratio": "16:9",
  "images": ["data:image/png;base64,...", "data:image/jpeg;base64,..."],
  "google_search": true
}
```

`aspect_ratio`, `images`, and `google_search` are optional. For `512`, the request sends `size: "512px"`.

Every `images` item is a base64 Data URL. A local path is read and encoded directly. An HTTP(S) URL is downloaded by the skill and encoded before submission; the original URL is never included in the upstream JSON. Accepted image formats are PNG, JPEG, and WebP.

Supported Banana ratios: `auto`, `1:1`, `1:2`, `2:1`, `9:16`, `16:9`, `3:4`, `4:3`, `3:2`, `2:3`, `5:4`, `4:5`, `21:9`, `9:21`.

Common model IDs:

- `nano-banana-2` (skill default; exact raw ID)
- `nano-banana-pro`
- `nano-banana`
- `gemini-3.1-flash-image` (official Nano Banana 2 route)
- `gemini-3-pro-image` (official Nano Banana Pro route)
- `gemini-2.5-flash-image` (official original Nano Banana route)

The TFVision UI additionally maps resolution-specific discounted aliases such as `nano-banana-2-0.5k`, `nano-banana-2-1k`, `nano-banana-2-2k`, and `nano-banana-2-4k`. The skill deliberately keeps the user's raw model ID unchanged; its initial default is exactly `nano-banana-2`.

## GPT Image 2 request

```json
{
  "model": "gpt-image-2-c",
  "prompt": "...",
  "size": "3648x2048",
  "quality": "auto",
  "n": 1,
  "output_format": "png",
  "images": ["data:image/png;base64,..."]
}
```

- `gpt-image-2-c`: special-price route
- `gpt-image-2`: official route
- Quality: `auto`, `high`, `medium`, `low`
- Output format: `png`, `jpeg`, `webp`
- Ratios: `auto`, `1:1`, `3:4`, `4:3`, `2:3`, `3:2`, `9:16`, `16:9`

For `auto`, `size` is the tier (`1K`, `2K`, or `4K`). Other ratios map to exact dimensions:

| Tier | 1:1 | 3:2 | 2:3 | 4:3 | 3:4 | 16:9 | 9:16 |
|---|---|---|---|---|---|---|---|
| 1K | 1024x1024 | 1536x1024 | 1024x1536 | 1360x1024 | 1024x1360 | 1824x1024 | 1024x1824 |
| 2K | 2048x2048 | 3072x2048 | 2048x3072 | 2736x2048 | 2048x2736 | 3648x2048 | 2048x3648 |
| 4K | 2880x2880 | 3504x2336 | 2336x3504 | 3264x2448 | 2448x3264 | 3840x2160 | 2160x3840 |

`--count` creates independent tasks with `n: 1`, matching the TFVision application behavior.

## Task recovery

Use `--resume <task_id>` to poll and download an existing task without another submit request. Repeat the option for multiple tasks. Resume is intentionally incompatible with prompts, reference images, count, dry-run, and no-wait options.

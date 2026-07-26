# Reliability and platform guidance

## Lessons from real runs

| Symptom | Cause or risk | Required behavior |
|---|---|---|
| API key is absent on first use | Configuration is intentionally not bundled | Ask once, save it in the user-local config, and mask it in every output. |
| Configuration write is denied | The agent sandbox may not allow writing outside the workspace | Request permission for the exact user config path; never fall back to storing the key in the project. |
| `billing_error` on submit | Balance, billing route, or model entitlement is unavailable | Report the structured error and stop. Do not switch models or retry without user direction. |
| POST connection drops before a task ID arrives | The task may still exist upstream | Treat the result as ambiguous and do not resubmit automatically. |
| Polling times out | The task may still be running | Keep the task ID and use `--resume`; do not create a replacement task. |
| Batch submission fails partway through | Earlier tasks may already be billable | Print each task ID immediately and resume the created IDs instead of rerunning the batch. |
| Poll GET returns 429/5xx or a temporary socket failure | Transient upstream/network fault | Retry only GET polling with bounded backoff. Never apply the same automatic retry to POST. |
| Upstream error text is garbled | Charset metadata can be missing or inconsistent | Decode using declared charset, UTF-8, then GB18030; always surface the structured error type/code. |
| A reference was passed as an HTTP URL | Upstream behavior differs between URL and Base64 inputs | Download and validate PNG/JPEG/WebP locally, then send a Base64 Data URL only. |
| Request exceeds 20 MB | Base64 expands image bytes by roughly one third | Stop before submission and ask for smaller/fewer reference images. |
| Completed task contains no result image | Response schema changed or upstream produced an incomplete result | Report the task ID and sanitized response error; do not claim success. |
| Polling is resumed after a successful download | Re-downloading can overwrite a valid file | Reuse a non-empty task-ID result file and write new downloads atomically through a temporary `.part` file. |

## Windows and macOS

- Require Python 3.10 or newer. Use `python3` on macOS; use `python` or `py -3` on Windows.
- Invoke scripts through Python rather than relying on executable bits, which ZIP extraction may remove on macOS.
- Quote every path. This covers spaces, Chinese characters, and macOS paths under `/Users/...`.
- Store configuration at `~/.tfvision-imagegen/config.json` on both platforms. Override with `TFVISION_IMAGEGEN_CONFIG` only when required.
- Save results to a user-writable absolute directory. Avoid protected folders such as `/System`, `/Library`, `C:\Windows`, or application installation directories.
- If macOS reports certificate verification failure with a python.org installation, run its bundled `Install Certificates.command`, then rerun `doctor.py --network`.
- When a proxy is required, configure standard `HTTPS_PROXY`/`HTTP_PROXY` environment variables before starting the agent.

## Distribution checklist

1. Package the entire `tfvision-imagegen` directory without `__pycache__`, generated images, config files, or API keys.
2. Install it as `~/.codex/skills/tfvision-imagegen` and start a new Codex task.
3. Run `doctor.py` with the platform's Python command.
4. Configure a per-user key; never share the publisher's key.
5. Run one `--dry-run`, then a low-count real generation.

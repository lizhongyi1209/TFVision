#!/usr/bin/env python3
"""Generate images with TFVision's o1key async image API."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import mimetypes
import os
import re
import ssl
import tempfile
import time
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from configure import API_KEY_ENV, config_path, load_config


SUBMIT_ENDPOINT = "/async/v1/generateImage"
TASK_ENDPOINT = "/async/v1/tasks/"
MAX_BODY_BYTES = 20_000_000
MAX_RESULT_BYTES = 100_000_000
SUPPORTED_IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp"}
SUCCESS = {"success", "succeed", "succeeded", "completed", "done", "finished"}
FAILURE = {
    "failure", "fail", "failed", "error", "expired", "timeout", "timed_out",
    "cancel", "canceled", "cancelled", "rejected",
}
RUNNING = {
    "submitted", "queued", "pending", "running", "processing", "in_progress",
    "in-progress", "created",
}
BANANA_RATIOS = {
    "auto", "1:1", "1:2", "2:1", "9:16", "16:9", "3:4", "4:3",
    "3:2", "2:3", "5:4", "4:5", "21:9", "9:21",
}
GPT_RATIOS = {"auto", "1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9"}
GPT_SIZE_TABLE = {
    "1K": {
        "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536",
        "4:3": "1360x1024", "3:4": "1024x1360", "16:9": "1824x1024", "9:16": "1024x1824",
    },
    "2K": {
        "1:1": "2048x2048", "3:2": "3072x2048", "2:3": "2048x3072",
        "4:3": "2736x2048", "3:4": "2048x2736", "16:9": "3648x2048", "9:16": "2048x3648",
    },
    "4K": {
        "1:1": "2880x2880", "3:2": "3504x2336", "2:3": "2336x3504",
        "4:3": "3264x2448", "3:4": "2448x3264", "16:9": "3840x2160", "9:16": "2160x3840",
    },
}


class SkillError(RuntimeError):
    pass


def sources(payload: Any) -> Iterable[dict[str, Any]]:
    queue = [payload]
    seen: set[int] = set()
    while queue:
        current = queue.pop(0)
        if not isinstance(current, (dict, list)) or id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, list):
            queue.extend(current)
            continue
        yield current
        for key in ("data", "result", "response", "output", "task_result", "content"):
            child = current.get(key)
            if isinstance(child, (dict, list)):
                queue.append(child)


def extract_task_id(payload: Any) -> str:
    for source in sources(payload):
        for key in ("task_id", "taskId", "id"):
            if source.get(key):
                return str(source[key])
    raise SkillError("提交响应中未找到 task_id")


def status_value(payload: Any) -> str:
    found: list[str] = []
    for source in sources(payload):
        for key in ("status", "task_status", "state", "task_state"):
            value = source.get(key)
            if value is not None and str(value).strip():
                found.append(str(value).strip())
    for options in (FAILURE, RUNNING, SUCCESS):
        for value in found:
            if value.lower() in options:
                return value
    return found[0] if found else ""


def normalized_status(payload: Any) -> str:
    value = status_value(payload).lower()
    if value in FAILURE or any(token in value for token in ("fail", "error", "reject", "timeout", "cancel")):
        return "failed"
    if value in SUCCESS:
        return "success"
    return "running"


def error_message(payload: Any) -> str:
    for source in sources(payload):
        error = source.get("error")
        if isinstance(error, dict):
            for key in ("message", "msg", "detail", "reason", "code"):
                if error.get(key):
                    return str(error[key])
        elif error:
            return str(error)
        for key in (
            "fail_reason", "failure_reason", "task_status_msg", "status_msg",
            "error_message", "message", "msg", "reason", "detail",
        ):
            if source.get(key):
                return str(source[key])
    return "未知错误"


def progress_value(payload: Any) -> float | None:
    for source in sources(payload):
        for key in ("progress", "percentage", "percent"):
            value = source.get(key)
            if isinstance(value, (int, float)):
                return float(value) / 100 if value > 1 else float(value)
    return None


def extract_images(payload: Any) -> list[tuple[str, str]]:
    output: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(kind: str, value: Any) -> None:
        if not isinstance(value, str) or not value or value in seen:
            return
        if value.startswith("data:image"):
            add("b64", value.split(",", 1)[-1])
            return
        if kind == "url" and not value.startswith(("http://", "https://")):
            return
        seen.add(value)
        output.append((kind, value))

    def handle(item: Any) -> None:
        if isinstance(item, str):
            add("url", item)
        elif isinstance(item, dict):
            for key in ("url", "image_url", "result_url", "download_url"):
                add("url", item.get(key))
            for key in ("b64_json", "base64", "image_base64"):
                add("b64", item.get(key))
            for key in ("inline_data", "inlineData"):
                inline = item.get(key)
                if isinstance(inline, dict):
                    add("b64", inline.get("data"))

    for source in sources(payload):
        for key in ("image_url", "result_url", "url", "download_url"):
            add("url", source.get(key))
        for key in ("images", "output_images", "outputs"):
            value = source.get(key)
            if isinstance(value, list):
                for item in value:
                    handle(item)
            elif value:
                handle(value)
    return output


def decode_http_bytes(raw: bytes, headers: Any) -> str:
    encodings: list[str] = []
    try:
        charset = headers.get_content_charset()
        if charset:
            encodings.append(charset)
    except (AttributeError, LookupError):
        pass
    encodings.extend(["utf-8-sig", "gb18030"])
    for encoding in dict.fromkeys(encodings):
        try:
            return raw.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", errors="replace")


def http_error_detail(text: str) -> str:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return text[:500]
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            error_type = str(error.get("type") or error.get("code") or "upstream_error")
            message = str(error.get("message") or error.get("detail") or "").strip()
            return f"{error_type}: {message}" if message else error_type
        if error:
            return str(error)[:500]
    return json.dumps(payload, ensure_ascii=False)[:500]


def json_request(url: str, api_key: str, method: str = "GET", body: dict[str, Any] | None = None) -> Any:
    encoded = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    headers = {"Authorization": f"Bearer {api_key}"}
    if encoded is not None:
        headers["Content-Type"] = "application/json"
    attempts = 3 if method == "GET" else 1
    for attempt in range(attempts):
        request = Request(url, data=encoded, headers=headers, method=method)
        try:
            with urlopen(request, timeout=60) as response:
                status = response.status
                raw = decode_http_bytes(response.read(), response.headers)
            break
        except HTTPError as exc:
            raw = decode_http_bytes(exc.read(), exc.headers)
            if method == "GET" and exc.code in {429, 500, 502, 503, 504} and attempt + 1 < attempts:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise SkillError(f"HTTP {exc.code}: {http_error_detail(raw)}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            if method == "GET" and attempt + 1 < attempts:
                time.sleep(1.5 * (attempt + 1))
                continue
            if method == "POST":
                raise SkillError(f"提交连接中断，任务是否创建未知，请勿直接重复提交: {exc}") from exc
            raise SkillError(f"网络请求失败: {exc}") from exc
    else:
        raise SkillError("网络请求失败")
    if method == "POST" and status not in (200, 201, 202):
        raise SkillError(f"提交失败 HTTP {status}: {raw[:500]}")
    if method == "GET" and status != 200:
        raise SkillError(f"查询失败 HTTP {status}: {raw[:500]}")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SkillError(f"上游响应不是 JSON: {raw[:300]}") from exc


def image_mime(data: bytes, hint: str = "") -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    normalized = hint.split(";", 1)[0].strip().lower().replace("image/jpg", "image/jpeg")
    if normalized in SUPPORTED_IMAGE_MIMES:
        return normalized
    raise SkillError("参考图内容不是受支持的 PNG、JPEG 或 WebP")


def encoded_image(data: bytes, hint: str = "") -> str:
    mime = image_mime(data, hint)
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def normalized_data_url(value: str) -> str:
    match = re.fullmatch(r"data:(image/(?:png|jpe?g|webp));base64,(.+)", value.strip(), re.IGNORECASE | re.DOTALL)
    if not match:
        raise SkillError("参考图 Data URL 必须是 PNG、JPEG 或 WebP 的 base64 格式")
    try:
        data = base64.b64decode(re.sub(r"\s+", "", match.group(2)), validate=True)
    except (ValueError, binascii.Error) as exc:
        raise SkillError("参考图 Data URL 的 base64 内容无效") from exc
    return encoded_image(data, match.group(1))


def safe_url(value: str) -> str:
    parsed = urlsplit(value)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def remote_image(value: str) -> str:
    display_url = safe_url(value)
    for attempt in range(3):
        request = Request(value, headers={"User-Agent": "TFVision-Imagegen/1.0"})
        try:
            with urlopen(request, timeout=120) as response:
                data = response.read(MAX_BODY_BYTES + 1)
                content_type = response.headers.get("Content-Type", "")
            break
        except HTTPError as exc:
            if exc.code in {429, 500, 502, 503, 504} and attempt < 2:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise SkillError(f"下载参考图失败 HTTP {exc.code}: {display_url}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
                continue
            if isinstance(getattr(exc, "reason", None), ssl.SSLCertVerificationError):
                raise SkillError(f"下载参考图 TLS 证书校验失败: {display_url}") from exc
            raise SkillError(f"下载参考图失败: {display_url}: {exc}") from exc
    else:
        raise SkillError(f"下载参考图失败: {display_url}")
    if len(data) > MAX_BODY_BYTES:
        raise SkillError(f"远程参考图超过 {MAX_BODY_BYTES / 1_000_000:.0f} MB: {value}")
    filename_mime = mimetypes.guess_type(urlsplit(value).path)[0] or ""
    return encoded_image(data, content_type or filename_mime)


def local_image(value: str) -> str:
    if value.startswith("data:image"):
        return normalized_data_url(value)
    if value.startswith(("http://", "https://")):
        return remote_image(value)
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise SkillError(f"参考图不存在: {path}")
    data = path.read_bytes()
    if len(data) > MAX_BODY_BYTES:
        raise SkillError(f"本地参考图超过 {MAX_BODY_BYTES / 1_000_000:.0f} MB: {path}")
    return encoded_image(data, mimetypes.guess_type(path.name)[0] or "")


def is_gpt(model: str) -> bool:
    return model.lower() in {"gpt", "gpt-image-2", "gpt-image-2-c", "gpt image 2"}


def resolved_model(model: str) -> str:
    normalized = model.strip().lower()
    aliases = {
        "banana2": "nano-banana-2",
        "nano banana 2": "nano-banana-2",
        "banana-pro": "nano-banana-pro",
        "nano banana pro": "nano-banana-pro",
        "banana": "nano-banana",
        "nano banana": "nano-banana",
        "gpt": "gpt-image-2-c",
        "gpt image 2": "gpt-image-2-c",
    }
    return aliases.get(normalized, model.strip())


def request_body(args: argparse.Namespace, prompt: str, images: list[str]) -> dict[str, Any]:
    model = resolved_model(args.model)
    if is_gpt(model):
        if args.resolution == "512":
            raise SkillError("GPT Image 2 不支持 512；请选择 1K、2K 或 4K")
        if args.aspect_ratio not in GPT_RATIOS:
            raise SkillError(f"GPT Image 2 不支持比例 {args.aspect_ratio}")
        size = args.resolution if args.aspect_ratio == "auto" else GPT_SIZE_TABLE[args.resolution][args.aspect_ratio]
        body: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "size": size,
            "quality": args.quality,
            "n": 1,
            "output_format": args.output_format,
        }
    else:
        if args.aspect_ratio not in BANANA_RATIOS:
            raise SkillError(f"Banana 模型不支持比例 {args.aspect_ratio}")
        body = {
            "model": model,
            "prompt": prompt,
            "size": "512px" if args.resolution == "512" else args.resolution,
        }
        if args.aspect_ratio != "auto":
            body["aspect_ratio"] = args.aspect_ratio
        if args.google_search:
            body["google_search"] = True
    if images:
        body["images"] = images
    size_bytes = len(json.dumps(body, ensure_ascii=False).encode("utf-8"))
    if size_bytes > MAX_BODY_BYTES:
        raise SkillError(f"请求体 {size_bytes / 1_000_000:.1f} MB 超过 20 MB 上限")
    return body


def safe_dry_run(body: dict[str, Any], count: int) -> dict[str, Any]:
    safe = dict(body)
    if "images" in safe:
        safe["images"] = [f"<base64-data-url {len(value)} chars>" for value in safe["images"]]
    return {"count": count, "request": safe}


def submit(base_url: str, api_key: str, body: dict[str, Any]) -> str:
    payload = json_request(base_url + SUBMIT_ENDPOINT, api_key, "POST", body)
    return extract_task_id(payload)


def poll(base_url: str, api_key: str, task_id: str) -> tuple[str, Any]:
    payload = json_request(base_url + TASK_ENDPOINT + quote(task_id, safe=""), api_key)
    return normalized_status(payload), payload


def extension(data: bytes, content_type: str = "") -> str:
    ctype = content_type.split(";", 1)[0].lower()
    if "jpeg" in ctype or "jpg" in ctype or data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if "webp" in ctype or (data.startswith(b"RIFF") and data[8:12] == b"WEBP"):
        return ".webp"
    return ".png"


def fetch_result(kind: str, value: str, api_key: str) -> tuple[bytes, str]:
    if kind == "b64":
        try:
            data = base64.b64decode(value, validate=False)
        except ValueError as exc:
            raise SkillError("结果图片 base64 无效") from exc
        return data, extension(data)

    def fetch(headers: dict[str, str]) -> tuple[bytes, str]:
        request = Request(value, headers=headers)
        with urlopen(request, timeout=120) as response:
            data = response.read(MAX_RESULT_BYTES + 1)
            if len(data) > MAX_RESULT_BYTES:
                raise SkillError(f"结果图片超过 {MAX_RESULT_BYTES / 1_000_000:.0f} MB")
            return data, extension(data, response.headers.get("Content-Type", ""))

    try:
        return fetch({"Authorization": f"Bearer {api_key}"})
    except (HTTPError, URLError, TimeoutError, OSError):
        try:
            return fetch({})
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            raise SkillError(f"下载结果图片失败: {exc}") from exc


def safe_name(task_id: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", task_id).strip(".-")
    return value[:120] or f"image-{int(time.time())}"


def save_results(items: list[tuple[str, str]], output_dir: Path, task_id: str, api_key: str) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []
    stem = safe_name(task_id)
    for index, (kind, value) in enumerate(items):
        suffix = f"_{index + 1}" if len(items) > 1 else ""
        existing = next(
            (
                output_dir / f"{stem}{suffix}{candidate_ext}"
                for candidate_ext in (".png", ".jpg", ".webp")
                if (output_dir / f"{stem}{suffix}{candidate_ext}").is_file()
                and (output_dir / f"{stem}{suffix}{candidate_ext}").stat().st_size > 0
            ),
            None,
        )
        if existing is not None:
            saved.append(existing.resolve())
            continue
        data, ext = fetch_result(kind, value, api_key)
        path = (output_dir / f"{stem}{suffix}{ext}").resolve()
        fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".part", dir=output_dir)
        temp = Path(temp_name)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, path)
        finally:
            try:
                temp.unlink(missing_ok=True)
            except OSError:
                pass
        saved.append(path)
    return saved


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Generate images with TFVision's async image API.")
    p.add_argument("prompt", nargs="?", help="Text prompt.")
    p.add_argument("--prompt-file", help="Read the prompt from a UTF-8 text file.")
    p.add_argument("--config", help="Override the configuration path.")
    p.add_argument("--model")
    p.add_argument("--resolution", choices=["512", "1K", "2K", "4K"])
    p.add_argument("--aspect-ratio")
    p.add_argument("--quality", choices=["auto", "high", "medium", "low"])
    p.add_argument("--output-format", choices=["png", "jpeg", "webp"])
    p.add_argument("--image", action="append", default=[], help="Repeat for local paths, URLs, or data URLs.")
    p.add_argument("--count", type=int, default=1)
    p.add_argument("--output-dir", default="output")
    p.add_argument("--poll-interval", type=float)
    p.add_argument("--timeout", type=int)
    p.add_argument("--google-search", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--no-wait", action="store_true")
    p.add_argument("--resume", action="append", default=[], metavar="TASK_ID", help="Poll existing task IDs without resubmitting.")
    return p


def main() -> int:
    args = parser().parse_args()
    try:
        cfg = load_config(config_path(args.config))
        defaults = cfg["defaults"]
        args.model = args.model or str(defaults["model"])
        args.resolution = args.resolution or str(defaults["resolution"])
        args.aspect_ratio = args.aspect_ratio or str(defaults["aspect_ratio"])
        args.quality = args.quality or str(defaults["quality"])
        args.output_format = args.output_format or str(defaults["output_format"])
        args.poll_interval = args.poll_interval if args.poll_interval is not None else float(defaults["poll_interval_seconds"])
        args.timeout = args.timeout if args.timeout is not None else int(defaults["timeout_seconds"])
        if not args.model.strip():
            raise SkillError("model 不能为空")
        if args.resolution not in {"512", "1K", "2K", "4K"}:
            raise SkillError(f"不支持的 resolution: {args.resolution}")
        if args.quality not in {"auto", "high", "medium", "low"}:
            raise SkillError(f"不支持的 quality: {args.quality}")
        if args.output_format not in {"png", "jpeg", "webp"}:
            raise SkillError(f"不支持的 output format: {args.output_format}")
        if not 1 <= args.count <= 9:
            raise SkillError("count 必须在 1 到 9 之间")
        if args.poll_interval < 0.5 or args.timeout < 1:
            raise SkillError("poll interval 至少 0.5 秒，timeout 必须大于 0 秒")

        body: dict[str, Any] | None = None
        if args.resume:
            if args.prompt or args.prompt_file or args.image or args.count != 1 or args.no_wait or args.dry_run:
                raise SkillError("--resume 不能与提示词、参考图、count、--no-wait 或 --dry-run 同时使用")
        else:
            if args.prompt_file:
                prompt = Path(args.prompt_file).expanduser().read_text(encoding="utf-8").strip()
            else:
                prompt = (args.prompt or "").strip()
            if not prompt:
                raise SkillError("缺少提示词")
            if len(args.image) > 9:
                raise SkillError("参考图最多 9 张")
            images = [local_image(item) for item in args.image]
            body = request_body(args, prompt, images)

            if args.dry_run:
                print(json.dumps(safe_dry_run(body, args.count), ensure_ascii=False, indent=2))
                return 0

        api_key = os.environ.get(API_KEY_ENV, "").strip() or str(cfg.get("api_key", "")).strip()
        if not api_key:
            print("ERROR: 未配置 API key。请先运行 scripts/configure.py。")
            return 2
        base_url = str(cfg.get("base_url", "https://api.o1key.cn")).rstrip("/")
        if not base_url.startswith(("https://", "http://")):
            raise SkillError("base URL 必须以 http:// 或 https:// 开头")
        task_ids: list[str] = []
        if args.resume:
            task_ids = list(dict.fromkeys(task_id.strip() for task_id in args.resume if task_id.strip()))
            if not task_ids:
                raise SkillError("--resume 缺少有效 task ID")
            for task_id in task_ids:
                print(f"继续查询任务: {task_id}")
        else:
            assert body is not None
            for index in range(args.count):
                try:
                    task_id = submit(base_url, api_key, body)
                except SkillError as exc:
                    if task_ids:
                        joined = ", ".join(task_ids)
                        raise SkillError(
                            f"第 {index + 1} 个任务提交失败；已创建任务: {joined}。"
                            f"请用 --resume 查询这些任务，不要整批重复提交。原因: {exc}"
                        ) from exc
                    raise
                task_ids.append(task_id)
                print(f"已提交任务: {task_id}")
            if args.no_wait:
                return 0

        output_dir = Path(args.output_dir).expanduser().resolve()
        failed = False
        for task_id in task_ids:
            deadline = time.monotonic() + args.timeout
            last_progress: int | None = None
            while True:
                status, payload = poll(base_url, api_key, task_id)
                if status == "failed":
                    print(f"ERROR: 任务 {task_id} 失败: {error_message(payload)}")
                    failed = True
                    break
                if status == "success":
                    items = extract_images(payload)
                    if not items:
                        print(f"ERROR: 任务 {task_id} 已完成但响应中没有图片")
                        failed = True
                        break
                    for path in save_results(items, output_dir, task_id, api_key):
                        print(f"已保存: {path}")
                    break
                progress = progress_value(payload)
                percent = round(progress * 100) if progress is not None else None
                if percent is not None and percent != last_progress:
                    print(f"任务 {task_id}: {percent}%")
                    last_progress = percent
                if time.monotonic() >= deadline:
                    print(
                        f"ERROR: 等待任务 {task_id} 超时；任务可能仍在运行。"
                        f"请用 --resume {task_id} 继续查询，不要直接重复提交。"
                    )
                    failed = True
                    break
                time.sleep(args.poll_interval)
        return 1 if failed else 0
    except (SkillError, KeyError, TypeError, ValueError, OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

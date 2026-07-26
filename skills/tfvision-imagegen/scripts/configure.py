#!/usr/bin/env python3
"""Manage the user-local TFVision image generation configuration."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import tempfile
from pathlib import Path
from typing import Any


CONFIG_ENV = "TFVISION_IMAGEGEN_CONFIG"
API_KEY_ENV = "TFVISION_IMAGE_API_KEY"

DEFAULT_CONFIG: dict[str, Any] = {
    "api_key": "",
    "base_url": "https://api.o1key.cn",
    "defaults": {
        "model": "nano-banana-2",
        "resolution": "2K",
        "aspect_ratio": "auto",
        "quality": "auto",
        "output_format": "png",
        "poll_interval_seconds": 2.0,
        "timeout_seconds": 600,
    },
}


def config_path(explicit: str | None = None) -> Path:
    raw = explicit or os.environ.get(CONFIG_ENV)
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path.home() / ".tfvision-imagegen" / "config.json").resolve()


def merged_config(value: Any) -> dict[str, Any]:
    result = {
        **DEFAULT_CONFIG,
        "defaults": dict(DEFAULT_CONFIG["defaults"]),
    }
    if not isinstance(value, dict):
        return result
    for key in ("api_key", "base_url"):
        if key in value:
            result[key] = value[key]
    if isinstance(value.get("defaults"), dict):
        result["defaults"].update(value["defaults"])
    return result


def load_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return merged_config({})
    try:
        return merged_config(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"配置文件无法读取或不是有效 JSON: {path}: {exc}") from exc


def save_config(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temp, 0o600)
        except OSError:
            pass
        os.replace(temp, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    finally:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass


def masked(value: str) -> str:
    if not value:
        return "(未配置)"
    if len(value) <= 7:
        return "***"
    return f"{value[:3]}…{value[-4:]}"


def safe_view(path: Path, value: dict[str, Any]) -> dict[str, Any]:
    key = os.environ.get(API_KEY_ENV, "") or str(value.get("api_key", ""))
    return {
        "config_path": str(path),
        "api_key": masked(key),
        "api_key_source": API_KEY_ENV if os.environ.get(API_KEY_ENV) else "config",
        "base_url": value["base_url"],
        "defaults": value["defaults"],
    }


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Configure the TFVision image generation skill.")
    p.add_argument("--config", help="Override the configuration file path.")
    p.add_argument("--api-key", help=argparse.SUPPRESS)
    p.add_argument("--api-key-stdin", action="store_true", help="Read one API key line from standard input.")
    p.add_argument("--api-key-env", metavar="NAME", help="Read the API key from an environment variable.")
    p.add_argument("--clear-api-key", action="store_true", help="Remove the saved API key.")
    p.add_argument("--base-url")
    p.add_argument("--model")
    p.add_argument("--resolution", choices=["512", "1K", "2K", "4K"])
    p.add_argument("--aspect-ratio")
    p.add_argument("--quality", choices=["auto", "high", "medium", "low"])
    p.add_argument("--output-format", choices=["png", "jpeg", "webp"])
    p.add_argument("--poll-interval", type=float)
    p.add_argument("--timeout", type=int)
    p.add_argument("--show", action="store_true", help="Print a masked configuration summary.")
    return p


def main() -> int:
    args = parser().parse_args()
    path = config_path(args.config)
    try:
        value = load_config(path)
    except ValueError as exc:
        print(f"ERROR: {exc}")
        return 2

    changed = False
    key_sources = sum((args.api_key is not None, args.api_key_stdin, args.api_key_env is not None, args.clear_api_key))
    if key_sources > 1:
        print("ERROR: API key 输入方式只能选择一种")
        return 2
    api_key = args.api_key
    if args.api_key_stdin:
        try:
            api_key = getpass.getpass("API key: ") if os.isatty(0) else input().strip()
        except EOFError:
            print("ERROR: 标准输入中没有 API key")
            return 2
    elif args.api_key_env:
        api_key = os.environ.get(args.api_key_env)
        if api_key is None:
            print(f"ERROR: 环境变量 {args.api_key_env} 不存在")
            return 2
    elif args.clear_api_key:
        value["api_key"] = ""
        changed = True
    if api_key is not None:
        api_key = api_key.strip()
        if not api_key:
            print("ERROR: API key 不能为空")
            return 2
        value["api_key"] = api_key
        changed = True

    if args.base_url is not None:
        base_url = args.base_url.strip().rstrip("/")
        if not base_url.startswith(("https://", "http://")):
            print("ERROR: base URL 必须以 http:// 或 https:// 开头")
            return 2
        value["base_url"] = base_url
        changed = True

    updates = {
        "model": args.model,
        "resolution": args.resolution,
        "aspect_ratio": args.aspect_ratio,
        "quality": args.quality,
        "output_format": args.output_format,
        "poll_interval_seconds": args.poll_interval,
        "timeout_seconds": args.timeout,
    }
    for key, item in updates.items():
        if item is not None:
            value["defaults"][key] = item
            changed = True

    try:
        if float(value["defaults"]["poll_interval_seconds"]) < 0.5:
            print("ERROR: poll interval 不能小于 0.5 秒")
            return 2
        if int(value["defaults"]["timeout_seconds"]) < 1:
            print("ERROR: timeout 必须大于 0 秒")
            return 2
    except (KeyError, TypeError, ValueError):
        print("ERROR: poll interval 或 timeout 配置无效")
        return 2

    if changed:
        try:
            save_config(path, value)
        except OSError as exc:
            print(f"ERROR: 无法写入配置文件 {path}: {exc}")
            return 2
        print(f"配置已保存: {path}")
        print(f"API key: {masked(str(value['api_key']))}")
    elif not args.show:
        print("未提供配置变更；使用 --show 查看当前配置。")

    if args.show:
        print(json.dumps(safe_view(path, value), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

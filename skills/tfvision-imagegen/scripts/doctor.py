#!/usr/bin/env python3
"""Cross-platform preflight checks for the TFVision image generation skill."""

import argparse
import os
import platform
import socket
import ssl
import sys
from pathlib import Path
from urllib.parse import urlsplit


MIN_PYTHON = (3, 10)


def report(level, message):
    print("[{0}] {1}".format(level, message))


def writable_parent(path):
    current = path
    while not current.exists() and current != current.parent:
        current = current.parent
    return current.is_dir() and os.access(str(current), os.W_OK)


def parser():
    p = argparse.ArgumentParser(description="Check TFVision image skill prerequisites without generating an image.")
    p.add_argument("--config", help="Override the configuration path.")
    p.add_argument("--output-dir", default="output", help="Planned output directory.")
    p.add_argument("--network", action="store_true", help="Check DNS/TLS connectivity without calling the API.")
    return p


def main():
    args = parser().parse_args()
    failures = 0
    system = platform.system() or "Unknown"
    report("OK", "platform={0} {1}".format(system, platform.machine()))

    if sys.version_info < MIN_PYTHON:
        report("FAIL", "Python 3.10+ is required; current={0}".format(platform.python_version()))
        return 2
    report("OK", "python={0} executable={1}".format(platform.python_version(), sys.executable))

    try:
        from configure import API_KEY_ENV, config_path, load_config
        path = config_path(args.config)
        cfg = load_config(path)
        report("OK", "config={0}".format(path))
    except (ImportError, OSError, ValueError) as exc:
        report("FAIL", "configuration cannot be loaded: {0}".format(exc))
        return 2

    api_key = os.environ.get(API_KEY_ENV, "").strip() or str(cfg.get("api_key", "")).strip()
    if api_key:
        source = API_KEY_ENV if os.environ.get(API_KEY_ENV) else "config"
        report("OK", "API key is configured (source={0})".format(source))
    else:
        report("FAIL", "API key is missing; run configure.py first")
        failures += 1

    base_url = str(cfg.get("base_url", "")).strip().rstrip("/")
    parsed = urlsplit(base_url)
    parsed_port = None
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        report("FAIL", "invalid base_url={0}".format(base_url or "(empty)"))
        failures += 1
    else:
        try:
            parsed_port = parsed.port
        except ValueError as exc:
            report("FAIL", "invalid base_url port: {0}".format(exc))
            failures += 1
            parsed_port = None
        else:
            report("OK", "base_url={0}".format(base_url))

    output_dir = Path(args.output_dir).expanduser().resolve()
    if writable_parent(output_dir):
        report("OK", "output path is writable={0}".format(output_dir))
    else:
        report("FAIL", "output path is not writable={0}".format(output_dir))
        failures += 1

    if args.network and parsed.hostname and parsed.scheme in ("http", "https"):
        port = parsed_port or (443 if parsed.scheme == "https" else 80)
        try:
            with socket.create_connection((parsed.hostname, port), timeout=10) as connection:
                if parsed.scheme == "https":
                    context = ssl.create_default_context()
                    with context.wrap_socket(connection, server_hostname=parsed.hostname):
                        pass
            report("OK", "DNS/TLS connectivity to {0}:{1}".format(parsed.hostname, port))
        except ssl.SSLCertVerificationError as exc:
            report("FAIL", "TLS certificate verification failed: {0}".format(exc))
            if system == "Darwin":
                report("INFO", "For python.org builds, run the bundled Install Certificates.command once.")
            failures += 1
        except (OSError, socket.gaierror) as exc:
            report("FAIL", "network connectivity failed: {0}".format(exc))
            failures += 1

    if failures:
        report("RESULT", "preflight failed ({0} issue(s))".format(failures))
        return 2
    report("RESULT", "ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

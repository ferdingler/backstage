"""Start Box using temporary credentials resolved outside the agent boundary."""

import configparser
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    binary = Path(os.environ.get("BOX_BIN", str(root / "box/.runtime/bin/strands-box")))
    if not binary.is_file():
        print("Box binary missing. Build the pinned revision in README.md or set BOX_BIN.", file=sys.stderr)
        return 2
    if not (root / "box/box.local.toml").is_file():
        print("Run: uv run --project agent python box/configure.py", file=sys.stderr)
        return 2
    # Ada's credential_process remains outside Box. Box deliberately accepts only
    # static session credentials in aws:// profiles, so supply a private snapshot.
    resolved = subprocess.run(
        ["aws", "configure", "export-credentials", "--profile", "bedrock", "--format", "process"],
        text=True, capture_output=True,
    )
    if resolved.returncode:
        print("Could not resolve the bedrock profile. Refresh its Isengard session and retry.", file=sys.stderr)
        return 2
    try:
        credentials = json.loads(resolved.stdout)
        values = {
            "aws_access_key_id": credentials["AccessKeyId"],
            "aws_secret_access_key": credentials["SecretAccessKey"],
            "aws_session_token": credentials["SessionToken"],
        }
    except (KeyError, json.JSONDecodeError):
        print("The bedrock profile did not supply temporary session credentials.", file=sys.stderr)
        return 2
    # Box initializes its own state directory and rejects a nonempty unowned
    # directory. Keep the credential snapshot in separate operator-only storage.
    private = root / "box/.runtime/credential-sessions"
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    private.chmod(0o700)
    with tempfile.TemporaryDirectory(prefix="aws-", dir=private) as directory:
        credentials_file = Path(directory) / "credentials"
        config_file = Path(directory) / "config"
        profile = configparser.ConfigParser()
        profile["bedrock"] = values
        with open(credentials_file, "w", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
            profile.write(output)
        config_file.write_text("[profile bedrock]\nregion = us-west-2\n")
        env = dict(os.environ, EXPERIMENTAL_LINUX_SUPPORT="TRUE",
                   AWS_CONFIG_FILE=str(config_file),
                   AWS_SHARED_CREDENTIALS_FILE=str(credentials_file))
        print("Starting Box with a temporary bedrock session; credentials remain outside the agent.", flush=True)
        process = subprocess.Popen(
            [str(binary), "run", "--config", str(root / "box/box.local.toml"), "--", *sys.argv[1:]],
            cwd=root, env=env, process_group=0,
        )
        stopping_at = None

        def forward(signum, _frame):
            nonlocal stopping_at
            stopping_at = stopping_at or time.monotonic()
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signum)
                except ProcessLookupError:
                    pass

        previous = {sig: signal.signal(sig, forward)
                    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
        try:
            while True:
                try:
                    return process.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    if stopping_at and time.monotonic() - stopping_at > 10:
                        os.killpg(process.pid, signal.SIGKILL)
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


if __name__ == "__main__":
    sys.exit(main())

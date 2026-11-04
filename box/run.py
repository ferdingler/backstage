"""Start Box using temporary credentials resolved outside the agent boundary."""

import configparser
import json
import os
import platform
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def configure(root: Path) -> None:
    """Write box.local.toml and policy.local.dw from the templates for this machine.

    Box needs absolute paths, and on Linux an exec grant for every native
    library Python loads. Both change per machine and per `uv sync`, so the
    files are regenerated on every start. No credentials are written.
    """
    if platform.system() != "Linux" or platform.machine() not in ("aarch64", "arm64"):
        raise SystemExit("This configuration targets Linux ARM64. Qualify another platform separately.")
    venv = root / "agent/.venv"
    python = venv / "bin/python"
    if not python.exists():
        raise SystemExit("Install the agent first: cd agent && uv sync --frozen")
    runtime = Path(subprocess.check_output(
        [str(python), "-c", "import sys; print(sys.base_prefix)"], text=True
    ).strip()).resolve()
    interpreter = python.resolve()
    if python.is_symlink():
        python.unlink()
        python.symlink_to(interpreter)
    # uv's "3.14" interpreter alias can point outside the restricted mount view.
    # Keep the existing environment, but name its actual granted interpreter home.
    config = venv / "pyvenv.cfg"
    lines = config.read_text().splitlines()
    config.write_text("\n".join(
        f"home = {runtime / 'bin'}" if line.startswith("home = ") else line
        for line in lines
    ) + "\n")
    scratch = root / "agent/scratch"
    tmp = root / "agent/tmp"
    state = root / "box/state"
    for directory in (scratch, tmp, state):
        directory.mkdir(parents=True, exist_ok=True)
    state.chmod(0o700)
    home = Path.home().resolve()

    def policy_path(path: Path) -> str:
        try:
            return "~/" + path.relative_to(home).as_posix()
        except ValueError:
            return str(path)

    replacements = {
        "BOX_STATE": state,
        "VENV_PYTHON": python,
        "VENV": venv,
        "PYTHON_RUNTIME": runtime,
        "PYTHON_EXEC": python.resolve(),
        "AGENT_SOURCE": root / "agent/src",
        "SCRATCH": scratch,
        "TMP": tmp,
        "POLICY_SCRATCH": policy_path(scratch),
    }
    for template, output in (("box.toml", "box.local.toml"), ("policy.dw", "policy.local.dw")):
        content = (root / "box" / template).read_text()
        # Linux read mounts are non-executable. Native Python extensions need
        # executable mappings; grant the installed libraries as exact files.
        native = sorted({
            p.resolve() for p in venv.rglob("*.so")
            if os.access(p, os.X_OK)
        })
        content = content.replace("@NATIVE_EXEC@", ", ".join(json.dumps(str(p)) for p in native))
        for key, value in replacements.items():
            # Both TOML and Dogwood strings accept JSON-style escaping.
            content = content.replace("@" + key + "@", json.dumps(str(value))[1:-1])
        if "@" in content:
            # Dogwood annotations are expected. Only reject unresolved template markers.
            if re.search(r"@[A-Z_]+@", content):
                raise SystemExit(f"Unresolved template marker in {template}")
        (root / "box" / output).write_text(content)


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    binary = Path(os.environ.get("BOX_BIN", str(root / "box/.runtime/bin/strands-box")))
    if not binary.is_file():
        print("Box binary missing. Build the pinned revision in README.md or set BOX_BIN.", file=sys.stderr)
        return 2
    configure(root)
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

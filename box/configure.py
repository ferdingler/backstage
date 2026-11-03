"""Materialize the portable Box templates for this Linux ARM64 workstation."""

import json
import os
import platform
import subprocess
import sys
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parent.parent
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
            import re
            if re.search(r"@[A-Z_]+@", content):
                raise SystemExit(f"Unresolved template marker in {template}")
        (root / "box" / output).write_text(content)
    print("Wrote box/box.local.toml and box/policy.local.dw; no credentials copied.")
    print("Start with: uv run --project agent python box/run.py")


if __name__ == "__main__":
    main()

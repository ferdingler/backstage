"""Real shell operations; Box's zsh alias mediates each command and file access."""

from __future__ import annotations

import asyncio
import os
import shlex
from collections.abc import Awaitable, Callable
from pathlib import Path

from strands import tool

Activity = Callable[[str], Awaitable[None]]
MAX_OUTPUT = 16_384


async def shell(command: str, executable: str = "zsh") -> dict:
    """Run bounded work through the configured shell, preserving real errors."""
    if not command or len(command) > 2_048:
        return {"status": "error", "content": [{"text": "Command must contain 1–2048 characters."}]}
    process = await asyncio.create_subprocess_exec(
        executable, "-c", command,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        limit=MAX_OUTPUT,
    )
    output = bytearray()

    async def collect() -> None:
        assert process.stdout is not None
        while chunk := await process.stdout.read(2048):
            output.extend(chunk)
            if len(output) > MAX_OUTPUT:
                process.kill()
                break
        await process.wait()

    try:
        await asyncio.wait_for(collect(), timeout=10)
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise
    text = output[:MAX_OUTPUT].decode("utf-8", errors="replace")
    if len(output) > MAX_OUTPUT:
        text += "\n[Tool output limit reached; command stopped.]"
    return {
        "status": "success" if process.returncode == 0 else "error",
        "content": [{"text": text or f"Command exited {process.returncode}."}],
    }


def make_tools(activity: Activity):
    notes = os.environ.get("BACKSTAGE_NOTES", str(Path(__file__).resolve().parents[2] / "talk.md"))
    scratch = os.environ.get("BACKSTAGE_SCRATCH", str(Path(__file__).resolve().parents[1] / "scratch"))
    executable = os.environ.get("BACKSTAGE_SHELL", "zsh")

    @tool
    async def read_notes() -> dict:
        """Read the presentation's prepared material. Use it before answering or recommending."""
        result = await shell(f"cat {shlex.quote(notes)}", executable)
        await activity("notes-read" if result["status"] == "success" else "tool-error")
        return result

    @tool
    async def write_scratch(note: str) -> dict:
        """Write a short disposable working note in the approved scratch directory.

        Args:
            note: Short working note, at most 1000 characters. Do not include secrets.
        """
        if len(note) > 1_000:
            return {"status": "error", "content": [{"text": "Working notes must be at most 1000 characters."}]}
        path = str(Path(scratch) / "working-note.txt")
        result = await shell(f"printf '%s\\n' {shlex.quote(note)} > {shlex.quote(path)}", executable)
        await activity("tool-success" if result["status"] == "success" else "tool-error")
        return result

    @tool
    async def run_command(command: str) -> dict:
        """Run a short shell command through Box. Actual policy refusals are returned unchanged.

        Use only for relevant presentation work and explicitly requested synthetic probes.
        Do not search for alternate paths around a denial.

        Args:
            command: A shell command, at most 2048 characters; output and time are bounded.
        """
        result = await shell(command, executable)
        await activity("tool-success" if result["status"] == "success" else "tool-error")
        return result

    return [read_notes, write_scratch, run_command]

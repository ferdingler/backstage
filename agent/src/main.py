"""Run with: uv run --project agent python agent/src/main.py (inside Box)."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import importlib.metadata
import logging
import os
import signal
import sys
from typing import Any
from urllib.parse import urlsplit

import httpx

from agent import BackstageAgent
from client import Client, ServiceError
from tools import shell


async def report_probe_activity(success: bool) -> None:
    """Report an application observation, never an inferred Box decision."""
    client = None
    try:
        async with asyncio.timeout(3):
            client = Client(os.environ.get("BACKSTAGE_API_URL", "http://127.0.0.1:3003"))
            state = await client.state()
            await client.post(
                "activity", generation=state["generation"],
                kind="tool-success" if success else "tool-error",
            )
    except (TimeoutError, httpx.HTTPError, ServiceError, ValueError, KeyError, OSError):
        print("Application activity unavailable; probe result above is unchanged.", file=sys.stderr)
    finally:
        if client is not None:
            await client.close()


class Worker:
    def __init__(self, client: Client, *, deadline: float = 60, agent: BackstageAgent | None = None):
        self.client = client
        self.deadline = deadline
        self.stopping = asyncio.Event()
        self.work: dict[str, Any] | None = None
        self.agent = BackstageAgent(self.activity) if agent is None else agent
        self._run_cancelled: asyncio.Event | None = None
        self.generation: str | None = None
        self.last_status: str | None = None

    def status(self, value: str) -> None:
        if self.last_status != value:
            print(f"Backstage: {value}", flush=True)
            self.last_status = value

    def stop(self) -> None:
        self.stopping.set()
        if self._run_cancelled is not None:
            self._run_cancelled.set()

    async def activity(self, kind: str) -> None:
        if self.work:
            # Activity is best effort: a stalled report must not hold up a
            # completed shell operation for the client's full HTTP timeout.
            with contextlib.suppress(TimeoutError, httpx.HTTPError, ServiceError):
                async with asyncio.timeout(0.25):
                    await self.client.post(
                        "activity", generation=self.work["generation"], workId=self.work["id"], kind=kind,
                    )

    async def heartbeat(self, status: str) -> dict[str, Any]:
        self.status(status)
        return await self.client.post("heartbeat", generation=self.generation, status=status)

    async def pause(self, seconds: float) -> None:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self.stopping.wait(), seconds)

    async def process(self, work: dict[str, Any]) -> bool:
        self.work = work
        self.status("processing")
        cancelled = self._run_cancelled = asyncio.Event()
        if self.stopping.is_set():
            cancelled.set()
        task = asyncio.create_task(self.agent.run(work, deadline=self.deadline, cancelled=cancelled))
        reason = "error"
        published = False
        try:
            while not task.done():
                await asyncio.wait({task}, timeout=2)
                if self.stopping.is_set():
                    reason = "cancelled"
                    raise InterruptedError("Worker shutting down")
                if task.done():
                    break
                current = await self.heartbeat("processing")
                if current.get("agentPaused") or current.get("pauseEpoch") != work["pauseEpoch"] or current.get("generation") != work["generation"]:
                    reason = "cancelled"
                    raise InterruptedError("Run invalidated by host control")
            outcome = await asyncio.shield(task)
            if outcome.reason is not None:
                reason = outcome.reason
                self.status("paused" if reason == "cancelled" else "retrying")
                detail = f"; {outcome.error_type}" if outcome.error_type else ""
                print(f"Backstage: run ended ({reason}{detail})", flush=True)
                return False
            assert outcome.output is not None
            payload = {
                "generation": work["generation"], "workId": work["id"], "resultId": work["id"],
                "callsUsed": outcome.calls, **outcome.output,
            }
            # Lost HTTP responses are retried with the same durable result ID.
            # Never ask the model to recreate an already completed reply.
            for attempt in range(3):
                try:
                    await self.client.post("result", **payload)
                    published = True
                    break
                except httpx.HTTPError:
                    if attempt == 2:
                        raise
                    await self.pause(2 ** attempt)
            with contextlib.suppress(httpx.HTTPError, ServiceError):
                await self.client.post("ack", generation=work["generation"], workId=work["id"])
            return True
        except asyncio.CancelledError:
            reason = "cancelled"
            raise
        except (TimeoutError, InterruptedError, ServiceError, httpx.HTTPError, ValueError) as error:
            # Report only a category. Provider exceptions can embed request text,
            # credential IDs or payloads; those never belong in the terminal/UI.
            if isinstance(error, TimeoutError):
                reason = "timeout"
            self.status("retrying" if reason != "cancelled" else "paused")
            print(f"Backstage: run ended ({reason}; {type(error).__name__})", flush=True)
            return False
        except Exception as error:
            self.status("retrying")
            print(f"Backstage: model/tool failure ({type(error).__name__})", flush=True)
            return False
        finally:
            cancelled.set()
            # The invocation owns cancellation and teardown. Its terminal
            # outcome includes calls attempted even when this worker is cancelled.
            outcome = await task
            # Published work ignores duplicate fail bookkeeping. Unfinished work
            # releases only its measured unused calls; a process crash leaves the
            # durable reservation charged conservatively when the lease expires.
            if not published:
                with contextlib.suppress(httpx.HTTPError, ServiceError):
                    await self.client.post(
                        "fail", generation=work["generation"], workId=work["id"],
                        callsUsed=outcome.calls, reason=reason,
                    )
            with contextlib.suppress(httpx.HTTPError, ServiceError):
                await self.heartbeat("idle" if published else "paused" if reason == "cancelled" else "retrying")
            self.work = None
            self._run_cancelled = None

    async def run(self, *, once: bool = False) -> int:
        backoff = 2.0
        while not self.stopping.is_set():
            try:
                state = await self.client.state()
                self.generation = state["generation"]
                if state["agentPaused"]:
                    await self.heartbeat("paused")
                    if once:
                        return 0
                    await self.pause(2)
                    continue
                claim = await self.client.post("claim", generation=self.generation)
                work = claim.get("work")
                if work:
                    succeeded = await self.process(work)
                    if once:
                        return 0 if succeeded else 1
                    await self.pause(0.2 if succeeded else backoff)
                    backoff = 2 if succeeded else min(30, backoff * 2)
                else:
                    reason = claim.get("reason", "idle")
                    await self.heartbeat("over-budget" if reason in {"over-budget", "budget"} else "paused" if reason == "paused" else "processing" if reason == "busy" else "idle")
                    if once:
                        return 0
                    backoff = 2
                    await self.pause(3)
            except (httpx.HTTPError, ServiceError):
                self.status("disconnected")
                if once:
                    return 1
                await self.pause(backoff)
                backoff = min(30, backoff * 2)
        if self.generation:
            with contextlib.suppress(httpx.HTTPError, ServiceError):
                await self.heartbeat("disconnected")
        return 0


async def main() -> int:
    parser = argparse.ArgumentParser(description="Backstage: one bounded local Strands worker. Run inside Box.")
    parser.add_argument("--check", action="store_true", help="check SDK/model construction without invoking the provider")
    parser.add_argument("--once", action="store_true", help="claim at most one batch, then exit")
    parser.add_argument("--probe-command", metavar="COMMAND", help="operator-only synthetic boundary probe through the real Box shell")
    parser.add_argument("--probe-http", nargs=2, metavar=("METHOD", "URL"), help="operator-only request through the Box gateway; prints status and bounded body, never headers")
    args = parser.parse_args()
    # Suppress SDK output that may contain model text, tool arguments, or provider
    # request details. Application statuses and typed activity are emitted above.
    logging.getLogger("strands").setLevel(logging.CRITICAL)
    logging.getLogger("botocore").setLevel(logging.CRITICAL)
    if args.probe_http:
        method, url = args.probe_http
        parsed = urlsplit(url)
        method = method.upper()
        if method not in {"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"}:
            print("HTTP probe: unsupported method.", file=sys.stderr)
            return 2
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            print("HTTP probe: use an HTTP(S) URL without credentials.", file=sys.stderr)
            return 2
        probe = Client(f"{parsed.scheme}://{parsed.netloc}")
        success = False
        try:
            async with probe.http.stream(method, url) as response:
                print(f"HTTP {response.status_code}")
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk[:2048 - len(body)])
                    if len(body) >= 2048:
                        break
                if body:
                    print(body.decode("utf-8", errors="replace"))
                success = response.is_success
                return 0 if success else 1
        except httpx.HTTPError as error:
            print(f"HTTP probe failed ({type(error).__name__}).", file=sys.stderr)
            return 1
        finally:
            await probe.close()
            await report_probe_activity(success)
    if args.probe_command:
        try:
            result = await shell(args.probe_command, os.environ.get("BACKSTAGE_SHELL", "zsh"))
        except (TimeoutError, OSError) as error:
            print(f"Shell probe failed ({type(error).__name__}).", file=sys.stderr)
            await report_probe_activity(False)
            return 1
        for item in result["content"]:
            print(item["text"], end="" if item["text"].endswith("\n") else "\n")
        success = result["status"] == "success"
        await report_probe_activity(success)
        return 0 if success else 1
    client = Client(os.environ.get("BACKSTAGE_API_URL", "http://127.0.0.1:3003"))
    try:
        deadline = float(os.environ.get("BACKSTAGE_RUN_SECONDS", "60"))
        if not 0 < deadline <= 60:
            raise ValueError("BACKSTAGE_RUN_SECONDS must be greater than 0 and at most 60.")
        worker = Worker(client, deadline=deadline)
        print(f"Backstage: Strands {importlib.metadata.version('strands-agents')}; provider {os.environ.get('MODEL_PROVIDER', 'bedrock')}; six calls/run, 512 tokens/call", flush=True)
        if args.check:
            print("Backstage: configuration and SDK construction passed; provider not invoked.")
            return 0
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, worker.stop)
        return await worker.run(once=args.once)
    except ValueError as error:
        print(f"Backstage configuration: {error}", file=sys.stderr)
        return 2
    finally:
        await client.close()


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)

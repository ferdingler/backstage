"""Print only actual Box policy decisions, never request bodies or credentials."""

import argparse
import json
import time
from pathlib import Path


def decisions(line: str):
    try:
        record = json.loads(line)
    except json.JSONDecodeError:
        return
    for resource in record.get("resourceLogs", []):
        for scope in resource.get("scopeLogs", []):
            if scope.get("scope", {}).get("name") != "strands-box.policy":
                continue
            for entry in scope.get("logRecords", []):
                fields = {}
                for attribute in entry.get("attributes", []):
                    key = attribute.get("key", "")
                    if key.startswith("strands.box.policy."):
                        fields[key.removeprefix("strands.box.policy.")] = attribute.get("value", {}).get("stringValue", "")
                if fields.get("verdict"):
                    # Paths can contain newlines or terminal escapes. Keep every
                    # field on one inert display line, without changing the log.
                    yield "\t".join(
                        json.dumps(fields.get(key, ""), ensure_ascii=True)[1:-1]
                        for key in ("verdict", "action", "resource", "rule")
                    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--follow", action="store_true")
    parser.add_argument("--path", type=Path, default=Path(__file__).resolve().parent / "state/private/telemetry/records.jsonl")
    args = parser.parse_args()
    print("BOX DECISION RECORDS · verdict / action / resource / rule", flush=True)
    offset = 0
    last_notice = ""
    while True:
        if not args.path.exists():
            notice = "Log source unavailable. No enforcement claim can be made from missing records."
        else:
            notice = ""
            if args.path.stat().st_size < offset:
                offset = 0
            with args.path.open() as source:
                source.seek(offset)
                while True:
                    line = source.readline()
                    if not line or not line.endswith("\n"):
                        break
                    for decision in decisions(line):
                        print(decision, flush=True)
                    offset = source.tell()
            if args.follow and time.time() - args.path.stat().st_mtime > 30:
                notice = "No new Box records for 30 seconds. Check that the Box process is running."
        if notice and notice != last_notice:
            print(notice, flush=True)
        last_notice = notice
        if not args.follow:
            break
        time.sleep(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass

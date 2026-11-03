# Backstage

Backstage is a local Q&A prototype for a fifteen-minute talk. The audience submits anonymous questions and votes on them. An AI agent, contained by [Box](https://github.com/strands-agents/box), reads the session's talking points, replies to questions, and recommends an order to answer them in. The presenter decides what to broadcast and answer.

Agent replies and recommendations are always labeled as the agent's. An agent reply never marks a question answered. That is the speaker's job.

It runs on one machine: one Next.js web process with a SQLite database, plus one Python agent worker. Nothing is deployed.

## Roles

| Role | Where | What they do |
| --- | --- | --- |
| **Operator** (presenter) | Host page, `http://127.0.0.1:3001/host` | Creates sessions and talking points, goes live, pauses intake or the agent, selects questions for broadcast, marks them answered or hidden, requests a closing recommendation, resets a session. |
| **Audience** | Audience page, `http://127.0.0.1:3000` | Submits questions and votes, one identity per browser cookie. Sees a waiting screen until a session is live. The broadcast view, `http://127.0.0.1:3000/broadcast`, shows only the question the operator selected. |
| **Agent** | `box/run.py`, talking to `http://127.0.0.1:3003` | Claims batches of questions, replies (`answered` or `leave-for-speaker`), and recommends a grouped question order. It can't touch host controls or votes. |

Each role gets its own loopback listener, and each listener serves only that role's routes (see `web/routes.json`).

## Run it

Prerequisites: Linux ARM64 with unprivileged user namespaces, Node.js 22.13+, npm, uv, git, Rust/Cargo, AWS CLI v2, and an AWS profile named `bedrock` with Bedrock model access in `us-west-2`.

**One-time setup**, from the repository root:

```sh
(cd web && npm ci && npm run build)
(cd agent && uv sync --frozen)
uv run --project agent python box/configure.py

# Build the pinned Box binaries
mkdir -p box/.runtime/bin
git clone https://github.com/strands-agents/box.git box/.runtime/source
git -C box/.runtime/source checkout 5ba7010488dc28c64b7f18dd4c5328cc8b02dafa
cargo build --release --locked --manifest-path box/.runtime/source/Cargo.toml \
  -p strands-box -p strands-box-containment
cp box/.runtime/source/target/release/{strands-box,strands-box-contain-trampoline,strands-box-sock-alias} \
  box/.runtime/bin/
```

Rerun `box/configure.py` whenever you rebuild the Python environment.

**Credentials.** Refresh the `bedrock` profile outside Box. With Isengard:

```sh
ada credentials update --account ACCOUNT_ID --provider isengard --role Admin --profile bedrock --once
```

**Start**, each in its own terminal, from the repository root:

```sh
# 1. Web app: audience :3000, host :3001, agent API :3003
cd web && npm start            # or: npm run dev

# 2. Agent. Without --session it follows whichever session is live.
#    The host page shows the exact command for the selected session.
uv run --project agent python box/run.py --session SESSION_ID

# 3. Optional: Box's permit/deny decisions
python3 box/decisions.py --follow
```

Check that the web app is up with `curl -f http://127.0.0.1:3000/api/health`. To stop, press Ctrl-C in each terminal.

## Operate a talk

1. Open the host page. Create a session with **New session**, or pick one from the switcher. Paste the talk notes into **Talking points** and save.
2. Press **Go live**. Only one session can be live at a time, so going live pauses any other.
3. Invite questions. Turn off **Accept questions** to pause intake. Voting keeps working.
4. Turn off **Agent** to stop new agent work. Host controls keep working whether the agent is stopped, busy, or out of budget.
5. Near the end, open **Recommended** and press **Recommend order**.
6. Select a question to broadcast, answer it out loud, then mark it answered. **Hide** keeps a question off the broadcast view.
7. To start over, use **Reset session…** and type `RESET`. This clears questions, votes, replies, and recommendations, and keeps the title and talking points.

[talk.md](talk.md) has the presentation material.

## APIs

All bodies are JSON. Requests that send unexpected fields are rejected. Errors look like `{ "error": { "code", "message" } }`. A rate-limited request gets HTTP 429 with `Retry-After`. Timestamps are Unix milliseconds.

**Audience** (ports 3000 and 3001):

| Method and path | Request → result |
| --- | --- |
| `GET /api/health` | Readiness check |
| `GET /api/state` | Live session, questions, this browser's votes, agent status |
| `POST /api/questions` | `{text}` → `{questionId, generation}` |
| `PUT /api/votes` | `{questionId, voted}` → vote total; idempotent |
| `GET /api/broadcast` | The selected, non-hidden question |

**Operator** (port 3001):

| Method and path | Request → result |
| --- | --- |
| `GET /api/host/state?session=ID` | Board, recommendations, budget, agent heartbeat, activity |
| `POST /api/host/control` | `{action, generation, ...}`. The actions are below. |

| `action` | Extra fields |
| --- | --- |
| `create-session` | `title`, optional `talkingPoints` (no `generation`) |
| `update-session` | optional `title`, `talkingPoints` |
| `live` | `value` (Boolean) |
| `intake`, `agent` | `value` (Boolean, `true` pauses) |
| `select` | `questionId` or `null` |
| `answered`, `hide` | `questionId`, `value` (Boolean) |
| `closing` | none. Requests a final recommendation. |
| `reset` | `confirmation: "RESET"` |

**Agent** (port 3003):

| Method and path | Request → result |
| --- | --- |
| `GET /api/agent/state?session=ID` | Session, generation, pause state, board, budget |
| `POST /api/agent/claim` | `{generation}` → a work lease, or null |
| `POST /api/agent/heartbeat` | `{generation, status}` |
| `POST /api/agent/result` | `{generation, workId, resultId, callsUsed, replies? \| recommendation?}` |
| `POST /api/agent/ack` | `{generation, workId}` |
| `POST /api/agent/fail` | `{generation, workId, callsUsed, reason}` |
| `POST /api/agent/activity` | `{generation, workId?, questionId?, kind}` |

A reply is `{questionId, text, disposition}`, where `disposition` is `answered` or `leave-for-speaker`. A recommendation is `{revision, groups: [{title, questionIds}], queue: [{questionId, reason}]}`.

## Configuration

- **Web:** `web/.env.example` lists the startup variables: ports, origins, database path, rate limits, and model-call budget. Export them before `npm start`.
- **Agent:** edit `[agent].env` in `box/box.toml` (for example `MODEL_ID`, `AWS_REGION`, `BACKSTAGE_SESSION`), then rerun `box/configure.py`. Box doesn't inherit these settings from your shell.
- **Back up** by stopping both processes and copying `web/data/`.

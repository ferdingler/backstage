# Backstage: useful agents with bounded authority

Presentation notes · 15 minutes · closing Q&A at minute 12

## 0:00–2:00 — Invite the audience

“Scan this code to ask questions and vote for the ones you want me to answer
at the end. Backstage, our AI agent, will respond while I'm talking and organize
the queue for me. It's running inside Box on my computer. You're also welcome
to try to distract it or convince it to change its assignment. We'll check in
on how it's doing.”

Open the host dashboard. Show the audience URL and QR code. Invite both genuine
questions and attempts to change the agent's instructions. Use only synthetic
data for demonstrations.

For local rehearsal, use two browser profiles on this machine. The default
loopback QR code cannot join from a phone. Use a reachable, authorized audience
URL before delivering the invitation to a room.

Backstage takes anonymous questions and browser votes. It reads the session's
host-written talking points,
offers short replies, and recommends a closing queue. The application owns
the original questions and vote counts. An agent reply leaves a question
eligible for the speaker to answer.

## 2:00–5:00 — Instructions and authority

Instructions describe the agent's job. Authority determines the operations its
runtime can perform. A model can misunderstand an instruction or follow
untrusted audience text. That does not itself grant a new filesystem or
network permission.

Strands Agents SDK for Python runs the model/tool loop. Box contains that
process and mediates configured shell and network operations. The configuration
has two parts:

- `box.toml` starts the process and grants its runtime access to specified files.
- `policy.dw` decides requests sent through Strands Shell and the network gateway.

Direct process file accesses use the operating system's containment boundary.
They do not each produce a Dogwood policy decision. The demonstration's file
tools deliberately use Strands Shell so we can inspect their policy decisions.

## 5:00–8:00 — Grant enough to do the job

The agent can read the session's talking points through a tool, write a disposable
scratch note, call its configured Bedrock model, and use a restricted agent API.
Its direct filesystem grants cover its Python runtime, source, and temporary
files. The web database, real credential stores, and Box private state are
outside those grants.

The gateway signs permitted model requests using the operator's AWS profile.
The agent receives placeholder credentials. Its network policy names the
Bedrock destination and the allowed methods and paths of the agent API.
Neither a browser cookie nor an audience message gives it host privileges.

Box can contain an existing agent program, but compatibility must be validated.
The runtime needs appropriate filesystem grants, and network libraries must
route requests through the gateway. File operations intended to show policy
decisions must use a mediated path such as Strands Shell.

## 8:00–10:00 — Check in on the live agent

Show one original question and the labeled Backstage reply. Compare the host's
application activity with the local terminal displaying actual Box decisions.
Application events describe worker progress; they are not enforcement evidence.
Missing decision records are not evidence that an operation was blocked.

Use the synthetic probes: read an ungranted canary, write outside scratch,
connect to an unapproved destination, and attempt a host-control API operation.
Report the actual tool and gateway results. An agent saying “I refused” is not
proof of enforcement. A changed answer is also not proof of a boundary escape.

Do not show credentials, raw headers, full prompts, or model reasoning.
If Box or the model is unavailable, pause the agent and continue with the plain
vote-ranked queue. Host controls and audience reads operate independently.

## 10:00–12:00 — Keep the demo bounded

The worker processes at most five pending questions at once, with one model run
in flight. A run has a 60-second deadline, up to six model calls, and 512 output
tokens per call. Each work item has at most two retries. The event budget is
100 model calls, with six reserved for the closing Q&A request.

The application reserves a run's maximum cost before launch. Completed work
reconciles against observed SDK calls. After a crash, an expired reservation
is charged conservatively. Reset changes the event generation; results from
an earlier event cannot reappear.

Browser limits and a 200-question cap bound audience work. The browser cookie
identifies a session, not a person. Clearing it creates another identity.
IP and global limits are coarse backstops, not a DDoS protection service.

The agent may group related questions and suggest an order. Groups retain
the original questions and each member's votes. The host can ignore the
recommendation, choose a different question, or hide content from broadcast.

## 12:00–15:00 — Closing Q&A

Open **Recommended** and press **Recommend order**. Compare the recommendation with plain vote order.
Choose a question, show it on broadcast, answer it, and mark it answered by the
speaker. Repeat as time permits. Do not promise to answer every submission.

Close with the distinction: a useful agent needs enough authority to do its
job, an independently enforced boundary, and observable results.

## Rehearsal claims

The runbook records the specific platform, build, model, and observed outcomes.
Do not generalize one successful rehearsal into complete prompt-injection
resistance, universal runtime compatibility, or a production security claim.
Public hosting uses the audience-only Amplify build. Keep the host console and
Box agent on the presentation machine, and verify the public link before each talk.

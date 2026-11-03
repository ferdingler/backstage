# Working on Backstage

Backstage is a throwaway prototype for a 15-minute presentation. Read `README.md` for the pitch and [tracking issue #13](https://github.com/ferdingler/backstage/issues/13) for the implementation order. Follow the assigned issue's acceptance criteria. Optimize for a working, understandable demo that one presenter can start, operate, and reset.

## Scope and layout

Use this target layout. Create files as their issues are implemented:

```text
backstage/
├── web/                       # Next.js project root
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── app/                   # Next.js routing directory
│   │   ├── layout.tsx
│   │   ├── page.tsx           # Audience page
│   │   ├── host/              # Host dashboard
│   │   └── api/               # Route Handlers
│   ├── routes.json            # Which listener serves each path
│   ├── api.ts                 # Route handler wrapper: access, limits, errors
│   ├── session.ts             # Session operations and read models
│   ├── work.ts                # Agent work leases and model budget
│   ├── validate.ts
│   ├── db.ts                  # DynamoDB table access and transactions
│   └── scripts/create-table.mjs
├── agent/                     # Python project root
│   ├── pyproject.toml
│   ├── uv.lock
│   └── src/
│       ├── main.py
│       ├── agent.py
│       ├── tools.py
│       ├── client.py
│       └── prompt.md
├── box/
│   ├── box.toml
│   └── policy.dw
├── talk.md                    # Presentation material
├── README.md                  # Pitch and setup instructions
├── AGENTS.md
└── .gitignore
```

- Use Next.js and TypeScript for the web app, with Route Handlers for the API. Additional web configuration, assets, and helper files belong directly under `web/` or in framework-required directories.
- Use the Strands Agents SDK for Python. Keep `agent/src/` flat and call it the agent in code and filenames. Do not add intermediate project wrappers or a `src/backstage/agent/` hierarchy.
- Keep dependency manifests, lockfiles, generated files, and runtime data under their owning component. Keep secrets and runtime data out of git.
- Strands Decider is deferred. Do not introduce it, another agent framework, or a second web backend.
- Prefer direct implementations and a few focused files. Avoid workspace frameworks, generic abstraction layers, distributed queues, and infrastructure intended for a production service.

## Validation

**Do not add permanent tests.** This includes `tests/`, test files, test frameworks, test fixtures, and automated test workflows. The owner explicitly chose a throwaway demo without a maintained test suite.

Use builds, type checking, and manual browser, HTTP, and agent smoke checks appropriate to the change. Temporary validation scripts belong outside the repository. Record the commands, observed results, and remaining limitations in the issue handoff. Never claim a live integration worked when it was only stubbed or inspected.

## Product behavior

- Audience participation is anonymous: no accounts, login, or CAPTCHA. Use a server-issued browser cookie for voting and basic rate limiting. This identifies a browser session, not a person or a trusted caller.
- Keep original questions and authoritative vote totals in the web app. The agent can answer, propose groups, and recommend an order; it cannot invent votes or perform host operations.
- Label agent replies and recommendations. An agent reply leaves the question eligible for the speaker to answer.
- Raw submissions, including prompt-injection attempts, reach the agent as untrusted content. Render audience and model text safely as text. Hosts control what goes onto the broadcast.
- Use short polling, one agent worker, and a persistent single-server web deployment for the first version. Store event state in one DynamoDB table that only the web app reaches; the agent gets no database credentials and goes through the agent API.
- Keep host controls and agent-write APIs off public ingress. Use private access through an existing transport such as SSH, with no application login flow. A browser cookie or hidden URL grants no host or agent privileges.
- Apply public API rate limits and bounded agent processing. Pausing the agent must leave the website and host controls usable.

## Box and implementation handoff

- Run the Python agent inside Box on the presentation machine. Grant only its runtime, presentation material, disposable workspace, required API operations, and model connection.
- Use Box-supported credential injection; real credentials stay outside the agent's readable files, environment, prompts, and displayed output. Keep Box state outside the agent workspace.
- File operations intended to demonstrate policy decisions must take a real Box-mediated path. Show actual denials and distinguish application activity from Box decision records.
- Implement issues in dependency order. Resolve routine choices within this scope and document them; ask only for missing external access or a decision that changes the agreed demo.
- Finish an issue when its acceptance criteria work and its manual checks have been recorded. State environment blockers explicitly instead of marking unverified work complete.

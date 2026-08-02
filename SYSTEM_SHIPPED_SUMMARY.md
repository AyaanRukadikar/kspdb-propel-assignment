# 🎓 System Shipped Summary & Interview Defense Guide
### KSPDB Power Grid Fault Detection & Localization System

> **Prepared for assignment review and oral evaluation.**
> This document summarizes **everything shipped**, **how every component works**, and **answers to likely interview questions**.

---

## 📁 1. Everything Shipped — Repository Manifest

| File Path | Description / Purpose | Key Tech |
| :--- | :--- | :--- |
| [`README.md`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/README.md) | Primary entry point, 1-command docker start, links to live URL, video demo, doc map. | Markdown |
| [`ARCHITECTURE.md`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/ARCHITECTURE.md) | Technical architecture, data flow diagram, localization algorithm, noise handling, API spec, UI reasoning, AI justification. | Mermaid, Markdown |
| [`DEPLOYMENT.md`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/DEPLOYMENT.md) | Prerequisites, step-by-step launch, env vars, health check, extensive troubleshooting guide. | Markdown |
| [`DECISIONS.md`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/DECISIONS.md) | Architectural Decision Records (ADRs), trade-offs, documented assumptions, 2-week roadmap, limitations. | Markdown |
| [`AI-WORKFLOW.md`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/AI-WORKFLOW.md) | Breakdown of AI leverage, code generation percentages, cases where AI was wrong/corrected, key prompts. | Markdown |
| [`package.json`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/package.json) | Node.js project manifest, dependencies (`express`, `better-sqlite3`, `ws`, `cors`), scripts. | JSON |
| [`Dockerfile`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/Dockerfile) | Multi-stage Docker build with Alpine Linux, native C++ build tools for SQLite compilation, auto-seed. | Docker |
| [`docker-compose.yml`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/docker-compose.yml) | Single-command stack orchestration, container health check, volume mapping for SQLite DB. | YAML |
| [`.env.example`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/.env.example) | Environment variable template (`PORT`, `NODE_ENV`, `OPENAI_API_KEY`). | Env |
| [`server/index.js`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/server/index.js) | Server entry point: Express app, HTTP server, WebSocket server (`/ws`), static asset serving, route mounting. | Node.js |
| [`server/db/schema.sql`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/server/db/schema.sql) | SQLite schema for substations, feeders, transformers, poles, pole state, tickets, ticket poles, scheduled outages, simulation state. | SQL |
| [`server/db/seed.js`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/server/db/seed.js) | Synthetic dataset generator: 4 substations, 31 feeders, ~100 DTs, ~5000 poles, 40% known topology, 91% device coverage, firmware split. | Node.js |
| [`server/db/connection.js`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/server/db/connection.js) | Database singleton connection manager with WAL mode setup and auto-seeding. | Node.js |
| [`server/core/topology-inference.js`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/server/core/topology-inference.js) | Core graph engine: tree builder for known topology, Nearest-Neighbor Chain algorithm for 60% missing topology. | Node.js |
| [`server/core/fault-detector.js`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/server/core/fault-detector.js) | Core localization engine: live/dark boundary detection via tree traversal, dead sensor detection, debouncing, auto-verification. | Node.js |
| [`server/core/ticket-manager.js`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/server/core/ticket-manager.js) | Ticket lifecycle manager: creation, status transitions, manual resolution rejection when telemetry is dark. | Node.js |
| [`server/core/ai-summary.js`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/server/core/ai-summary.js) | Incident summary generator: template-based default with optional OpenAI GPT-4o-mini enrichment. | Node.js |
| [`server/routes/telemetry.js`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/server/routes/telemetry.js) | Ingestion API endpoint: handles single/batch telemetry, deduplication via `seq`, firmware 1.2.x heartbeat tracking. | Express |
| [`server/routes/tickets.js`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/server/routes/tickets.js) | REST API for ticket querying, filtering, and status updates. | Express |
| [`server/routes/network.js`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/server/routes/network.js) | REST API for substations, feeders, transformers, poles, and tree topology graph retrieval. | Express |
| [`server/routes/simulator.js`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/server/routes/simulator.js) | Simulation API: inject span/DT/feeder faults, inject noise/dead sensors, scheduled outages, repair faults, system reset. | Express |
| [`server/tests/localization.test.js`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/server/tests/localization.test.js) | Unit test suite covering dead sensor filtering, span fault detection, topology inference, and manual resolution rejection. | Node Test |
| [`public/index.html`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/public/index.html) | Control room single-page interface with 3-panel layout: incident list, Leaflet map, and ticket detail/simulator panel. | HTML5 |
| [`public/css/style.css`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/public/css/style.css) | Dark theme CSS with glassmorphism design tokens, status chips, severity badges, and micro-animations. | Vanilla CSS |
| [`public/js/app.js`](file:///d:/Propel.ai%20-%20Assignment%20%282026-2027%29/public/js/app.js) | Frontend application controller: WebSocket handler, Leaflet map rendering, ticket management, simulator panel logic. | JS (ES2022) |

---

## 🧠 2. Deep Dive: How the Core Mechanics Work

### A. Ingestion & Deduplication
- **Endpoint:** `POST /api/telemetry`
- **Deduplication:** Uses `device_id` and monotonic `seq`. If `seq <= last_seq`, packet is rejected as duplicate.
- **Clock Skew:** Skew up to ±90 seconds is tolerated by relying on per-device sequence numbers rather than strict global timestamp comparisons.
- **Firmware 1.2.x (~8%):** Old firmware doesn't issue `power_lost` messages. The server monitors missed 15-minute heartbeats; 2 consecutive missed heartbeats flag the pole as potentially dark.

### B. Fault Localization Algorithm
- **Physical Signature:** Power distribution is radial (a tree graph with no loops). When a span snaps, all poles downstream of the break lose power (`energized = 0`); all upstream poles remain live (`energized = 1`).
- **Tree Traversal:** Starting from the Distribution Transformer (DT) root node, BFS traverses the tree scanning for **boundary edges**: where the parent pole is `energized = 1` and child pole is `energized = 0`.
- **Grouping:** All dark poles reachable downstream from the boundary child node are grouped into a **single incident ticket** rather than firing separate alerts.

### C. Missing Topology Solution (60% Case)
- **Problem:** 60% of DTs have missing `seq_on_line` and `parent_pole_id`.
- **Algorithm:** Nearest-Neighbor Chain from DT coordinates:
  1. Start at DT GPS coordinates.
  2. Greedily connect to the nearest unvisited pole (root pole).
  3. Sequentially connect each pole to its nearest unvisited neighbor.
  4. If nearest unvisited pole is >1.8× median pole spacing away, check earlier visited nodes for a spur branch.
- **UI Disclosure:** Operator console highlights inferred topologies with lower confidence scores and an explicit badge: `⚠️ Inferred from GPS`.

### D. Noise & False Positive Story
- **Dead Sensor:** If pole $P_k$ is dark, but its child poles $P_{k+1}$ are live, this is physically impossible as a line fault. Flagged as `is_sensor_dead = 1` with no fault ticket created.
- **Scheduled Outage:** Filtered against active maintenance windows from `/scheduled-outages` API (with a 40-minute overrun buffer).
- **Debouncing:** 5-second debounce window per DT collects bursty dark packets before running graph traversal.

### E. Telemetry-Based Verification
- **Verification Rule:** A ticket auto-verifies to `VERIFIED` status only when telemetry reports `energized = 1` across all affected poles.
- **Manual Guard:** If a user/lineman attempts to click "Mark Resolved" while any affected pole is still dark, API rejects with HTTP 400: *"Cannot resolve: N poles are still dark"*.

---

## ❓ 3. Expected Interview Questions & Defense Answers

### Q1: "How does your fault localization algorithm work?"
> **Answer:** "Low-voltage distribution lines are radial trees with no loops. A wire breakage creates a clear boundary: the last pole upstream of the break is live, and the first pole downstream is dark. My algorithm performs a breadth-first search starting from the Distribution Transformer root node to locate edges where parent is live and child is dark. Once a boundary edge is identified, all downstream dark poles are grouped into a single incident ticket so the control room gets one actionable ticket rather than dozens of noisy alerts."

### Q2: "How did you solve the 60% missing topology problem?"
> **Answer:** "I implemented a geometric Nearest-Neighbor Chain algorithm. Starting from the surveyed GPS coordinates of the transformer, it greedily builds the line tree by connecting each pole to its nearest unvisited neighbor, with distance-ratio thresholding to detect spur branches. In the UI, I communicate this honestly: tickets on inferred trees carry lower confidence scores and show a clear `⚠️ Inferred from GPS` badge so operators know field verification is needed."

### Q3: "How do you distinguish a dead sensor from a real wire breakage?"
> **Answer:** "Physically, if a line snaps, every pole downstream of the break must be dark. If a single pole reports dark but its child poles report live, power is clearly flowing through that span — the sensor on that specific pole has failed. My system detects this condition, flags the pole as a sensor failure, and suppresses ticket creation."

### Q4: "Where did you use AI in the system, and why?"
> **Answer:** "I used AI for plain-English incident summarization — translating structured graph alerts into clear prose for control room operators working at 2 AM. I deliberately avoided using AI for the fault localization itself, because graph traversal is deterministic, instant, 100% explainable, and free. Using an LLM for spatial graph traversal would introduce latency, cost, and hallucination risks."

### Q5: "How does your system enforce telemetry-based ticket verification?"
> **Answer:** "The system does not trust human button clicks alone. When poles report `power_restored` telemetry, the fault engine automatically verifies the ticket state. If an operator or lineman manually attempts to mark a ticket as resolved while telemetry indicates any affected pole is still dark, the backend API rejects the request with an HTTP 400 error."

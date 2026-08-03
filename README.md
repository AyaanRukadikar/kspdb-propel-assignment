# ⚡ KSPDB — Power Grid Fault Detection & Localization System

> **Karnataka State Power Distribution Board (KSPDB)**
> Product Engineering Assignment (2026–2027)

A real-time IoT power grid monitoring system that ingests telemetry from 35,000+ pole sensors across a subdivision, detects low-voltage supply line faults by finding live/dark boundaries in radial networks, localizes breakages down to the exact span with GPS coordinates, filters out sensor noise and scheduled load shedding, and enforces telemetry-verified ticket closure.

---

## 🚀 Quick Start (One Command)

Requires only **Docker** and **Docker Compose**:

```bash
git clone https://github.com/your-username/kspdb-fault-localization.git
cd kspdb-fault-localization
docker compose up --build
```

The system will start up fully seeded with a synthetic Bangalore-area power grid (~5,000 poles across 4 substations, 31 feeders, and 100+ transformers).

- **Operator Console & Simulator UI:** [http://localhost:3000](http://localhost:3000)
- **API Health Check:** [http://localhost:3000/api/health](http://localhost:3000/api/health)

---

## 🌐 Public Live URL

- **Deployed Public URL:** [https://kspdb-fault-detection.onrender.com](https://kspdb-fault-detection.onrender.com) 


> **Note on Free-Tier Hosting:** Cold-starts on free hosting tiers may take 30–60 seconds on initial page load.

---

## ⚡ What This System Solves

| Problem Before | Solution Implemented |
| :--- | :--- |
| 2-hour window walking poles to find a snapped wire | **< 5 seconds** automated span localization with precise GPS coordinates & PIN code |
| Operators overwhelmed by 40+ phone complaints for 1 wire break | **Single incident ticket** grouping all downstream dark poles |
| High false-alarm rate from dead modem sensors | **Dead sensor filtering**: isolated dark pole with live children is flagged as sensor issue |
| Load-shedding triggering false fault alerts | **Scheduled outage feed integration** suppressing alerts during planned windows |
| Linemen closing tickets without fixing the fault | **Telemetry-verified closure**: ticket auto-verifies only when physical poles report `energized` |
| 60% of distribution transformers missing wiring diagrams | **Geometric topology inference** using Nearest-Neighbor Chain from DT coordinates |

---

## 📑 Repository Documentation Map

All detailed technical documentation is available in the five core markdown files:

| File | Content |
| :--- | :--- |
| 📐 [`ARCHITECTURE.md`](ARCHITECTURE.md) | Technical architecture, data flow diagram, localization algorithm, topology inference, noise handling, API specifications, UI rationale, and AI feature justification. |
| 📊 [`flowchart.md`](flowchart.md) | Visual Mermaid flowcharts for telemetry ingestion, fault localization (60% missing topology), noise decision tree, and ticket lifecycle. |
| 🚀 [`DEPLOYMENT.md`](DEPLOYMENT.md) | Docker & local setup instructions, environment variables, health verification, and detailed **troubleshooting guide** for common failure modes. |
| 📑 [`DECISIONS.md`](DECISIONS.md) | Architectural decision record (ADR), explicitly documented assumptions, trade-offs, known limitations, and 2-week roadmap. |
| 🤖 [`AI-WORKFLOW.md`](AI-WORKFLOW.md) | Breakdown of AI leverage, code generation share, concrete examples where AI outputs were flawed/corrected, and key prompt sessions. |

---

## 🧪 Driving the Fault Simulator

The operator console contains a built-in **Fault Simulator** panel on the right sidebar (or via button in header):

1. **Inject a Span Fault:** Select a Transformer, click `Inject Fault`. Observe a single localized ticket appearing instantly on the map and incident panel showing the exact broken span.
2. **Inject a Transformer Fault:** Select `DT Fault`. Watch all poles under that DT turn dark and trigger a single DT-level ticket.
3. **Inject Noise / Dead Sensor:** Click `Kill a Random Sensor`. Notice an isolated pole turns amber (sensor dead) without triggering a false fault alert.
4. **Scheduled Outage:** Create a planned outage window. Poles go dark without creating false tickets.
5. **Auto-Verification:** Click `Repair` on an active simulated fault. Telemetry receives `power_restored` signals, and the ticket automatically transitions to `verified`.
6. **Manual Resolution Guard:** Try marking a dark ticket as "Resolved" manually — the system blocks it until telemetry confirms power flow.

---

## 🛠️ Stack Overview

- **Backend:** Node.js, Express, WebSockets (`ws`)
- **Database:** SQLite (`better-sqlite3`) with WAL mode
- **Frontend:** Vanilla HTML5, CSS3 (Glassmorphism Dark Theme), JavaScript (ES2022)
- **Mapping:** Leaflet.js with CartoDB Dark Matter tile provider
- **Containerization:** Docker & Docker Compose

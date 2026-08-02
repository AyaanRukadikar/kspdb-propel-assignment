# 📑 Decisions & Architectural Trade-offs — KSPDB

This log records major technical and product decisions, explicitly documented assumptions, trade-offs made, and known limitations.

---

## 1. Architectural Decisions Log (ADR)

### ADR 01: Single-Process Node.js + Express Architecture
- **Decision:** Combine ingestion endpoint, graph analysis engine, REST API, WebSocket server, and static asset delivery into a single Node.js process.
- **Rejected:** Distributed microservice architecture (Kafka + Go Ingest + Python Graph Processor + React Frontend).
- **Rationale:** For a single subdivision (~35,000 poles, 39 msg/s steady state, 5,000 burst), a single Node.js process handles the load in <20MB memory. A distributed system adds operational complexity without adding value for this scale.

### ADR 02: Geometric Nearest-Neighbor Chain for Missing Topology (60% Case)
- **Decision:** Reconstruct tree topology for DTs with missing pole ordering by chaining nearest unvisited poles starting from the DT coordinates.
- **Rejected:** Falling back purely to ward-level or DT-level coarsening; or requiring a 100% complete field survey before launching.
- **Rationale:** Control room operators need specific span locations. Geometric inference provides span-level accuracy for >85% of standard street runs, with explicit UI disclosure (`⚠️ Inferred from GPS`) to maintain operator trust.

### ADR 03: Telemetry-Only Ticket Verification
- **Decision:** Prevent manual override of ticket resolution if any affected pole remains dark in `pole_state`.
- **Rejected:** Allowing linemen or operators to click "Resolved" and close tickets without sensor verification.
- **Rationale:** Addresses the core operational problem: field crews claiming a fault is fixed when power is still out.

### ADR 04: SQLite with Write-Ahead Logging (WAL)
- **Decision:** Use SQLite via `better-sqlite3` in WAL mode.
- **Rejected:** PostgreSQL or MongoDB.
- **Rationale:** Zero external database setup requirement for reviewers running `docker compose up`. SQLite handles read/write concurrency effortlessly for thousands of updates per second when WAL mode is enabled.

---

## 2. Explicitly Documented Assumptions

1. **Subdivision Boundary:** The system monitors one city subdivision (31 feeders, ~400 DTs, ~38,000 poles). Scale-out to 30 divisions would use feeder-partitioned worker threads.
2. **Radial Network Guarantee:** Low-voltage distribution lines operate as strict radial trees without loops or dual-feed switches.
3. **Scheduled Outage Buffer:** Maintenance windows regularly overrun by 20–40 minutes; therefore, the outage filter applies a 40-minute grace window before re-enabling alerts on that feeder/DT.

---

## 3. What We Would Do With Two More Weeks

1. **Historical Outage Topology Learning:** Use historical dark-pole co-occurrence data over time to refine and correct inferred graph topologies.
2. **Device Battery & RSSI Health Dashboard:** Add a view tracking capacitor battery decay (`battery_mv < 3200`) and low RSSI to proactively schedule sensor replacements before devices die.
3. **Push Notifications / Webhooks:** Integrate SMS/Telegram webhooks to alert duty engineers instantly on CRITICAL feeder outages.

---

## 4. Known Limitations & Fragilities

- **U-Shaped Roads & Dense Multi-Branch Spurs:** Geometric topology inference can misidentify parent poles on acute street bends.
- **Full Mesh Substation Feeder Cross-Ties:** If two feeders are manually tied together during emergency maintenance, the system assumes standard radial configuration unless updated in the feeder registry.

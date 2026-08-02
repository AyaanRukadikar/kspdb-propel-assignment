# 🚀 Deployment & Troubleshooting Guide — KSPDB

This document provides step-by-step instructions to run, verify, and troubleshoot the KSPDB system from a fresh clone.

---

## 📋 Prerequisites

- **Docker:** `20.10.0+`
- **Docker Compose:** `v2.0.0+`
- **Node.js (for local non-Docker development):** `v20.0.0+`

---

## ⚡ Quick Start Deployment

Run the following commands from the project root:

```bash
# 1. Clone repository
git clone https://github.com/your-username/kspdb-fault-localization.git
cd kspdb-fault-localization

# 2. Build and launch container stack
docker compose up --build
```

The container will compile native SQLite bindings, seed the synthetic network automatically, and start listening on port `3000`.

---

## ⚙️ Environment Variables

Copy `.env.example` to `.env` if custom variables are needed:

| Variable | Description | Required | Default |
| :--- | :--- | :--- | :--- |
| `PORT` | HTTP & WebSocket server port | No | `3000` |
| `NODE_ENV` | Environment (`development` / `production`) | No | `production` |
| `OPENAI_API_KEY` | Optional API key for LLM summaries | No | *(empty)* |

---

## ✅ Verification Checklist

1. Open `http://localhost:3000` in a browser. You should see the dark control room console with a map of Bangalore showing thousands of green pole markers.
2. Check `http://localhost:3000/api/health`. Should return `{"status":"ok"}`.
3. Open the **Simulator Panel** on the right side of the UI.
4. Select `Span Fault` and click **Inject Fault**.
5. Observe a new incident card appear on the left panel, with the fault span drawn in yellow on the map.
6. Click **Repair** in the simulator panel. The ticket should auto-verify to `VERIFIED` status.

---

## 🔍 Troubleshooting & Known Failure Modes

| Symptom | Cause | Solution |
| :--- | :--- | :--- |
| `Port 3000 already in use` | Another local application is occupying port 3000. | Change `PORT=3001` in `.env` or run `PORT=3001 docker compose up`. |
| `better-sqlite3 compilation failed` | Missing C++ build tools on host machine (non-Docker). | In Docker, alpine build tools are installed automatically. On Windows/Linux host, install Python 3 and Visual Studio C++ Build Tools or use Docker. |
| `WebSocket connection failed (WS error)` | Reverse proxy or cloud host (e.g. Nginx, Cloudflare, Render) stripping WebSocket upgrade headers. | Ensure proxy allows `Upgrade: websocket` and `Connection: Upgrade` headers. |
| `Cold-start timeout on public URL` | Free-tier host (Render/Fly.io) put container to sleep. | Wait 30–40 seconds for container startup; check health endpoint `/api/health`. |
| `CORS Error on API requests` | Accessing API from a different domain or port. | CORS middleware is enabled on all `/api/*` endpoints. Verify request origin. |
| `DB locked error (SQLITE_BUSY)` | Concurrent writes to SQLite without WAL mode. | Database automatically sets `pragma journal_mode = WAL`. If persisting across hosts, ensure network filesystem (NFS) is not locking SQLite files. |

---

## 🔄 Resetting to a Clean State

To wipe all created tickets and reset all poles back to live energized state:

- Click **Reset Everything** at the bottom of the Simulator panel in the UI.
- Or send an HTTP POST request:
  ```bash
  curl -X POST http://localhost:3000/api/simulator/reset
  ```
- Or re-seed the database:
  ```bash
  npm run seed
  ```

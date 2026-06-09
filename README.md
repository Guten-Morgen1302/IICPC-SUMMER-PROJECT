# IICPC Distributed Benchmark Arena

A high-performance distributed benchmarking and hosting platform designed to provide a fair, deterministic, and high-credibility proving ground for trading infrastructure and matching engines.

---

## Table of Contents

- [Overview](#overview)
- [Why This Platform Exists](#why-this-platform-exists)
- [Core Capabilities](#core-capabilities)
- [Architecture](#architecture)
- [Service Catalog](#service-catalog)
- [Monorepo Structure](#monorepo-structure)
- [Technology Stack](#technology-stack)
- [Scoring Model](#scoring-model)
- [Dashboard Routes](#dashboard-routes)
- [Contestant Engine Contract](#contestant-engine-contract)
- [Getting Started](#getting-started)
- [Current Status](#current-status)
- [Known Limitations](#known-limitations)

---

## Overview

Benchmarking low-latency systems is notoriously difficult. Noisy neighbors, non-deterministic environments, and inconsistent traffic patterns frequently distort results. The IICPC Benchmark Arena addresses this by providing a strictly isolated sandbox paired with a high-fidelity bot fleet, enabling repeatable measurement of end-to-end request latency under real order flow. The platform operates over HTTP and measures latency at the millisecond granularity (p50/p95/p99), which is the relevant scale for a distributed matching engine communicating across containers.

The platform is designed around three core principles:

- **Determinism**: Performance deltas are code-driven, not infrastructure-driven. The current implementation uses hardened Docker sandboxes with strict CPU and memory limits. Future phases will introduce Firecracker MicroVMs for VM-grade isolation.
- **Fairness**: Resource pinning and fixed benchmark profiles prevent hardware-level interference between competing engines.
- **Transparency**: Every run produces a forensic dossier containing latency telemetry and correctness-aware scoring, enabling engines to be compared on dimensions beyond raw throughput.

---

## Why This Platform Exists

Most benchmark tools report throughput and latency averages. The Arena is designed to behave more like a hostile market laboratory than a simple load tester.

### Adaptive Adversarial Trading Bots

The bot fleet simulates intelligent, sometimes hostile, market participants rather than uniform request traffic:

- **Latency spike attacks** — bots detect small latency increases, synchronize bursts, and attempt to create queue contention and order collisions.
- **Flash crash simulations** — bots dump aggressive sell volume without warning to observe how engines handle volatility shocks.
- **Liquidity traps** — bots place and rapidly cancel orders to stress cancellation handling and matching logic.

The objective is to penalize naive implementations and reward robust, correctly-specified engines.

### Deterministic Replay

Every benchmark run can be replayed exactly using the same event stream, timestamps, order sequence, and concurrency pattern. Because all events flow through Redpanda, the exact traffic that degraded or crashed an engine can be captured and replayed. This makes debugging and cross-team verification repeatable.

### Correctness Verification

The platform measures correctness under concurrency alongside latency and throughput. Each run verifies:

- Price-time priority (FIFO compliance)
- Fill correctness
- Behavior under concurrent order races and cancellations

Engines that violate core matching rules receive a reduced Correctness Multiplier in the Arena Score regardless of their raw speed.

### Kernel-Level Telemetry (Planned)

Future phases will integrate eBPF and OpenTelemetry probes to surface kernel-level signals including syscall latency, TCP retransmissions, scheduler delays, CPU migrations, and memory pressure. This enables correlation between application-level p99 spikes and underlying OS events.

### Firecracker MicroVM Isolation (Planned)

The next isolation phase will replace Docker sandboxes with Firecracker MicroVMs to provide VM-grade security for untrusted contestant code, stronger resource fairness between competitors, and tighter CPU and memory controls.

---

## Core Capabilities

| Capability | Description |
|---|---|
| Submission Pipeline | Ingests compressed engine artifacts (zip/tar) with manifest-driven configuration |
| Real-Time Telemetry | Event streaming via Redpanda (Kafka API) with long-term storage in QuestDB |
| Composite Scoring | Multi-factor scoring based on throughput, latency ratios, and correctness multipliers |
| Competitive Leaderboard | Global rankings powered by Redis Sorted Sets with live updates |
| Arena Dashboard | React-based UI for live monitoring, engine inspection, and submission tracking |
| Docker Sandboxing | Isolated container execution with strict CPU, memory, and I/O limits |
| Health-Aware Load Generation | Exponential backoff retry logic for sandbox readiness verification |
| Database Persistence | PostgreSQL with Prisma ORM for all pipeline state and results |

---

## Architecture

The system follows a reactive microservices architecture orchestrated by a central pipeline state machine.

```
Submission -> Build -> Sandbox -> Benchmark -> Telemetry -> Scoring -> Leaderboard -> UI
```

Each stage is an independent service communicating over HTTP and Redpanda message topics. The submission API acts as the pipeline orchestrator and transitions the run through all eight stages, emitting telemetry events at each boundary.

---

## Service Catalog

| Service | Responsibility |
|---|---|
| `submission-api` | Entry point for artifacts; orchestrates the full pipeline lifecycle |
| `telemetry-ingestor` | Consumes raw latency events from Redpanda and writes to QuestDB via Influx Line Protocol |
| `scoring-engine` | Aggregates QuestDB metrics (p99, throughput) and computes the final Arena Score |
| `leaderboard-api` | Manages Redis ZSET rankings and provides aggregate system overview metrics |
| `load-generator-controller` | Manages the bot fleet and traffic scenarios (Stress, Smoke, Burst) |
| `reference-engine` | Baseline C++ matching engine used to validate platform measurement accuracy |
| `web` | React + Vite frontend dashboard |

---

## Monorepo Structure

```
/
├── apps/
│   ├── web/                    # React Arena Dashboard
│   ├── submission-api/         # Ingestion and Pipeline Orchestration
│   ├── leaderboard-api/        # Redis Ranking and Metrics
│   ├── scoring-engine/         # Percentile-based scoring logic
│   ├── telemetry-ingestor/     # Redpanda to QuestDB bridge
│   ├── load-generator/         # High-concurrency bot fleet
│   └── reference-engine/       # C++ baseline engine
├── packages/
│   ├── db/                     # Prisma schema and PostgreSQL client
│   ├── shared-types/           # Common Order/Fill/Run type definitions
│   ├── config/                 # Service-level environment presets
│   └── logger/                 # Structured JSON logging
├── k8s/                        # Kubernetes manifests and network policies
├── infra/                      # Infrastructure configuration
├── docs/                       # API specifications and documentation
├── docker-compose.yml          # Core infrastructure services
├── docker-compose.secure.yml   # Hardened gVisor configuration
└── sample-engine.zip           # Reference submission template
```

---

## Technology Stack

| Layer | Technologies |
|---|---|
| Backend Services | Node.js 18+, TypeScript, Fastify, Prisma |
| Messaging | Redpanda (Kafka-compatible API) |
| Time-Series Storage | QuestDB (Influx Line Protocol ingestion) |
| Relational Storage | PostgreSQL |
| Caching and Rankings | Redis (Sorted Sets) |
| Reference Engine | C++ |
| Frontend | React, Vite, Framer Motion, Lucide Icons |
| Infrastructure | Docker Compose, Kubernetes (k8s manifests) |
| Package Manager | pnpm with Turborepo |

---

## Scoring Model

The Arena uses a composite formula to rank engines based on efficiency under load:

```
Arena Score = (Throughput_RPS / p50_Latency_MS) * Correctness_Multiplier
```

All latency values are measured in **milliseconds** at the HTTP transport layer (p50/p95/p99). This reflects the real round-trip cost of order submission over the container network, not in-process matching time.

| Tier | Correctness Multiplier | Condition |
|---|---|---|
| Platinum | 1.0x | Full protocol compliance, zero violations |
| Gold | 0.7x | Minor warnings, non-critical deviations |
| Disqualified | 0.0x | Protocol violation or determinism failure |

Higher throughput-to-latency ratios earn more points. Any correctness violation degrades or eliminates the score regardless of raw performance.

**Important:** Scoring is gated on the correctness evaluation stage completing successfully. If the correctness engine skips a run (for example, when no eligible runs are queued), the run is not scored and does not appear on the leaderboard. Only runs with a resolved `correctnessStatus` of `PASS`, `PASS_WITH_WARNINGS`, or `FAIL` are eligible for ranking. All leaderboard entries reflect actual measured runs stored in the database.

---

## Dashboard Routes

| Route | Description |
|---|---|
| `/overview` | High-level cluster KPIs: total TPS, node health, active runs |
| `/leaderboard` | Ranked standings with trend indicators and live activity feed |
| `/submissions` | Full history of submitted engines and their scoring results |
| `/runs/:id` | Performance Dossier: p95/p99 histograms, fill correctness, audit log |
| `/pipeline/:id` | Real-time visualization of the build, sandbox, and benchmark lifecycle |
| `/upload` | Submit a new engine artifact with manifest validation |

---

## Contestant Engine Contract

Contestant engines must expose the following HTTP endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Readiness probe for sandbox verification |
| `/orders` | POST | Place a new order into the matching engine |
| `/cancel` | POST | Cancel an existing order |
| `/orderbook` | GET | Return the current state of the order book |

The full request and response schema is defined in [`docs/contestant-api.openapi.yaml`](docs/contestant-api.openapi.yaml). The load generator targets these short paths during benchmark execution.

---

## Getting Started

### Prerequisites

- Docker and Docker Compose installed and running
- Node.js 18 or later
- pnpm installed globally

### 1. Bootstrap Infrastructure

Start the core data plane services:

```bash
docker-compose up -d postgres redis redpanda questdb
```

### 2. Install Dependencies and Generate Database Client

```bash
pnpm install
pnpm --filter=@benchmark/db run db:generate
pnpm --filter=@benchmark/db run db:push
```

### 3. Start All Services

Run all services in development mode using Turborepo:

```bash
pnpm dev
```

### 4. Trigger a Benchmark Run

1. Open `http://localhost:5173/upload` in your browser.
2. Upload `sample-engine.zip` as a test submission.
3. Wait approximately 15 seconds for the simulated pipeline to complete.
4. View the scored result in the Arena Standings at `/leaderboard`.

---

### Optional: Hardened Sandbox with gVisor

For environments requiring stronger isolation, the Arena supports gVisor (`runsc`) as the Docker container runtime.

**Step 1** — Install the gVisor runtime on the Linux host:

```bash
sudo apt-get update && sudo apt-get install -y runsc
```

**Step 2** — Register the runtime in `/etc/docker/daemon.json`:

```json
{
  "runtimes": {
    "runsc": {
      "path": "runsc"
    }
  }
}
```

**Step 3** — Restart the Docker daemon:

```bash
sudo systemctl restart docker
```

**Step 4** — Enable gVisor isolation by setting `DOCKER_RUNTIME=runsc` in your `.env` file, or start the secure compose configuration directly:

```bash
docker compose -f docker-compose.yml -f docker-compose.secure.yml up -d
```

---

## Current Status

| Component | Status | Notes |
|---|---|---|
| End-to-end pipeline (all 8 stages) | Implemented | Stages chain via HTTP; any stage failure halts the run |
| Docker container creation and lifecycle management | Implemented | 1 CPU / 512 MB RAM limits with seccomp profiles |
| Benchmark execution with configurable bot fleets | Implemented | Smoke, Stress, and Burst scenarios; real measured RPS in the low tens under local load |
| Correctness evaluation | Implemented — may skip | Correctness engine runs as a separate service. If it has no eligible run queued, the stage is marked SKIPPED and the run is not scored. This is the known gap between pipeline completion and leaderboard appearance. |
| Composite scoring | Implemented — gated | Scoring only proceeds after a resolved correctness status. Runs with SKIPPED correctness are excluded from the leaderboard. |
| Leaderboard ranking and persistence | Implemented | Rankings reflect only EVALUATED runs with a resolved correctness status. Entries show measured throughput and latency from the actual benchmark run. |
| Web dashboard | Implemented | Submission tracking, pipeline visualization, run dossiers with p95/p99 histograms |
| Telemetry ingestion and QuestDB time-series storage | Implemented | Redpanda -> QuestDB via Influx Line Protocol |
| Multi-factor scoring formula with tunable weights | Implemented | Weights configurable via environment variables |
| REST API endpoints across all services | Implemented | Health, submit, status, leaderboard, runs |
| PostgreSQL persistence with Prisma ORM | Implemented | All pipeline state and results persisted |

---

## Known Limitations

- Sandbox isolation is Docker-based in the current release. Firecracker MicroVM support is planned for a future phase to provide stronger, VM-grade isolation.
- The platform operates as a single-region, single-cluster deployment. Multi-region support is not yet implemented.
- Kernel-level telemetry via eBPF and OpenTelemetry is experimental and not yet surfaced in the dashboard.

---

*IICPC Summer Hackathon 2026. Built for performance measurement.*

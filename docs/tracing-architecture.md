# Distributed Trace Architecture

## Overview

Every GitHub-to-Vercel deployment carries a single **trace ID** from creation to completion across all pipeline stages. This enables end-to-end correlation of logs, errors, and timing data without a centralised collector.

## Trace Format

W3C Trace Context (`traceparent` header):

```
00-<traceId>-<spanId>-01
     ^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^
     128-bit hex   64-bit hex (per span)
```

- **traceId** — 32 hex characters, stable for the entire deployment lifecycle.
- **spanId** — 16 hex characters, unique per pipeline stage.
- **flags** — `01` (sampled).

## Pipeline Stages and Spans

| Stage | Span name | What it covers |
|---|---|---|
| Environment validation | `validate-env` | Check `VERCEL_PROJECT_ID` is present |
| Vercel trigger | `trigger-vercel` | POST to Vercel REST API |
| Metadata storage | `store-metadata` | INSERT into `github_vercel_deployments` |
| Status sync | `sync-status` | GET deployment status + UPDATE row |

Each span records `durationMs`, `traceId`, and `spanId` in the structured log output.

## Log Correlation

All log entries produced by `GitHubToVercelDeploymentService` include `traceId` as a top-level metadata field. To trace a deployment end-to-end:

```bash
# Find all log lines for a deployment
grep '"traceId":"<traceId>"' /var/log/craft/backend.log
```

The `trace_id` column is also written to the `github_vercel_deployments` table so deployments can be correlated directly from the database.

## Error Reports

When a deployment fails, the `traceId` is included in the returned `TriggerDeploymentResult.traceId`. This value should be included in bug reports and support tickets.

## Implementation

- **`src/lib/tracing.ts`** — `startTrace()`, `newSpan()`, `withSpan()`, `parseTraceparent()`
- **`src/services/github-to-vercel-deployment.service.ts`** — instruments all pipeline stages

## Overhead

Span instrumentation is in-process and adds only a `Date.now()` call and a `crypto.randomBytes(8)` call per stage — negligible overhead compared to network I/O.

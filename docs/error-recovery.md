# Error Recovery Runbook

Comprehensive procedures for recovering from failures across all CRAFT system components.

---

## GitHub-to-Vercel Deployment Error Propagation Flow

The deployment chain consists of 6 failure points. Errors must propagate with typed responses at each layer:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ GitHub Push Event                                                           │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ Failure Point 1:        │
                    │ GitHub API Validation   │
                    │ (auth, rate limit, 404) │
                    └────────────┬────────────┘
                                 │ ✓ Valid
                    ┌────────────▼────────────┐
                    │ Failure Point 2:        │
                    │ Vercel API Trigger      │
                    │ (auth, quota, 500)      │
                    └────────────┬────────────┘
                                 │ ✓ Deployment created
                    ┌────────────▼────────────┐
                    │ Failure Point 3:        │
                    │ Database Insert         │
                    │ (timeout, constraint)   │
                    └────────────┬────────────┘
                                 │ ✓ Metadata stored
                    ┌────────────▼────────────┐
                    │ Failure Point 4:        │
                    │ Partial Failures        │
                    │ (Vercel OK, DB fails)   │
                    └────────────┬────────────┘
                                 │ ✓ Deployment URL returned
                    ┌────────────▼────────────┐
                    │ Failure Point 5:        │
                    │ Network Timeouts        │
                    │ (connection, DNS)       │
                    └────────────┬────────────┘
                                 │ ✓ Timeout handled
                    ┌────────────▼────────────┐
                    │ Failure Point 6:        │
                    │ Invalid Configuration   │
                    │ (missing env vars)      │
                    └────────────┬────────────┘
                                 │ ✓ Config validated
                    ┌────────────▼────────────┐
                    │ Deployment Complete     │
                    │ Return typed response   │
                    └────────────────────────┘
```

### Error Response Structure

All errors must return a consistent typed response:

```typescript
interface TriggerDeploymentResult {
    success: boolean;
    deploymentId: string;
    deploymentUrl?: string;
    status?: string;
    errorMessage?: string;  // Always defined if success=false
}
```

### Error Propagation Rules

1. **No silent failures**: Every error must be logged and returned
2. **Typed errors only**: All errors must be instances of typed error classes
3. **Partial success**: If Vercel succeeds but DB fails, return success with deployment URL
4. **Rollback on failure**: Do not create DB record if Vercel deployment fails
5. **Consistent messages**: Error messages must contain actionable information

### Failure Point Details

| Point | Layer | Errors | Propagation | Rollback |
|-------|-------|--------|-------------|----------|
| 1 | GitHub | 401, 403, 404, 429 | Typed error response | N/A |
| 2 | Vercel | 401, 404, 429, 500 | Typed error response | No DB insert |
| 3 | Database | Timeout, constraint, permission | Logged, non-fatal | N/A |
| 4 | Partial | Vercel OK, DB fails | Return success | N/A |
| 5 | Network | Timeout, ECONNREFUSED | Typed error response | No DB insert |
| 6 | Config | Missing env vars | Typed error response | N/A |

---

## Table of Contents

1. [Database Failures](#1-database-failures)
2. [External Service Outages](#2-external-service-outages)
3. [Deployment Failures](#3-deployment-failures)
4. [Troubleshooting Flowcharts](#4-troubleshooting-flowcharts)
5. [Recovery Time Objectives](#5-recovery-time-objectives)
6. [Escalation Procedures](#6-escalation-procedures)

---

## 1. Database Failures

### 1.1 Supabase Connection Failure

**Symptoms:** API returns 500, logs show `Failed to connect to database`, auth stops working.

**Recovery steps:**

1. Verify environment variables are set:
   ```bash
   echo $NEXT_PUBLIC_SUPABASE_URL
   echo $NEXT_PUBLIC_SUPABASE_ANON_KEY
   ```
2. Check Supabase project status at [status.supabase.com](https://status.supabase.com).
3. Confirm the project is not paused (free-tier projects pause after 1 week of inactivity):
   - Go to Supabase Dashboard → Project Settings → General → Resume project.
4. Rotate the service role key if credentials may be compromised:
   - Dashboard → Project Settings → API → Regenerate keys.
5. Redeploy the application after updating secrets in Vercel.

**RTO:** 15 minutes (credential issue) / 60 minutes (Supabase incident).

---

### 1.2 Migration Failure

**Symptoms:** `supabase db push` exits non-zero; tables or columns missing.

**Recovery steps:**

1. Identify the failing migration:
   ```bash
   npx supabase db push --debug 2>&1 | grep -i error
   ```
2. Roll back to the last known-good state:
   ```bash
   npx supabase db reset   # development only — destroys data
   ```
3. For production, apply a compensating migration manually via the Supabase SQL editor.
4. Re-run `npx supabase db push` after fixing the migration file.

**Decision tree:**

```
Migration fails?
├── Syntax error in SQL → Fix the migration file → re-push
├── Constraint violation → Write compensating migration → re-push
└── Supabase service error → Wait for incident resolution → re-push
```

---

### 1.3 Row-Level Security (RLS) Lockout

**Symptoms:** Authenticated users receive 403 on their own data; service role queries succeed.

**Recovery steps:**

1. Connect with the service role key (bypasses RLS) to inspect policies:
   ```sql
   SELECT * FROM pg_policies WHERE tablename = '<affected_table>';
   ```
2. Temporarily disable RLS for diagnosis (never leave disabled in production):
   ```sql
   ALTER TABLE <affected_table> DISABLE ROW LEVEL SECURITY;
   ```
3. Fix the policy and re-enable:
   ```sql
   DROP POLICY IF EXISTS "<policy_name>" ON <affected_table>;
   CREATE POLICY "<policy_name>" ON <affected_table> ...;
   ALTER TABLE <affected_table> ENABLE ROW LEVEL SECURITY;
   ```
4. Verify with the `supabase/tests/rls/policy-verification.test.ts` test suite.

---

## 2. External Service Outages

### 2.1 Stripe Outage

**Symptoms:** Checkout sessions fail to create; webhook endpoint returns 400/500; subscription status stale.

**Recovery steps:**

1. Check [status.stripe.com](https://status.stripe.com) for active incidents.
2. Enable graceful degradation — surface a user-facing banner:
   ```
   "Payment processing is temporarily unavailable. Your account is safe."
   ```
3. Queue failed webhook events: Stripe retries webhooks for up to 72 hours automatically.
4. After the incident, replay missed events from the Stripe Dashboard → Developers → Webhooks → Failed deliveries.
5. Reconcile subscription states:
   ```bash
   # Fetch current subscription status from Stripe and update the database
   curl -s https://api.stripe.com/v1/subscriptions/<sub_id> \
     -u $STRIPE_SECRET_KEY: | jq '.status'
   ```

**RTO:** Dependent on Stripe SLA; internal reconciliation within 30 minutes of service restoration.

---

### 2.2 GitHub API Outage

**Symptoms:** Repository creation fails; deployment pipeline stalls at the "create repo" step.

**Recovery steps:**

1. Check [githubstatus.com](https://www.githubstatus.com).
2. The GitHub App installation token is cached in memory; no action needed for short outages (< token TTL).
3. For extended outages, queue deployment requests and retry after restoration:
   - Set deployment `status = 'pending'` in the database.
   - The deployment pipeline will retry on the next trigger.
4. If the installation token is stale after a long outage, restart the backend service to force token refresh.

---

### 2.3 Vercel API Outage

**Symptoms:** Deployments fail to trigger; `vercel.service.ts` throws on project creation.

**Recovery steps:**

1. Check [vercel-status.com](https://www.vercel-status.com).
2. Deployments already live continue to serve traffic (Vercel's edge network is separate from the API).
3. Queue new deployment requests with `status = 'pending'`; retry after restoration.
4. For urgent rollbacks, use the Vercel Dashboard directly to promote a previous deployment.

---

### 2.4 Stellar / Horizon Outage

**Symptoms:** Transaction submissions fail; `stellar-network.service.ts` throws `NetworkError`.

**Recovery steps:**

1. Check [dashboard.stellar.org](https://dashboard.stellar.org) for network health.
2. Switch to a fallback Horizon instance by updating `STELLAR_HORIZON_URL`:
   - Primary: `https://horizon.stellar.org`
   - Fallback: `https://horizon.stellar.lobstr.co`
3. For testnet, use `https://horizon-testnet.stellar.org` (maintained by SDF).
4. Inform users that blockchain operations are paused; queue transactions for retry.

---

## 3. Deployment Failures

### 3.1 Build Failure

**Symptoms:** Vercel build log shows compilation errors; deployment status stays `building`.

**Recovery steps:**

1. Reproduce locally:
   ```bash
   cd apps/backend && npm run build
   ```
2. Common causes and fixes:

   | Cause | Fix |
   |---|---|
   | Missing env var | Add variable in Vercel → Project Settings → Environment Variables |
   | Type error | Fix TypeScript error; run `npx tsc --noEmit` |
   | Missing dependency | Add to `package.json`; commit `package-lock.json` |
   | Node version mismatch | Set `engines.node` in `package.json`; configure in Vercel |

3. Push a fix commit; Vercel will automatically retry the build.

---

### 3.2 Deployment Stuck in `building` State

**Symptoms:** Deployment record has `status = 'building'` for > 15 minutes.

**Recovery steps:**

1. Check Vercel Dashboard for the project's deployment log.
2. If the Vercel deployment succeeded but the database was not updated, manually patch:
   ```sql
   UPDATE deployments
   SET status = 'completed', last_deployed_at = NOW()
   WHERE id = '<deployment_id>';
   ```
3. If the Vercel deployment failed, set status to `failed` and surface the error to the user:
   ```sql
   UPDATE deployments SET status = 'failed' WHERE id = '<deployment_id>';
   ```
4. Trigger a re-deployment from the CRAFT dashboard or via the API.

---

### 3.3 Deployment Health Check Failing

**Symptoms:** Cron job reports deployment unhealthy; `deployment_analytics` shows `uptime_check = 0`.

**Recovery steps:**

1. Manually verify the deployment URL:
   ```bash
   curl -I https://<deployment-url>
   ```
2. Check Vercel function logs for runtime errors.
3. If the deployment is genuinely down, trigger a re-deployment.
4. If the URL is correct but the health check is a false positive (e.g., cold start), increase the timeout threshold in `health-monitor.service.ts`.
5. Notify the deployment owner via `notifyDowntime` if downtime exceeds 5 minutes.

---

### 3.4 GitHub Repository Creation Conflict (409)

**Symptoms:** `POST /api/deployments/[id]/repository` returns 409; logs show "Repository name collision".

**Recovery steps:**

1. The service automatically retries with a numeric suffix (e.g., `my-dex-1`, `my-dex-2`).
2. If all retries are exhausted, ask the user to choose a different deployment name.
3. Check for orphaned repositories in the GitHub org and delete if safe.

---

## 4. Troubleshooting Flowcharts

### 4.1 General API Error

```
API returns error?
│
├── 400 Bad Request
│   └── Validate request body against Zod schema
│       ├── Schema mismatch → Fix client payload
│       └── Valid payload → Check service-layer validation
│
├── 401 Unauthorized
│   └── Check Authorization header
│       ├── Missing → User must sign in
│       └── Present → Token expired? → Refresh token
│
├── 403 Forbidden
│   └── RLS policy blocking access?
│       ├── Yes → Review policy (§1.3)
│       └── No → Check subscription tier limits
│
├── 404 Not Found
│   └── Resource deleted or wrong ID → Verify in database
│
├── 409 Conflict
│   └── Duplicate resource → See §3.4
│
├── 429 Too Many Requests
│   └── Rate limit hit → Back off and retry after Retry-After header
│
└── 500 Internal Server Error
    └── Check Vercel function logs
        ├── Database error → §1
        ├── External service error → §2
        └── Unhandled exception → File bug report
```

---

### 4.2 Deployment Pipeline Failure

```
Deployment fails?
│
├── Status: pending (never started)
│   └── Check GitHub API (§2.2) and Vercel API (§2.3)
│
├── Status: building (stuck)
│   └── See §3.2
│
├── Status: failed
│   ├── Build error → See §3.1
│   ├── GitHub repo conflict → See §3.4
│   └── Vercel project creation failed → Check VERCEL_TOKEN validity
│
└── Status: completed but URL unreachable
    └── See §3.3
```

---

### 4.3 Payment / Subscription Issue

```
Subscription not updating?
│
├── Webhook not received
│   ├── Check Stripe Dashboard → Webhooks → Failed deliveries
│   └── Verify STRIPE_WEBHOOK_SECRET matches endpoint secret
│
├── Webhook received but database not updated
│   ├── Check function logs for handler errors
│   └── Manually reconcile via Stripe API (§2.1)
│
└── Subscription active in Stripe but tier shows 'free' in app
    └── Update profiles table directly:
        UPDATE profiles SET subscription_tier = '<tier>'
        WHERE stripe_subscription_id = '<sub_id>';
```

---

## 5. Recovery Time Objectives

| Component | Target RTO | Target RPO |
|---|---|---|
| Supabase (credential issue) | 15 min | 0 (no data loss) |
| Supabase (platform incident) | 60 min | < 5 min (WAL replication) |
| Stripe outage | Dependent on Stripe SLA | 0 (events replayed) |
| GitHub API outage | 30 min post-restoration | 0 (queued requests) |
| Vercel API outage | 30 min post-restoration | 0 (queued requests) |
| Stellar / Horizon outage | 15 min (fallback switch) | 0 (transactions queued) |
| Build failure | 30 min | N/A |
| Stuck deployment | 15 min | N/A |

---

## 6. Escalation Procedures

### Severity Levels

| Level | Definition | Response Time |
|---|---|---|
| P1 — Critical | Production down, data loss risk, security breach | Immediate (< 15 min) |
| P2 — High | Major feature broken, payment processing down | < 1 hour |
| P3 — Medium | Non-critical feature degraded, single user affected | < 4 hours |
| P4 — Low | Cosmetic issue, documentation gap | Next sprint |

### Escalation Path

```
On-call engineer
    │
    ├── P3/P4 → Handle independently, document in incident log
    │
    ├── P2 → Notify team lead within 1 hour
    │         └── If unresolved in 2 hours → escalate to P1
    │
    └── P1 → Page team lead immediately
              └── If unresolved in 30 min → page engineering manager
                  └── If unresolved in 1 hour → engage vendor support
                      ├── Supabase: support.supabase.com
                      ├── Stripe: support.stripe.com
                      └── Vercel: vercel.com/support
```

### Incident Log Template

```
Date: YYYY-MM-DD HH:MM UTC
Severity: P1 / P2 / P3 / P4
Component: <affected component>
Summary: <one-line description>
Timeline:
  HH:MM - Issue detected
  HH:MM - Root cause identified: <cause>
  HH:MM - Mitigation applied: <action>
  HH:MM - Service restored
Impact: <number of users / deployments affected>
Root cause: <detailed explanation>
Prevention: <follow-up action items>
```

### Contact List

| Role | Contact |
|---|---|
| Engineering on-call | Rotate per team schedule |
| Engineering manager | engineering@craft.app |
| Supabase support | support.supabase.com (paid plans) |
| Stripe support | support.stripe.com |
| Vercel support | vercel.com/support |
| Security issues | security@craft.app |

---

## Multi-Region Deployment Failover and Recovery

### Overview

CRAFT deployments target multiple Vercel regions simultaneously (`iad1`, `sfo1`, `fra1`, `sin1`, `gru1`). The deployment pipeline tracks per-region status independently so that a single region failure does not block the entire deployment.

### Region Status Model

Each region record carries one of the following statuses:

| Status | Meaning |
|--------|---------|
| `pending` | Region deployment has not started |
| `deploying` | Vercel deployment in progress |
| `healthy` | Deployment succeeded and health check passed |
| `failed` | Deployment or health check failed |
| `rolled_back` | Region was rolled back to the previous version |

The `overallStatus` of a multi-region deployment is derived as:

- `completed` — all regions are `healthy`
- `partial` — at least one region is `healthy` and at least one is `failed`
- `failed` — all regions are `failed`
- `rolled_back` — rollback was triggered and all regions are `rolled_back`

### Failure Scenarios and Recovery Behaviour

#### Scenario 1: Single Region Outage

**Trigger**: One region returns a 5xx or connection error from the Vercel API.

**Behaviour**:
1. The failed region is marked `failed` with the error message recorded.
2. All other regions continue to `healthy`.
3. `overallStatus` is set to `partial`.
4. The failover procedure re-attempts deployment to the failed region only.
5. If failover succeeds, `overallStatus` transitions to `completed`.

#### Scenario 2: Primary Region Outage

**Trigger**: The primary region (`iad1`) is unreachable before any region has deployed.

**Behaviour**:
1. All regions remain `pending` or transition to `failed`.
2. `overallStatus` is set to `failed`.
3. No rollback is needed (nothing was deployed).
4. The operator must resolve the primary region issue and re-trigger the pipeline.

#### Scenario 3: Partial Success

**Trigger**: A subset of regions deploy successfully; the remainder fail (e.g. build timeout, rate limit).

**Behaviour**:
1. Successful regions are marked `healthy`; failed regions are marked `failed`.
2. `overallStatus` is `partial`.
3. Failed regions record the specific error (timeout, 429, etc.).
4. The failover procedure targets only the failed regions.
5. If all failover attempts succeed, `overallStatus` becomes `completed`.
6. If failover also fails, the operator may trigger a full rollback.

#### Scenario 4: All Regions Failed

**Trigger**: Every region returns an error (e.g. Vercel API outage, invalid build config).

**Behaviour**:
1. All regions are marked `failed`.
2. `overallStatus` is `failed`.
3. No rollback is needed.
4. The root cause must be resolved before re-triggering.

#### Scenario 5: Rollback After Partial Success

**Trigger**: Operator or automated health check determines the partial deployment is unsafe.

**Behaviour**:
1. All regions (including `healthy` ones) are rolled back to the previous version.
2. Every region record transitions to `rolled_back`.
3. `overallStatus` becomes `rolled_back`.
4. The previous `vercelDeploymentId` is cleared from all records.

### Rollback Decision Criteria

Rollback is triggered automatically when:
- Post-deploy health check failure rate ≥ 5 % within the first 5 minutes
- Explicit operator action via the CRAFT dashboard

Rollback is **not** triggered automatically when:
- Only a subset of regions failed during initial deployment (failover is attempted first)
- The failure is in a non-primary region and the primary region is healthy

### Recovery Time Objectives

| Scenario | RTO |
|----------|-----|
| Single region failover | < 5 minutes |
| Full rollback | < 10 minutes |
| All-region failure (Vercel outage) | Dependent on Vercel incident resolution |

### Test Coverage

Multi-region failure scenarios are covered by:

- `apps/backend/tests/deployment/multi-region-fixtures.ts` — reusable fixture constants and factory helpers
- `apps/backend/tests/deployment/multi-region-failure-recovery.test.ts` — 5 scenario tests with deployment record state assertions

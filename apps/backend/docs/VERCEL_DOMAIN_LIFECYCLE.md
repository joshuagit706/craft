# Vercel Domain Alias Lifecycle Management with DNS Automation

**Issue:** #652  
**Feature:** Automated domain lifecycle management for Vercel projects  
**Status:** ✅ Implemented

## Overview

The Vercel Domain Lifecycle Management system automates the complete lifecycle of custom domain aliases on Vercel projects, from initial DNS configuration through verification to cleanup. The system handles partial failures gracefully and provides structured results for all operations.

## Architecture

### Service Layer

```
VercelDomainLifecycleService
├── addDomainWithDns()         → Register domain + generate DNS instructions
├── verifyDnsPropagation()     → Check DNS propagation + TLS certificate
├── removeDomainWithCleanup()  → Remove domain + clean up aliases
└── getDnsRecords()            → Generate DNS records (pure function)
```

### Dependencies

- **VercelService**: Core Vercel API integration (circuit breaker, auth, error handling)
- **DNS Configuration**: Generates provider-specific DNS instructions
- **Domain Verification**: TXT/CNAME verification via Node.js `dns.promises`

### Design Principles

1. **Zero modifications to VercelService** — lifecycle service delegates to existing methods
2. **Structured results, not exceptions** — domain-level errors return `{ success: false, error: "..." }`
3. **Partial failure handling** — cleanup errors are surfaced, not thrown
4. **Dependency injection** — narrow `VercelDomainClient` interface for testability

## Domain Lifecycle Phases

### 1. ADD — Register Domain with DNS Instructions

**Method:** `addDomainWithDns(domain: string, projectId: string)`

**Flow:**
1. Call Vercel API to register the domain on the project
2. Vercel begins TLS certificate provisioning immediately
3. Generate DNS records based on domain type:
   - **Apex domains** (e.g., `example.com`) → A + AAAA records
   - **Subdomains** (e.g., `app.example.com`) → CNAME record
4. Generate provider-specific instructions (Cloudflare, Namecheap, GoDaddy, Route 53)

**DNS Records:**

| Domain Type | Record Type | Host | Value | TTL |
|-------------|-------------|------|-------|-----|
| Apex | A | @ | 76.76.21.21 | 3600 |
| Apex | AAAA | @ | 2606:4700:4700::1111 | 3600 |
| Subdomain | CNAME | subdomain | cname.vercel-dns.com | 3600 |

**Result:**
```typescript
interface AddDomainWithDnsResult {
  success: boolean;
  domain: string;
  dnsRecords: DnsRecord[];
  providerInstructions: ProviderInstruction[];
  verificationRequirements?: DomainVerification[];
  error?: string;
}
```

**Example:**
```typescript
const result = await vercelDomainLifecycle.addDomainWithDns(
  'app.example.com',
  'prj_abc123'
);

if (result.success) {
  console.log('DNS Records:', result.dnsRecords);
  console.log('Instructions:', result.providerInstructions);
  // Display DNS setup instructions to user
} else {
  console.error('Failed to add domain:', result.error);
}
```

### 2. VERIFY — Check DNS Propagation and TLS Certificate

**Method:** `verifyDnsPropagation(domain: string, projectId: string)`

**Flow:**
1. Call Vercel's domain verification endpoint to check DNS ownership
2. If verified, check TLS certificate status
3. Return structured result with verification state and reason

**Certificate States:**
- `pending` — Vercel is provisioning the certificate
- `active` — Certificate is live and domain is ready
- `error` — Provisioning failed (DNS not propagated, CAA record issue, etc.)

**Result:**
```typescript
interface DnsPropagationResult {
  domain: string;
  verified: boolean;
  certState: CertificateState;
  requirements?: DomainVerification[];
  reason?: string;
}
```

**Verification Logic:**
```
Domain verified? ──┬─→ NO  → Return { verified: false, reason: "Domain ownership not verified" }
                   │
                   └─→ YES → Check certificate state
                              │
                              ├─→ active  → Return { verified: true, certState: "active" }
                              ├─→ pending → Return { verified: false, certState: "pending", reason: "TLS provisioning" }
                              └─→ error   → Return { verified: false, certState: "error", reason: cert.error }
```

**Example:**
```typescript
const result = await vercelDomainLifecycle.verifyDnsPropagation(
  'app.example.com',
  'prj_abc123'
);

if (result.verified) {
  console.log('✅ Domain is live with TLS certificate');
} else {
  console.log(`⏳ Not ready: ${result.reason}`);
  console.log(`Certificate state: ${result.certState}`);
}
```

**Polling Strategy:**
```typescript
async function pollUntilVerified(domain: string, projectId: string) {
  const maxAttempts = 60; // 5 minutes with 5-second intervals
  const intervalMs = 5000;

  for (let i = 0; i < maxAttempts; i++) {
    const result = await vercelDomainLifecycle.verifyDnsPropagation(domain, projectId);
    
    if (result.verified) {
      return { success: true, result };
    }

    if (result.certState === 'error') {
      return { success: false, error: result.reason };
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  return { success: false, error: 'Verification timeout' };
}
```

### 3. REMOVE — Delete Domain and Clean Up Aliases

**Method:** `removeDomainWithCleanup(domain: string, projectId: string, deploymentIds?: string[])`

**Flow:**
1. Remove the domain from Vercel (best-effort; 404 treated as success)
2. Scan provided deployment IDs for aliases matching the domain
3. Count matching aliases for observability
4. Return structured result with cleanup status

**Partial Failure Handling:**

The service handles partial failures gracefully to prevent orphaned state:

```
Remove domain ──┬─→ FAIL → Return { success: false, partialFailureReason: "..." }
                │          (Alias cleanup not attempted)
                │
                └─→ SUCCESS → Clean up aliases
                               │
                               ├─→ ALL SUCCESS → Return { success: true, aliasesRemoved: N }
                               │
                               └─→ SOME FAIL   → Return { 
                                                    success: true,
                                                    partialFailure: true,
                                                    partialFailureReason: "...",
                                                    aliasesRemoved: N
                                                  }
```

**Result:**
```typescript
interface RemoveDomainResult {
  success: boolean;
  domain: string;
  aliasesRemoved: number;
  partialFailure?: boolean;
  partialFailureReason?: string;
}
```

**Example:**
```typescript
const result = await vercelDomainLifecycle.removeDomainWithCleanup(
  'app.example.com',
  'prj_abc123',
  ['dpl_1', 'dpl_2', 'dpl_3']
);

if (result.success) {
  console.log(`✅ Domain removed, ${result.aliasesRemoved} aliases cleaned up`);
  
  if (result.partialFailure) {
    console.warn(`⚠️ Partial failure: ${result.partialFailureReason}`);
    // Log for retry or manual cleanup
  }
} else {
  console.error(`❌ Failed to remove domain: ${result.partialFailureReason}`);
}
```

## Error Handling

### Structured Error Codes

All Vercel API errors are mapped to structured codes:

| Code | Meaning | Retry? |
|------|---------|--------|
| `AUTH_FAILED` | Invalid or missing token | No |
| `RATE_LIMITED` | Rate limit exceeded | Yes (with backoff) |
| `NETWORK_ERROR` | Network timeout or connection failure | Yes |
| `DOMAIN_ALREADY_EXISTS` | Domain already registered | No |
| `DOMAIN_NOT_FOUND` | Domain doesn't exist (cleanup) | No (treated as success) |
| `UNKNOWN` | Unexpected error | Maybe |

### Circuit Breaker

All Vercel API calls go through a circuit breaker to prevent cascading failures:

**Configuration (env vars):**
```bash
VERCEL_CB_FAILURE_THRESHOLD=5      # Consecutive failures before opening
VERCEL_CB_RESET_TIMEOUT_MS=30000   # Cooldown period (30 seconds)
```

**States:**
- `CLOSED` — Normal operation
- `OPEN` — Fail-fast, no API calls made
- `HALF_OPEN` — One probe request to test recovery

### Never-Throw Guarantee

The lifecycle service never throws for domain-level errors:

```typescript
// ❌ BAD: Throws on domain error
try {
  await vercel.addDomain(domain, projectId);
} catch (err) {
  // Caller must handle exception
}

// ✅ GOOD: Returns structured result
const result = await vercelDomainLifecycle.addDomainWithDns(domain, projectId);
if (!result.success) {
  // Caller checks success flag
}
```

**Exception:** Infrastructure errors (auth failure, circuit breaker open) are propagated.

## Database Integration

### Schema

```sql
-- deployments table (migration 001)
CREATE TABLE deployments (
  id UUID PRIMARY KEY,
  custom_domain TEXT,
  vercel_project_id TEXT,
  vercel_deployment_id TEXT,
  deployment_url TEXT,
  -- ... other fields
);
```

### Workflow Example

```typescript
// 1. User requests custom domain
const { data: deployment } = await supabase
  .from('deployments')
  .select('*')
  .eq('id', deploymentId)
  .single();

// 2. Add domain and get DNS instructions
const addResult = await vercelDomainLifecycle.addDomainWithDns(
  customDomain,
  deployment.vercel_project_id
);

if (!addResult.success) {
  return { error: addResult.error };
}

// 3. Store domain in database
await supabase
  .from('deployments')
  .update({ custom_domain: customDomain })
  .eq('id', deploymentId);

// 4. Return DNS instructions to user
return {
  dnsRecords: addResult.dnsRecords,
  providerInstructions: addResult.providerInstructions,
};

// 5. User configures DNS at their registrar

// 6. Poll for verification (background job or user-triggered)
const verifyResult = await vercelDomainLifecycle.verifyDnsPropagation(
  customDomain,
  deployment.vercel_project_id
);

// 7. Update deployment status when verified
if (verifyResult.verified) {
  await supabase
    .from('deployments')
    .update({ status: 'completed' })
    .eq('id', deploymentId);
}
```

## Testing

### Unit Tests

**File:** `src/services/vercel-domain-lifecycle.service.test.ts`

**Coverage:**
- ✅ Add domain with verification requirements
- ✅ Add domain without verification
- ✅ Add domain failure (Vercel rejection)
- ✅ Add domain failure (network error)
- ✅ Apex domain DNS records (A + AAAA)
- ✅ Subdomain DNS records (CNAME)
- ✅ Verify domain and certificate (success)
- ✅ Verify domain not verified
- ✅ Verify certificate pending
- ✅ Verify certificate error
- ✅ Verify network error
- ✅ Remove domain with no aliases
- ✅ Remove domain with aliases cleaned up
- ✅ Remove domain failure
- ✅ Remove domain partial failure (alias cleanup error)
- ✅ Remove domain with no deployment IDs

**Run tests:**
```bash
npm test vercel-domain-lifecycle.service.test.ts
```

### Property-Based Tests

**File:** `src/services/vercel-custom-domain-configuration.property.test.ts`

**Property 27:** For any valid custom domain, the domain configuration flow must:
1. Issue a POST /v4/domains request with the correct domain name
2. Return a DnsConfiguration with ≥1 DNS record and ≥1 provider instruction
3. Apex domains receive A/AAAA records; subdomains receive CNAME

**Run property tests:**
```bash
npm test vercel-custom-domain-configuration.property.test.ts
```

## API Endpoints

### Add Custom Domain

**Endpoint:** `POST /api/deployments/:id/domains`

**Request:**
```json
{
  "domain": "app.example.com"
}
```

**Response:**
```json
{
  "success": true,
  "domain": "app.example.com",
  "dnsRecords": [
    {
      "type": "CNAME",
      "host": "app",
      "value": "cname.vercel-dns.com",
      "ttl": 3600
    }
  ],
  "providerInstructions": [
    {
      "provider": "Cloudflare",
      "steps": [
        "Log in to dash.cloudflare.com and select your domain.",
        "Go to DNS → Records → Add record.",
        "Add: CNAME app cname.vercel-dns.com (TTL: 3600s)",
        "Set Proxy status to 'DNS only' (grey cloud).",
        "Save and wait up to 5 minutes for propagation."
      ]
    }
  ]
}
```

### Verify Domain

**Endpoint:** `GET /api/deployments/:id/domains/:domain/verify`

**Response:**
```json
{
  "verified": true,
  "domain": "app.example.com",
  "certState": "active"
}
```

### Remove Domain

**Endpoint:** `DELETE /api/deployments/:id/domains/:domain`

**Response:**
```json
{
  "success": true,
  "domain": "app.example.com",
  "aliasesRemoved": 2
}
```

## DNS Provider Instructions

The system generates provider-specific instructions for:

- **Cloudflare** — Dashboard navigation, proxy settings
- **Namecheap** — Advanced DNS panel, record types
- **GoDaddy** — DNS Management, record format
- **AWS Route 53** — Hosted zone, record set creation

**Example (Cloudflare):**
```
1. Log in to dash.cloudflare.com and select your domain.
2. Go to DNS → Records → Add record.
3. Add: CNAME app cname.vercel-dns.com (TTL: 3600s)
4. Set Proxy status to "DNS only" (grey cloud) to avoid conflicts with Vercel.
5. Save and wait up to 5 minutes for propagation.
```

## Monitoring and Observability

### Logging

All operations log structured events:

```typescript
console.log('[domain-lifecycle] Adding domain', { domain, projectId });
console.log('[domain-lifecycle] Domain verified', { domain, certState: 'active' });
console.warn('[domain-lifecycle] Partial failure', { domain, reason });
console.error('[domain-lifecycle] Domain removal failed', { domain, error });
```

### Metrics to Track

- **Domain add success rate** — `addDomainWithDns` success vs failure
- **Verification time** — Time from add to verified
- **Certificate provisioning failures** — `certState: 'error'` count
- **Partial cleanup failures** — `partialFailure: true` count
- **Circuit breaker state changes** — CLOSED → OPEN transitions

### Alerting

**Critical:**
- Circuit breaker opens (Vercel API unavailable)
- Auth failures (invalid token)

**Warning:**
- Partial cleanup failures (orphaned aliases)
- Certificate provisioning errors (DNS misconfiguration)

**Info:**
- Rate limit hits (expected during high traffic)

## Troubleshooting

### Domain Not Verifying

**Symptom:** `verified: false` after DNS configuration

**Checks:**
1. Verify DNS records are correct:
   ```bash
   dig app.example.com CNAME
   dig example.com A
   ```
2. Check DNS propagation (can take 5-30 minutes)
3. Verify no conflicting records (multiple A records, incorrect CNAME target)
4. Check Vercel dashboard for verification requirements

### Certificate Provisioning Failed

**Symptom:** `certState: 'error'`

**Common causes:**
- DNS records not propagated
- CAA record blocking Let's Encrypt
- Domain already has a certificate elsewhere
- Rate limit on certificate issuance

**Resolution:**
1. Check `cert.error` message for specific reason
2. Verify DNS records are correct and propagated
3. Check CAA records: `dig example.com CAA`
4. Wait and retry (Let's Encrypt has rate limits)

### Partial Cleanup Failure

**Symptom:** `partialFailure: true` after domain removal

**Impact:** Domain is removed but some aliases may remain

**Resolution:**
1. Log the `partialFailureReason` for investigation
2. Retry cleanup with the same deployment IDs
3. Manually verify aliases in Vercel dashboard
4. Consider implementing a cleanup job for orphaned aliases

### Circuit Breaker Open

**Symptom:** All Vercel API calls fail immediately

**Cause:** Consecutive failures exceeded threshold (default: 5)

**Resolution:**
1. Check Vercel API status: https://www.vercel-status.com/
2. Verify `VERCEL_TOKEN` is valid
3. Wait for reset timeout (default: 30 seconds)
4. Circuit will automatically transition to HALF_OPEN and probe recovery

## Configuration

### Environment Variables

```bash
# Required
VERCEL_TOKEN=your_vercel_api_token

# Optional
VERCEL_TEAM_ID=team_abc123                # Team scope for projects
VERCEL_CB_FAILURE_THRESHOLD=5             # Circuit breaker threshold
VERCEL_CB_RESET_TIMEOUT_MS=30000          # Circuit breaker cooldown
```

### Token Scopes

Required Vercel token scopes:
- `projects:write` — Create and manage projects
- `deployments:write` — Trigger deployments
- `domains:write` — Add and remove domains
- `team` — Required when `VERCEL_TEAM_ID` is set

## Future Enhancements

### Planned Features

1. **Automated DNS Provider Integration**
   - Direct API integration with Cloudflare, Route 53, etc.
   - Automatic DNS record creation (no manual user steps)
   - DNS record verification before Vercel registration

2. **Domain Transfer Support**
   - Move domain from one project to another
   - Preserve aliases during transfer
   - Zero-downtime migration

3. **Multi-Domain Management**
   - Bulk domain operations
   - Domain groups (staging, production)
   - Shared DNS configuration templates

4. **Enhanced Monitoring**
   - Certificate expiry alerts
   - DNS propagation tracking
   - Historical verification metrics

### Not Planned

- **Automatic domain registration** — Users must own domains
- **DNS hosting** — Users manage DNS at their registrar
- **Custom certificate upload** — Vercel manages TLS automatically

## References

- **Vercel Domains API:** https://vercel.com/docs/rest-api/endpoints#domains
- **Vercel DNS Records:** https://vercel.com/docs/projects/domains/add-a-domain#dns-records
- **Circuit Breaker Pattern:** `src/lib/api/circuit-breaker.ts`
- **DNS Configuration:** `src/lib/dns/dns-configuration.ts`
- **Domain Verification:** `src/lib/dns/domain-verification.ts`

## Support

For issues or questions:
- **GitHub Issues:** Tag with `vercel`, `domains`, or `dns`
- **Code:** `src/services/vercel-domain-lifecycle.service.ts`
- **Tests:** `src/services/vercel-domain-lifecycle.service.test.ts`
- **Documentation:** This file

---

**Last Updated:** 2026-05-29  
**Issue:** #652  
**Status:** ✅ Implemented and Tested

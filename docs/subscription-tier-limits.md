# Subscription Tier Limits Reference

This document defines the deployment limits and feature access for each subscription tier in CRAFT.

## Tier Limits Matrix

| Tier       | Max Deployments | Max Custom Domains | Analytics | Support Level |
|------------|-----------------|-------------------|-----------|---------------|
| Free       | 1               | 0                 | No        | Community     |
| Starter    | 3               | 1                 | Yes       | Email         |
| Pro        | 10              | 5                 | Yes       | Priority      |
| Enterprise | Unlimited (-1)  | Unlimited (-1)    | Yes       | Dedicated     |

## Enforcement Rules

### Deployment Limits

- **Free Tier**: Users can create exactly 1 deployment. Attempting to create a 2nd deployment is rejected with `DEPLOYMENT_LIMIT_EXCEEDED`.
- **Starter Tier**: Users can create up to 3 deployments. The 4th attempt is rejected.
- **Pro Tier**: Users can create up to 10 deployments. The 11th attempt is rejected.
- **Enterprise Tier**: Unlimited deployments. All creation attempts succeed.

### Custom Domain Limits

- **Free Tier**: No custom domains allowed (0).
- **Starter Tier**: Up to 1 custom domain.
- **Pro Tier**: Up to 5 custom domains.
- **Enterprise Tier**: Unlimited custom domains.

### Feature Access

- **Analytics**: Available for Starter, Pro, and Enterprise tiers. Not available for Free tier.
- **Advanced Monitoring**: Available for Pro and Enterprise tiers.
- **Dedicated Support**: Available for Enterprise tier only.

## Tier Transitions

### Upgrade Scenarios

When a user upgrades from one tier to another:

1. **Free → Starter**: Existing 1 deployment remains accessible. User can now create up to 2 more (total 3).
2. **Free → Pro**: Existing 1 deployment remains. User can create up to 9 more (total 10).
3. **Starter → Pro**: Existing deployments (up to 3) remain. User can create up to 7 more (total 10).
4. **Any → Enterprise**: All existing deployments remain. Unlimited new deployments can be created.

### Downgrade Scenarios

When a user downgrades from one tier to another:

1. **Pro → Starter**: If user has more than 3 deployments, the excess deployments become inaccessible but are not deleted. User cannot create new deployments until count ≤ 3.
2. **Pro → Free**: If user has more than 1 deployment, excess deployments become inaccessible. User cannot create new deployments.
3. **Enterprise → Any**: Excess deployments beyond the new tier's limit become inaccessible.

**Important**: Downgrade does not delete deployments; it restricts access. Users can upgrade again to regain access.

## Implementation Notes

- Limit values are imported from `TIER_CONFIGS` in the pricing configuration.
- The value `-1` represents "unlimited" for a given limit.
- All limit checks are performed at deployment creation time.
- Limits are enforced at the API layer before any database writes occur.
- Subscription tier is determined from the user's `subscription_tier` field in the `profiles` table.

## Testing

Comprehensive permutation tests verify all tier × feature × limit combinations. See `subscription-tier-deployment-limits.property.test.ts` for test coverage.

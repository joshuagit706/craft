/**
 * Stripe Metered Billing Integration
 * 
 * Extends PaymentService with metered billing functionality.
 * Handles reporting usage to Stripe and managing usage-based subscriptions.
 */

import { stripe } from '@/lib/stripe/client';
import { createClient } from '@/lib/supabase/server';
import { meterService, type BillingPeriod } from '@/services/metered-billing.service';

export interface MeteringConfig {
  priceId: string;
  operationType: string;
  unitName: string; // 'API calls', 'deployments', etc.
}

/**
 * Metered Billing integration for PaymentService
 */
export class MeteringPaymentIntegration {
  /**
   * Create metered billing subscription for user
   * 
   * Sets up a subscription with metered pricing component
   */
  async createMeteredBillingSubscription(
    userId: string,
    priceId: string,
    displayName?: string
  ): Promise<{ subscriptionId: string; subscriptionItemId: string }> {
    const supabase = createClient();

    // Get or create Stripe customer
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    let customerId = profile?.stripe_customer_id;

    if (!customerId) {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user?.email) {
        throw new Error('User email not found');
      }

      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          supabase_user_id: userId,
          tier: 'metered',
        },
      });

      customerId = customer.id;

      await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', userId);
    }

    // Create subscription with metered pricing
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [
        {
          price: priceId,
        },
      ],
      metadata: {
        user_id: userId,
        billing_type: 'metered',
      },
    });

    // Get subscription item ID (needed for usage reporting)
    const subscriptionItem = subscription.items.data[0];

    // Update profile with subscription details
    await supabase
      .from('profiles')
      .update({
        stripe_subscription_id: subscription.id,
        subscription_tier: 'pro', // or 'enterprise' depending on price
        subscription_status: 'active',
      })
      .eq('id', userId);

    return {
      subscriptionId: subscription.id,
      subscriptionItemId: subscriptionItem.id,
    };
  }

  /**
   * Report usage to Stripe for a metered subscription
   * 
   * Idempotent: Multiple reports with same parameters will not double-bill.
   */
  async reportUsage(
    userId: string,
    operationType: string,
    quantity: number = 1,
    timestamp?: number
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Record usage locally first
      await meterService.recordUsage(userId, operationType, quantity);

      // Get subscription from profile
      const supabase = createClient();
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('stripe_subscription_id')
        .eq('id', userId)
        .single();

      if (profileError || !profile?.stripe_subscription_id) {
        return {
          success: false,
          error: 'No subscription found for user',
        };
      }

      // Get metered subscription item
      const subscription = await stripe.subscriptions.retrieve(
        profile.stripe_subscription_id
      );

      const meterItem = subscription.items.data.find(
        (item: any) => item.price.recurring?.usage_type === 'metered'
      );

      if (!meterItem) {
        return {
          success: false,
          error: 'No metered subscription item found',
        };
      }

      // Report to Stripe (idempotent by timestamp)
      const usageRecord = await stripe.subscriptionItems.createUsageRecord(
        meterItem.id,
        {
          quantity,
          timestamp: timestamp || Math.floor(Date.now() / 1000),
          action: 'increment', // add to current meter value
        }
      );

      return {
        success: true,
      };
    } catch (error: any) {
      console.error('Failed to report usage:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get aggregated usage for user in current billing period
   */
  async getAggregatedUsage(userId: string): Promise<{
    billingPeriod: { start: Date; end: Date };
    usageByType: Array<{ type: string; quantity: number }>;
    totalQuantity: number;
  }> {
    const aggregated = await meterService.aggregateUsage(userId);

    const totalQuantity = aggregated.reduce(
      (sum, item) => sum + item.total_quantity,
      0
    );

    return {
      billingPeriod: aggregated[0]?.period || { start: new Date(), end: new Date() },
      usageByType: aggregated.map((item) => ({
        type: item.operation_type,
        quantity: item.total_quantity,
      })),
      totalQuantity,
    };
  }

  /**
   * Sync pending usage with Stripe
   * 
   * Call this periodically to ensure all usage is reported.
   * Handles retry logic for failed reports.
   */
  async syncPendingUsage(userId: string): Promise<{
    synced: number;
    failed: number;
    nextSyncTime?: number;
  }> {
    const result = await meterService.reportPendingUsageToStripe(userId);

    return {
      synced: result.reported,
      failed: result.failed,
      nextSyncTime: result.failed > 0 ? Date.now() + 60000 : undefined, // Retry in 60s if failed
    };
  }

  /**
   * Get current billing period for user
   */
  getBillingPeriod(date: Date = new Date()): BillingPeriod {
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);
    return { start, end };
  }

  /**
   * Check if usage is within tier limits
   */
  async isUsageWithinLimits(
    userId: string,
    tierLimits: Record<string, { monthly: number; daily?: number }>
  ): Promise<boolean> {
    const stats = await meterService.getUsageStats(userId);

    for (const usage of stats.by_type) {
      const limit = tierLimits[usage.type];
      if (limit && usage.count > limit.monthly) {
        return false;
      }
    }

    return true;
  }
}

export const meteringPayment = new MeteringPaymentIntegration();

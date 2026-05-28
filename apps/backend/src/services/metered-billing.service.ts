/**
 * Stripe Metered Billing Integration
 * 
 * Handles usage tracking and metered billing for Stripe.
 * Tracks API operations and reports usage to Stripe for billing.
 */

import { stripe } from '@/lib/stripe/client';
import { createClient } from '@/lib/supabase/server';

export interface UsageRecord {
  id: string;
  user_id: string;
  operation_type: string; // 'api_call', 'deployment', 'domain_config', etc.
  quantity: number;
  metadata: Record<string, unknown>;
  stripe_usage_record_id?: string;
  reported_to_stripe: boolean;
  report_error?: string;
  created_at: string;
  reported_at?: string;
  billing_period_start: string;
  billing_period_end: string;
}

export interface BillingPeriod {
  start: Date;
  end: Date;
}

export interface UsageAggregation {
  user_id: string;
  operation_type: string;
  total_quantity: number;
  record_count: number;
  period: BillingPeriod;
}

/**
 * Stripe Metered Billing Service
 * 
 * Manages usage tracking and reporting to Stripe metered billing.
 * Ensures idempotent usage record creation and reporting.
 */
export class MeteringService {
  /**
   * Generate idempotency key for usage record
   * Format: operation_type-user_id-timestamp-hash
   * Prevents duplicate usage records within same second
   */
  private generateIdempotencyKey(
    userId: string,
    operationType: string,
    timestamp?: number
  ): string {
    const ts = timestamp || Date.now();
    const second = Math.floor(ts / 1000);
    return `${operationType}-${userId}-${second}`;
  }

  /**
   * Get current billing period
   * Returns the period for the current month
   */
  private getBillingPeriod(date: Date = new Date()): BillingPeriod {
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);
    return { start, end };
  }

  /**
   * Record API usage
   * 
   * Idempotent: Multiple calls with same operation_type/user_id within
   * same second will be deduplicated via idempotency key.
   */
  async recordUsage(
    userId: string,
    operationType: string,
    quantity: number = 1,
    metadata: Record<string, unknown> = {}
  ): Promise<UsageRecord> {
    const supabase = createClient();
    const now = new Date();
    const billingPeriod = this.getBillingPeriod(now);
    const idempotencyKey = this.generateIdempotencyKey(userId, operationType);

    // Insert or get existing record for this operation in this billing period
    const { data: existingRecords, error: fetchError } = await supabase
      .from('usage_records')
      .select('*')
      .eq('user_id', userId)
      .eq('operation_type', operationType)
      .eq('billing_period_start', billingPeriod.start.toISOString())
      .eq('idempotency_key', idempotencyKey)
      .single();

    // If record exists for this idempotency key, increment and return
    if (!fetchError && existingRecords) {
      const newQuantity = (existingRecords.quantity || 0) + quantity;

      const { data: updated } = await supabase
        .from('usage_records')
        .update({
          quantity: newQuantity,
          metadata: {
            ...existingRecords.metadata,
            ...metadata,
          },
        })
        .eq('id', existingRecords.id)
        .select()
        .single();

      return updated as UsageRecord;
    }

    // Create new usage record
    const { data: record, error: insertError } = await supabase
      .from('usage_records')
      .insert({
        user_id: userId,
        operation_type: operationType,
        quantity,
        metadata,
        billing_period_start: billingPeriod.start.toISOString(),
        billing_period_end: billingPeriod.end.toISOString(),
        idempotency_key: idempotencyKey,
        reported_to_stripe: false,
      })
      .select()
      .single();

    if (insertError) {
      throw new Error(`Failed to record usage: ${insertError.message}`);
    }

    return record as UsageRecord;
  }

  /**
   * Aggregate usage for a user within billing period
   */
  async aggregateUsage(
    userId: string,
    billingPeriod?: BillingPeriod
  ): Promise<UsageAggregation[]> {
    const supabase = createClient();
    const period = billingPeriod || this.getBillingPeriod();

    const { data: records, error } = await supabase
      .from('usage_records')
      .select('operation_type, quantity', { count: 'exact' })
      .eq('user_id', userId)
      .gte('created_at', period.start.toISOString())
      .lte('created_at', period.end.toISOString());

    if (error) {
      throw new Error(`Failed to aggregate usage: ${error.message}`);
    }

    // Group by operation type
    const aggregated = new Map<string, UsageAggregation>();

    (records || []).forEach((record: any) => {
      const key = record.operation_type;
      const existing = aggregated.get(key) || {
        user_id: userId,
        operation_type: key,
        total_quantity: 0,
        record_count: 0,
        period,
      };

      existing.total_quantity += record.quantity || 0;
      existing.record_count += 1;

      aggregated.set(key, existing);
    });

    return Array.from(aggregated.values());
  }

  /**
   * Report usage to Stripe metered billing
   * 
   * Idempotent: Uses subscription_item_id and timestamp combination
   * to prevent duplicate usage records in Stripe.
   */
  async reportUsageToStripe(
    userId: string,
    subscriptionItemId: string,
    quantity: number,
    operationType: string
  ): Promise<{ success: boolean; stripeRecordId?: string; error?: string }> {
    try {
      // Create usage record in Stripe
      // Stripe's metered billing is idempotent by design:
      // same timestamp + subscription_item_id will update the existing record
      const stripeRecord = await stripe.subscriptionItems.createUsageRecord(
        subscriptionItemId,
        {
          quantity,
          timestamp: Math.floor(Date.now() / 1000),
          action: 'set', // 'set' = set quantity; 'increment' = add to current
        }
      );

      // Update usage record in database
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from('usage_records')
        .update({
          stripe_usage_record_id: stripeRecord.id,
          reported_to_stripe: true,
          reported_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('operation_type', operationType);

      if (updateError) {
        console.warn(`Failed to update usage record: ${updateError.message}`);
      }

      return {
        success: true,
        stripeRecordId: stripeRecord.id,
      };
    } catch (error: any) {
      console.error('Failed to report usage to Stripe:', error);

      // Update usage record with error
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from('usage_records')
        .update({
          report_error: error.message,
        })
        .eq('user_id', userId)
        .eq('operation_type', operationType);

      if (updateError) {
        console.warn(`Failed to update error record: ${updateError.message}`);
      }

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Report all unreported usage for a user to Stripe
   * 
   * Handles retry logic for failed reports.
   * Safe to call multiple times - only reports unreported records.
   */
  async reportPendingUsageToStripe(userId: string): Promise<{
    reported: number;
    failed: number;
    errors: string[];
  }> {
    const supabase = createClient();

    // Get user's stripe subscription
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_subscription_id, stripe_customer_id')
      .eq('id', userId)
      .single();

    if (profileError || !profile?.stripe_subscription_id) {
      return {
        reported: 0,
        failed: 0,
        errors: ['No Stripe subscription found'],
      };
    }

    // Get pending usage records
    const { data: pendingRecords, error: fetchError } = await supabase
      .from('usage_records')
      .select('*')
      .eq('user_id', userId)
      .eq('reported_to_stripe', false)
      .is('stripe_usage_record_id', null);

    if (fetchError) {
      return {
        reported: 0,
        failed: 0,
        errors: [fetchError.message],
      };
    }

    // Get subscription items to find metering subscription item
    let subscriptionItemId: string | null = null;
    try {
      const subscription = await stripe.subscriptions.retrieve(
        profile.stripe_subscription_id
      );

      // Find the subscription item with metered usage
      const meterItem = subscription.items.data.find(
        (item: any) => item.price.recurring?.usage_type === 'metered'
      );

      if (meterItem) {
        subscriptionItemId = meterItem.id;
      }
    } catch (error) {
      console.error('Failed to retrieve subscription:', error);
      return {
        reported: 0,
        failed: 0,
        errors: ['Failed to retrieve Stripe subscription'],
      };
    }

    if (!subscriptionItemId) {
      // No metered subscription item found - not an error, just no billing
      return {
        reported: 0,
        failed: 0,
        errors: [],
      };
    }

    // Report each usage record
    let reported = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const record of pendingRecords || []) {
      const result = await this.reportUsageToStripe(
        userId,
        subscriptionItemId,
        record.quantity || 1,
        record.operation_type
      );

      if (result.success) {
        reported++;
      } else {
        failed++;
        errors.push(`${record.operation_type}: ${result.error}`);
      }
    }

    return {
      reported,
      failed,
      errors,
    };
  }

  /**
   * Reset usage records (usually at billing period end for reset billing)
   */
  async resetUsageForPeriod(billingPeriod: BillingPeriod): Promise<number> {
    const supabase = createClient();

    const { data, error } = await supabase
      .from('usage_records')
      .delete()
      .gte('billing_period_start', billingPeriod.start.toISOString())
      .lte('billing_period_end', billingPeriod.end.toISOString());

    if (error) {
      throw new Error(`Failed to reset usage: ${error.message}`);
    }

    return data?.length || 0;
  }

  /**
   * Get usage statistics for dashboard
   */
  async getUsageStats(
    userId: string,
    billingPeriod?: BillingPeriod
  ): Promise<{
    period: BillingPeriod;
    total_operations: number;
    by_type: Array<{ type: string; count: number }>;
    reported_to_stripe: number;
    pending_reporting: number;
  }> {
    const supabase = createClient();
    const period = billingPeriod || this.getBillingPeriod();

    const { data: records, error } = await supabase
      .from('usage_records')
      .select('operation_type, reported_to_stripe, quantity')
      .eq('user_id', userId)
      .gte('created_at', period.start.toISOString())
      .lte('created_at', period.end.toISOString());

    if (error) {
      throw new Error(`Failed to get usage stats: ${error.message}`);
    }

    let totalOps = 0;
    let reportedCount = 0;
    let pendingCount = 0;
    const byType = new Map<string, number>();

    (records || []).forEach((record: any) => {
      const qty = record.quantity || 0;
      totalOps += qty;

      const existing = byType.get(record.operation_type) || 0;
      byType.set(record.operation_type, existing + qty);

      if (record.reported_to_stripe) {
        reportedCount++;
      } else {
        pendingCount++;
      }
    });

    return {
      period,
      total_operations: totalOps,
      by_type: Array.from(byType.entries()).map(([type, count]) => ({
        type,
        count,
      })),
      reported_to_stripe: reportedCount,
      pending_reporting: pendingCount,
    };
  }
}

export const meterService = new MeteringService();

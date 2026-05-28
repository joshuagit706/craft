import { createClient } from '@/lib/supabase/server';
import { randomBytes } from 'crypto';

/**
 * Payment Idempotency Service
 *
 * Manages idempotency keys for Stripe payment operations to ensure
 * that retried operations do not create duplicate charges.
 *
 * Idempotency keys are stored in the database and include:
 * - Unique key per operation
 * - Stripe API response for caching
 * - Expiration time (24 hours)
 *
 * Usage:
 *   const key = await idempotencyService.generateKey(userId, 'checkout_session');
 *   const response = await stripe.checkout.sessions.create({...}, {idempotencyKey: key});
 *   await idempotencyService.storeResponse(key, response);
 */

export class PaymentIdempotencyService {
  /**
   * Generate a new idempotency key and store it in the database.
   * Returns the key to be used with Stripe API.
   */
  async generateKey(
    userId: string,
    operationType: 'checkout_session' | 'subscription' | 'cancel' | 'update'
  ): Promise<string> {
    const supabase = createClient();
    const key = this.generateRandomKey();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const { error } = await supabase
      .from('payment_idempotency_keys')
      .insert({
        user_id: userId,
        idempotency_key: key,
        operation_type: operationType,
        expires_at: expiresAt.toISOString(),
      });

    if (error) {
      throw new Error(`Failed to generate idempotency key: ${error.message}`);
    }

    return key;
  }

  /**
   * Retrieve an existing idempotency key and its cached response.
   * Returns null if the key doesn't exist or has expired.
   */
  async getKey(userId: string, key: string) {
    const supabase = createClient();

    const { data, error } = await supabase
      .from('payment_idempotency_keys')
      .select('*')
      .eq('user_id', userId)
      .eq('idempotency_key', key)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (error && error.code === 'PGRST116') {
      return null;
    }

    if (error) {
      throw new Error(`Failed to retrieve idempotency key: ${error.message}`);
    }

    return data;
  }

  /**
   * Store the Stripe API response for an idempotency key.
   * This allows retried requests to return the cached response.
   */
  async storeResponse(key: string, response: any): Promise<void> {
    const supabase = createClient();

    const { error } = await supabase
      .from('payment_idempotency_keys')
      .update({
        stripe_response: response,
      })
      .eq('idempotency_key', key);

    if (error) {
      throw new Error(`Failed to store idempotency response: ${error.message}`);
    }
  }

  /**
   * Clean up expired idempotency keys.
   * Should be called periodically (e.g., via cron job).
   */
  async cleanupExpiredKeys(): Promise<number> {
    const supabase = createClient();

    const { data, error } = await supabase
      .from('payment_idempotency_keys')
      .delete()
      .lt('expires_at', new Date().toISOString());

    if (error) {
      throw new Error(`Failed to cleanup idempotency keys: ${error.message}`);
    }

    return data?.length ?? 0;
  }

  /**
   * Generate a random idempotency key.
   * Format: idempotency_<random-hex>_<timestamp>
   */
  private generateRandomKey(): string {
    const randomPart = randomBytes(16).toString('hex');
    const timestamp = Date.now();
    return `idempotency_${randomPart}_${timestamp}`;
  }
}

export const paymentIdempotencyService = new PaymentIdempotencyService();

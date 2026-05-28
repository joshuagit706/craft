import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { withCronAuth } from '@/lib/api/cron-auth';

/**
 * Cron: purge expired GitHub tokens
 *
 * Nulls out github_token_encrypted and github_token_expires_at for any
 * profile whose token has passed its expiry.  This ensures expired tokens
 * are not retained in the database longer than necessary.
 *
 * Scheduled daily via vercel.json.  Protected by CRON_SECRET.
 *
 * Note: profiles with NULL github_token_expires_at (classic PATs with no
 * known expiry) are intentionally left untouched.
 */
async function handlePurge(req: NextRequest) {
    const supabase = createClient();

    const { error, count } = await supabase
        .from('profiles')
        .update({
            github_token_encrypted: null,
            github_token_expires_at: null,
            github_connected: false,
        })
        .lt('github_token_expires_at', new Date().toISOString())
        .not('github_token_expires_at', 'is', null);

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ purged: count ?? 0 });
}

export const GET = withCronAuth(handlePurge);

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

const mockSupabase = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn(),
    gt: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockReturnThis(),
};

const mockUser = { id: 'test-user' };

const mockDeployment = { user_id: 'test-user', id: 'test-deployment' };

describe('GET /api/deployments/[id]/logs/stream', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should initialize stream connection for authorized user', async () => {
        mockSupabase.single.mockResolvedValueOnce({
            data: mockDeployment,
            error: null,
        });

        const req = new NextRequest('http://localhost/api/deployments/test-id/logs/stream');

        const response = await GET(req, {
            params: { id: 'test-id' },
            user: mockUser,
            supabase: mockSupabase,
        } as any);

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        expect(response.headers.get('cache-control')).toBe('no-cache');
        expect(response.headers.get('connection')).toBe('keep-alive');
    });

    it('should return 404 for non-existent deployment', async () => {
        mockSupabase.single.mockResolvedValueOnce({
            data: null,
            error: null,
        });

        const req = new NextRequest('http://localhost/api/deployments/test-id/logs/stream');

        const response = await GET(req, {
            params: { id: 'test-id' },
            user: mockUser,
            supabase: mockSupabase,
        } as any);

        expect(response.status).toBe(404);
    });

    it('should return 404 for deployment not owned by user', async () => {
        mockSupabase.single.mockResolvedValueOnce({
            data: { user_id: 'other-user', id: 'test-deployment' },
            error: null,
        });

        const req = new NextRequest('http://localhost/api/deployments/test-id/logs/stream');

        const response = await GET(req, {
            params: { id: 'test-id' },
            user: mockUser,
            supabase: mockSupabase,
        } as any);

        expect(response.status).toBe(404);
    });

    it('should validate since parameter format', async () => {
        mockSupabase.single.mockResolvedValueOnce({
            data: mockDeployment,
            error: null,
        });

        const req = new NextRequest(
            'http://localhost/api/deployments/test-id/logs/stream?since=invalid-date',
        );

        const response = await GET(req, {
            params: { id: 'test-id' },
            user: mockUser,
            supabase: mockSupabase,
        } as any);

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('Invalid since parameter');
    });

    it('should accept valid ISO 8601 since parameter', async () => {
        mockSupabase.single.mockResolvedValueOnce({
            data: mockDeployment,
            error: null,
        });

        const isoDate = new Date().toISOString();
        const req = new NextRequest(
            `http://localhost/api/deployments/test-id/logs/stream?since=${encodeURIComponent(isoDate)}`,
        );

        const response = await GET(req, {
            params: { id: 'test-id' },
            user: mockUser,
            supabase: mockSupabase,
        } as any);

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream');
    });

    it('should set proper CORS headers', async () => {
        mockSupabase.single.mockResolvedValueOnce({
            data: mockDeployment,
            error: null,
        });

        const req = new NextRequest('http://localhost/api/deployments/test-id/logs/stream');

        const response = await GET(req, {
            params: { id: 'test-id' },
            user: mockUser,
            supabase: mockSupabase,
        } as any);

        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(response.headers.get('access-control-allow-methods')).toBe('GET');
        expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type');
    });

    it('should handle stream cancellation gracefully', async () => {
        mockSupabase.single.mockResolvedValueOnce({
            data: mockDeployment,
            error: null,
        });

        const req = new NextRequest('http://localhost/api/deployments/test-id/logs/stream');

        const response = await GET(req, {
            params: { id: 'test-id' },
            user: mockUser,
            supabase: mockSupabase,
        } as any);

        expect(response.status).toBe(200);

        // Simulate reading the stream
        const reader = response.body?.getReader();
        expect(reader).toBeDefined();

        // Cancel the stream
        await reader?.cancel();
    });
});

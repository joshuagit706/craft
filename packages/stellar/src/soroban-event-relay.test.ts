/**
 * Soroban Contract Event Subscription and WebSocket Relay Tests (#619)
 *
 * Tests event subscription, delivery to subscribers, subscriber cleanup on
 * disconnect, and per-subscriber filtering.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    SorobanEventRelay,
    MAX_SUBSCRIPTIONS_PER_CLIENT,
    ACK_TIMEOUT_MS,
    MAX_DELIVERY_ATTEMPTS,
    type SorobanEvent,
} from './soroban-event-relay';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONTRACT_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const CONTRACT_B = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4';

type CloseListener = () => void;

function makeMockWs(readyState = 1) {
    let closeListener: CloseListener = () => {};
    const ws = {
        readyState,
        send: vi.fn(),
        on: vi.fn().mockImplementation((event: string, listener: CloseListener) => {
            if (event === 'close') closeListener = listener;
        }),
        _triggerClose: () => closeListener(),
    };
    return ws;
}

function makeMockEvent(contractId: string, typeValue: string, ledger = 100) {
    return {
        contractId,
        ledger,
        topic: [{ value: () => typeValue }],
        value: { amount: '100' },
    };
}

function makeMockClient(events: ReturnType<typeof makeMockEvent>[] = [], latestLedger = 100) {
    return {
        getLatestLedger: vi.fn().mockResolvedValue({ sequence: latestLedger }),
        getEvents: vi.fn().mockResolvedValue({
            events,
            latestLedger,
        }),
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SorobanEventRelay – subscription management', () => {
    it('subscribes and tracks subscription count', () => {
        const ws = makeMockWs();
        const client = makeMockClient();
        const relay = new SorobanEventRelay(ws, client);

        relay.subscribe({ contractId: CONTRACT_A });
        expect(relay.subscriptionCount).toBe(1);
    });

    it('does not duplicate an existing subscription', () => {
        const ws = makeMockWs();
        const client = makeMockClient();
        const relay = new SorobanEventRelay(ws, client);

        relay.subscribe({ contractId: CONTRACT_A });
        relay.subscribe({ contractId: CONTRACT_A }); // duplicate
        expect(relay.subscriptionCount).toBe(1);
    });

    it('enforces the per-client subscription limit', () => {
        const ws = makeMockWs();
        const client = makeMockClient();
        const relay = new SorobanEventRelay(ws, client);

        for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CLIENT; i++) {
            relay.subscribe({ contractId: `C${'A'.repeat(54)}`, eventType: `event-${i}` });
        }

        const error = relay.subscribe({ contractId: CONTRACT_B, eventType: 'overflow' });
        expect(error).toContain('limit reached');
        expect(relay.subscriptionCount).toBe(MAX_SUBSCRIPTIONS_PER_CLIENT);
    });

    it('unsubscribes and decrements count', () => {
        const ws = makeMockWs();
        const client = makeMockClient();
        const relay = new SorobanEventRelay(ws, client);

        relay.subscribe({ contractId: CONTRACT_A });
        relay.unsubscribe({ contractId: CONTRACT_A });
        expect(relay.subscriptionCount).toBe(0);
    });
});

describe('SorobanEventRelay – event delivery', () => {
    it('delivers matching events to the WebSocket', async () => {
        const ws = makeMockWs();
        const events = [makeMockEvent(CONTRACT_A, 'transfer', 101)];
        const client = makeMockClient(events, 101);
        const relay = new SorobanEventRelay(ws, client);

        relay.subscribe({ contractId: CONTRACT_A });

        // Wait for the immediate async poll to settle.
        await new Promise((r) => setTimeout(r, 0));

        expect(ws.send).toHaveBeenCalledOnce();
        const sent = JSON.parse(ws.send.mock.calls[0][0]);
        expect(sent.contractId).toBe(CONTRACT_A);
        expect(sent.ledger).toBe(101);
    });

    it('filters events by eventType server-side', async () => {
        const ws = makeMockWs();
        const events = [
            makeMockEvent(CONTRACT_A, 'transfer', 101),
            makeMockEvent(CONTRACT_A, 'mint', 102),
        ];
        const client = makeMockClient(events, 102);
        const relay = new SorobanEventRelay(ws, client);

        relay.subscribe({ contractId: CONTRACT_A, eventType: 'transfer' });
        await new Promise((r) => setTimeout(r, 0));

        // Only the 'transfer' event should be sent.
        expect(ws.send).toHaveBeenCalledOnce();
        const sent = JSON.parse(ws.send.mock.calls[0][0]);
        expect(sent.ledger).toBe(101);
    });

    it('does not send events when WebSocket is closed', async () => {
        const ws = makeMockWs(3); // readyState 3 = CLOSED
        const events = [makeMockEvent(CONTRACT_A, 'transfer', 101)];
        const client = makeMockClient(events, 101);
        const relay = new SorobanEventRelay(ws, client);

        relay.subscribe({ contractId: CONTRACT_A });
        await new Promise((r) => setTimeout(r, 0));

        expect(ws.send).not.toHaveBeenCalled();
    });
});

describe('SorobanEventRelay – guaranteed delivery (#780)', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('includes an eventId in the delivered payload', async () => {
        const ws = makeMockWs();
        const events = [makeMockEvent(CONTRACT_A, 'transfer', 101)];
        const client = makeMockClient(events, 101);
        const relay = new SorobanEventRelay(ws, client);

        relay.subscribe({ contractId: CONTRACT_A });
        await new Promise(r => setTimeout(r, 0));

        expect(ws.send).toHaveBeenCalledOnce();
        const sent = JSON.parse(ws.send.mock.calls[0][0]) as SorobanEvent;
        expect(sent.eventId).toBeDefined();
        expect(typeof sent.eventId).toBe('string');
    });

    it('does not re-deliver an event after it has been acknowledged', async () => {
        vi.useFakeTimers();
        const ws = makeMockWs();
        const events = [makeMockEvent(CONTRACT_A, 'transfer', 101)];
        const client = makeMockClient(events, 101);
        const relay = new SorobanEventRelay(ws, client);

        relay.subscribe({ contractId: CONTRACT_A });
        // Flush the mock promise chain from the async poll (getLatestLedger + getEvents)
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(ws.send).toHaveBeenCalledOnce();
        const sent = JSON.parse(ws.send.mock.calls[0][0]) as SorobanEvent;

        relay.acknowledgeEvent(sent.eventId);
        vi.advanceTimersByTime(ACK_TIMEOUT_MS + 1);

        expect(ws.send).toHaveBeenCalledOnce();
    });

    it('re-delivers an event after the ACK timeout expires', async () => {
        vi.useFakeTimers();
        const ws = makeMockWs();
        const events = [makeMockEvent(CONTRACT_A, 'transfer', 101)];
        const client = makeMockClient(events, 101);
        const relay = new SorobanEventRelay(ws, client);

        relay.subscribe({ contractId: CONTRACT_A });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(ws.send).toHaveBeenCalledOnce();

        vi.advanceTimersByTime(ACK_TIMEOUT_MS + 1);

        expect(ws.send).toHaveBeenCalledTimes(2);
    });

    it(`moves an event to the dead-letter buffer after ${MAX_DELIVERY_ATTEMPTS} unACKed attempts`, async () => {
        vi.useFakeTimers();
        const ws = makeMockWs();
        const events = [makeMockEvent(CONTRACT_A, 'transfer', 101)];
        const client = makeMockClient(events, 101);
        const relay = new SorobanEventRelay(ws, client);

        relay.subscribe({ contractId: CONTRACT_A });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(ws.send).toHaveBeenCalledOnce();

        // Advance past the ACK timeout MAX_DELIVERY_ATTEMPTS times;
        // the 5th timeout fires, sees attempts === MAX, and routes to DLB
        for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
            vi.advanceTimersByTime(ACK_TIMEOUT_MS + 1);
        }

        expect(ws.send).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS);
        expect(relay.deadLetterBuffer).toHaveLength(1);
        expect(relay.deadLetterBuffer[0].contractId).toBe(CONTRACT_A);
    });

    it('re-delivered events carry the same eventId as the original delivery', async () => {
        vi.useFakeTimers();
        const ws = makeMockWs();
        const events = [makeMockEvent(CONTRACT_A, 'transfer', 101)];
        const client = makeMockClient(events, 101);
        const relay = new SorobanEventRelay(ws, client);

        relay.subscribe({ contractId: CONTRACT_A });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        const firstSent = JSON.parse(ws.send.mock.calls[0][0]) as SorobanEvent;

        vi.advanceTimersByTime(ACK_TIMEOUT_MS + 1);

        const secondSent = JSON.parse(ws.send.mock.calls[1][0]) as SorobanEvent;
        expect(secondSent.eventId).toBe(firstSent.eventId);
    });
});

describe('SorobanEventRelay – cleanup on disconnect', () => {
    it('cleans up all subscriptions when WebSocket closes', () => {
        const ws = makeMockWs();
        const client = makeMockClient();
        const relay = new SorobanEventRelay(ws, client);

        relay.subscribe({ contractId: CONTRACT_A });
        relay.subscribe({ contractId: CONTRACT_B });
        expect(relay.subscriptionCount).toBe(2);

        ws._triggerClose();
        expect(relay.subscriptionCount).toBe(0);
    });
});

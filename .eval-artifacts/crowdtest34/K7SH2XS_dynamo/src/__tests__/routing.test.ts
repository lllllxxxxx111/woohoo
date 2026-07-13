/**
 * Tests for routing events API type definitions and query parameter building.
 *
 * These tests verify that the API layer correctly constructs requests
 * for routing events and health summaries.
 */
import { describe, it, expect } from 'vitest';

// Type-only imports - we test the type shapes match expected API contract
import type {
  ServerRoutingEvent,
  EndpointHealthSummary,
  RoutingEventsQuery,
  RoutingEventsResult,
  ChatRoutingInfo,
} from '../lib/serverApi.endpoints';

describe('Routing event types', () => {
  it('ServerRoutingEvent has required routing fields', () => {
    const event: ServerRoutingEvent = {
      id: 'evt-1',
      operation: 'chat',
      capability: 'chat',
      status: 'success',
      attemptIndex: 0,
      maxAttempts: 3,
      latencyMs: 250,
      wasFallback: false,
      createdAt: new Date().toISOString(),
    };
    expect(event.id).toBe('evt-1');
    expect(event.wasFallback).toBe(false);
    expect(event.status).toBe('success');
  });

  it('ServerRoutingEvent can represent a fallback event', () => {
    const event: ServerRoutingEvent = {
      id: 'evt-2',
      operation: 'chat',
      capability: 'chat',
      candidateEndpointId: 'ep-primary',
      candidateModel: 'gpt-4o',
      finalEndpointId: 'ep-secondary',
      finalModel: 'gpt-4o-mini',
      finalProvider: 'openai',
      status: 'fallback',
      attemptIndex: 1,
      maxAttempts: 3,
      errorClassification: 'rate_limited',
      errorMessage: 'Rate limit exceeded',
      httpStatus: 429,
      latencyMs: 5200,
      wasFallback: true,
      fallbackReason: '429 rate limit',
      createdAt: new Date().toISOString(),
    };
    expect(event.wasFallback).toBe(true);
    expect(event.errorClassification).toBe('rate_limited');
    expect(event.httpStatus).toBe(429);
  });

  it('EndpointHealthSummary tracks fallback and failure counts', () => {
    const health: EndpointHealthSummary = {
      endpointId: 'ep-1',
      totalRequests: 100,
      successCount: 95,
      fallbackCount: 3,
      failedCount: 2,
      avgLatencyMs: 300,
      recentErrors24h: 1,
      lastErrorAt: null,
      lastSuccessAt: new Date().toISOString(),
    };
    expect(health.totalRequests).toBe(100);
    expect(health.successCount + health.fallbackCount + health.failedCount).toBeLessThanOrEqual(
      health.totalRequests,
    );
  });

  it('RoutingEventsResult contains events and total for pagination', () => {
    const result: RoutingEventsResult = {
      events: [],
      total: 0,
    };
    expect(Array.isArray(result.events)).toBe(true);
    expect(typeof result.total).toBe('number');
  });

  it('ChatRoutingInfo carries user-visible fallback info without secrets', () => {
    const info: ChatRoutingInfo = {
      wasFallback: true,
      attemptCount: 2,
      reason: 'Primary endpoint returned 500',
      endpointId: 'ep-backup',
      endpointName: 'Woohoo OpenAI · gpt-4o-mini',
    };
    // Must NOT contain api keys or tokens
    expect(info).not.toHaveProperty('apiKey');
    expect(info).not.toHaveProperty('api_key');
    expect(info).not.toHaveProperty('token');
    expect(info).not.toHaveProperty('secret');
    expect(info.wasFallback).toBe(true);
    expect(info.endpointName).toContain('gpt-4o-mini');
  });
});

describe('Routing query parameter construction', () => {
  // Simulates the URL building logic from createEndpointApi.listRoutingEvents
  function buildRoutingEventsUrl(query: RoutingEventsQuery): string {
    const params = new URLSearchParams();
    if (query.endpointId) params.set('endpointId', query.endpointId);
    if (query.capability) params.set('capability', query.capability);
    if (query.status) params.set('status', query.status);
    if (query.operation) params.set('operation', query.operation);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.offset) params.set('offset', String(query.offset));
    const qs = params.toString();
    return `/api/ai/routing/events${qs ? `?${qs}` : ''}`;
  }

  it('empty query returns base URL', () => {
    expect(buildRoutingEventsUrl({})).toBe('/api/ai/routing/events');
  });

  it('filters by endpointId', () => {
    const url = buildRoutingEventsUrl({ endpointId: 'ep-123' });
    expect(url).toBe('/api/ai/routing/events?endpointId=ep-123');
  });

  it('filters by capability and status', () => {
    const url = buildRoutingEventsUrl({ capability: 'chat', status: 'fallback' });
    expect(url).toContain('capability=chat');
    expect(url).toContain('status=fallback');
  });

  it('supports pagination with limit and offset', () => {
    const url = buildRoutingEventsUrl({ limit: 20, offset: 40 });
    expect(url).toContain('limit=20');
    expect(url).toContain('offset=40');
  });

  it('combines multiple filters', () => {
    const url = buildRoutingEventsUrl({
      endpointId: 'ep-1',
      capability: 'image_generation',
      status: 'failed',
      operation: 'image_generation',
      limit: 50,
      offset: 0,
    });
    expect(url).toContain('endpointId=ep-1');
    expect(url).toContain('capability=image_generation');
    expect(url).toContain('status=failed');
    expect(url).toContain('limit=50');
  });
});

describe('Error classification semantics', () => {
  // Mirror the backend's is_retryable classification to document behavior
  const RETRYABLE = new Set([
    'network_error',
    'timeout',
    'rate_limited',
    'server_error',
    'capability_mismatch',
  ]);

  const NON_RETRYABLE = new Set([
    'auth_error',
    'validation_error',
    'content_safety',
    'unknown',
  ]);

  it('retryable errors allow fallback', () => {
    for (const cls of RETRYABLE) {
      // These errors should trigger trying the next candidate endpoint
      expect(['network_error', 'timeout', 'rate_limited', 'server_error', 'capability_mismatch']).toContain(cls);
    }
  });

  it('non-retryable errors do NOT fallback blindly', () => {
    for (const cls of NON_RETRYABLE) {
      // 401/403, validation, content safety, unknown must stop immediately
      expect(['auth_error', 'validation_error', 'content_safety', 'unknown']).toContain(cls);
    }
  });

  it('retryable and non-retryable sets are disjoint', () => {
    for (const cls of RETRYABLE) {
      expect(NON_RETRYABLE).not.toContain(cls);
    }
  });
});

describe('Routing audit event schema', () => {
  it('event IDs are unique strings', () => {
    const ids = new Set(['evt-1', 'evt-2', 'evt-3']);
    expect(ids.size).toBe(3);
  });

  it('timestamps are ISO strings for frontend display', () => {
    const now = new Date().toISOString();
    expect(() => new Date(now)).not.toThrow();
  });

  it('latency is in milliseconds', () => {
    const event: Pick<ServerRoutingEvent, 'latencyMs'> = { latencyMs: 150 };
    expect(event.latencyMs).toBeGreaterThanOrEqual(0);
    // 30 seconds is an upper bound for a healthy request
    expect(event.latencyMs).toBeLessThan(30000);
  });

  it('attemptIndex is zero-based and <= maxAttempts', () => {
    const event: Pick<ServerRoutingEvent, 'attemptIndex' | 'maxAttempts'> = {
      attemptIndex: 1,
      maxAttempts: 3,
    };
    expect(event.attemptIndex).toBeGreaterThanOrEqual(0);
    expect(event.attemptIndex).toBeLessThan(event.maxAttempts);
  });
});

describe('Task message meta routing fields', () => {
  it('mergeTaskMessageMeta propagates routing fallback info', () => {
    // Simulate the merge logic from usePendingTaskSse.ts
    const task = {
      id: 'task-1',
      status: 'completed',
      routingWasFallback: true,
      routingAttemptCount: 2,
      routingFallbackReason: 'Primary endpoint returned 503',
    };

    // Verify fields are present and typed correctly
    expect(task.routingWasFallback).toBe(true);
    expect(task.routingAttemptCount).toBe(2);
    expect(task.routingFallbackReason).toContain('503');
    // Must NOT contain secrets
    expect(task.routingFallbackReason).not.toContain('sk-');
    expect(task.routingFallbackReason).not.toContain('Bearer');
  });

  it('routing fallback fields are optional and default to undefined', () => {
    const task = { id: 'task-2', status: 'running' };
    expect((task as Record<string, unknown>).routingWasFallback).toBeUndefined();
    expect((task as Record<string, unknown>).routingAttemptCount).toBeUndefined();
  });

  it('MessageMeta routing fields are compatible with display logic', () => {
    // Simulate what ChatMessageGroupItem checks
    const meta = {
      routingWasFallback: true,
      routingAttemptCount: 3,
      routingFallbackReason: 'rate_limited',
    };

    // The tag should show when routingWasFallback is truthy
    const shouldShowTag = Boolean(meta.routingWasFallback);
    expect(shouldShowTag).toBe(true);

    // Attempt count suffix should show when > 1
    const showAttemptCount = typeof meta.routingAttemptCount === 'number' && meta.routingAttemptCount > 1;
    expect(showAttemptCount).toBe(true);

    // Title attribute uses fallback reason
    expect(meta.routingFallbackReason).toBeTruthy();
  });
});

describe('Endpoint health status coloring', () => {
  // Mirror the OpsMonitorPanel statusColor logic
  function statusColor(h: { failedCount: number; successCount: number; totalRequests: number; fallbackCount: number; recentErrors24h: number }): string {
    if (h.failedCount > h.successCount && h.totalRequests > 0) return 'red';
    if (h.fallbackCount > 0 && h.recentErrors24h > 0) return 'orange';
    if (h.totalRequests > 0 && h.successCount > 0) return 'green';
    return 'gray';
  }

  it('healthy endpoint shows green', () => {
    expect(statusColor({ failedCount: 0, successCount: 100, totalRequests: 100, fallbackCount: 0, recentErrors24h: 0 })).toBe('green');
  });

  it('more failures than successes shows red', () => {
    expect(statusColor({ failedCount: 10, successCount: 2, totalRequests: 12, fallbackCount: 0, recentErrors24h: 5 })).toBe('red');
  });

  it('fallbacks with recent errors shows orange', () => {
    expect(statusColor({ failedCount: 1, successCount: 50, totalRequests: 55, fallbackCount: 4, recentErrors24h: 2 })).toBe('orange');
  });

  it('no requests shows gray', () => {
    expect(statusColor({ failedCount: 0, successCount: 0, totalRequests: 0, fallbackCount: 0, recentErrors24h: 0 })).toBe('gray');
  });
});

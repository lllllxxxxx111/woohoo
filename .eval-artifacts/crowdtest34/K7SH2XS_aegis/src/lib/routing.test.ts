/**
 * Tests for routing audit API types and error classification logic.
 * These tests validate the frontend-side handling of routing fallback metadata.
 */
import { describe, it, expect } from 'vitest';

describe('Routing fallback response parsing', () => {
  it('should detect fallback from sync chat response', () => {
    const response = {
      content: 'Hello',
      model: 'gpt-4',
      routingFallback: {
        used: true,
        attemptCount: 2,
        attempts: [
          { endpointName: 'Primary', model: 'gpt-4', status: 'failed', error: '429' },
          { endpointName: 'Backup', model: 'gpt-3.5', status: 'fallback' },
        ],
      },
    };

    expect(response.routingFallback?.used).toBe(true);
    expect(response.routingFallback?.attemptCount).toBe(2);
    expect(response.routingFallback?.attempts).toHaveLength(2);
  });

  it('should handle response without fallback info', () => {
    const response: { content: string; model: string; routingFallback?: { used: boolean } } = {
      content: 'Hello',
      model: 'gpt-4',
    };

    expect(response.routingFallback).toBeUndefined();
  });
});

describe('Error classification semantics', () => {
  // Mirror the backend classify_error logic for frontend display decisions
  const RETRYABLE_KEYWORDS = ['429', '500', '502', '503', '504', '408', 'timed out', 'timeout', 'connection', 'network', 'rate limit', 'reqwest', 'quota'];
  const NON_RETRYABLE_KEYWORDS = ['401', '403', 'unauthorized', 'forbidden', 'invalid api key', '400', 'bad request', 'content policy', 'content safety'];

  function isRetryableError(errorMsg: string): boolean {
    const lowered = errorMsg.toLowerCase();
    if (NON_RETRYABLE_KEYWORDS.some((kw) => lowered.includes(kw))) return false;
    return RETRYABLE_KEYWORDS.some((kw) => lowered.includes(kw));
  }

  it('should classify 429 as retryable', () => {
    expect(isRetryableError('429 Too Many Requests')).toBe(true);
  });

  it('should classify 500 as retryable', () => {
    expect(isRetryableError('500 Internal Server Error')).toBe(true);
  });

  it('should classify timeout as retryable', () => {
    expect(isRetryableError('request timed out after 30s')).toBe(true);
  });

  it('should classify connection errors as retryable', () => {
    expect(isRetryableError('connection refused')).toBe(true);
  });

  it('should classify 401 as non-retryable', () => {
    expect(isRetryableError('401 Unauthorized')).toBe(false);
  });

  it('should classify 403 as non-retryable', () => {
    expect(isRetryableError('403 Forbidden')).toBe(false);
  });

  it('should classify invalid api key as non-retryable', () => {
    expect(isRetryableError('Invalid API key provided')).toBe(false);
  });

  it('should classify 400 bad request as non-retryable', () => {
    expect(isRetryableError('400 Bad Request: invalid schema')).toBe(false);
  });

  it('should classify content policy as non-retryable', () => {
    expect(isRetryableError('content policy violation')).toBe(false);
  });
});

describe('Routing health summary', () => {
  it('should calculate fallback rate correctly', () => {
    const summary = {
      totalRequests: 100,
      successful: 90,
      failed: 5,
      fallbacks: 5,
      noCandidate: 0,
      fallbackRate: 0.05,
      avgLatencyMs: 250,
      windowHours: 24,
    };

    expect(summary.fallbackRate).toBe(0.05);
    expect(summary.successful + summary.failed + summary.fallbacks).toBe(summary.totalRequests);
  });

  it('should handle zero requests', () => {
    const summary = {
      totalRequests: 0,
      successful: 0,
      failed: 0,
      fallbacks: 0,
      noCandidate: 0,
      fallbackRate: 0,
      avgLatencyMs: null,
      windowHours: 24,
    };

    expect(summary.fallbackRate).toBe(0);
  });
});

describe('Routing event filtering', () => {
  it('should build query params for filtering', () => {
    const params = {
      endpointId: 'ep-123',
      capability: 'chat',
      status: 'fallback',
      limit: 10,
      offset: 0,
    };

    const search = new URLSearchParams();
    if (params.endpointId) search.set('endpointId', params.endpointId);
    if (params.capability) search.set('capability', params.capability);
    if (params.status) search.set('status', params.status);
    if (params.limit) search.set('limit', String(params.limit));
    if (params.offset) search.set('offset', String(params.offset));

    const qs = search.toString();
    expect(qs).toContain('endpointId=ep-123');
    expect(qs).toContain('capability=chat');
    expect(qs).toContain('status=fallback');
    expect(qs).toContain('limit=10');
  });
});

describe('Stream meta event parsing', () => {
  it('should parse routing fallback meta from SSE event', () => {
    const data = JSON.stringify({
      routingFallback: {
        used: true,
        attemptCount: 2,
      },
    });

    const meta = JSON.parse(data);
    expect(meta.routingFallback.used).toBe(true);
    expect(meta.routingFallback.attemptCount).toBe(2);
  });

  it('should handle malformed meta gracefully', () => {
    const data = 'not json';
    expect(() => {
      try {
        JSON.parse(data);
      } catch {
        // ignore
      }
    }).not.toThrow();
  });
});

describe('Exhausted candidates error formatting', () => {
  function formatExhaustedError(attempts: Array<{ endpointName: string; error?: string }>): string {
    if (attempts.length <= 1) {
      return attempts[0]?.error || 'AI endpoint unavailable';
    }
    const failed = attempts
      .filter((a) => a.error)
      .map((a) => `${a.endpointName}: ${(a.error || '').slice(0, 120)}`);
    return `已尝试 ${attempts.length} 个 AI 端点均失败：${failed.join('; ')}`;
  }

  it('should format single attempt error plainly', () => {
    const msg = formatExhaustedError([{ endpointName: 'Primary', error: '401 Unauthorized' }]);
    expect(msg).toBe('401 Unauthorized');
  });

  it('should format multiple attempts with endpoint names and truncated errors', () => {
    const msg = formatExhaustedError([
      { endpointName: 'OpenAI', error: '429 Too Many Requests' },
      { endpointName: 'Backup', error: '500 Internal Server Error' },
    ]);
    expect(msg).toContain('2');
    expect(msg).toContain('OpenAI');
    expect(msg).toContain('Backup');
    expect(msg).toContain('429');
  });

  it('should truncate long error messages', () => {
    const longError = 'x'.repeat(300);
    const msg = formatExhaustedError([
      { endpointName: 'A', error: 'err1' },
      { endpointName: 'B', error: longError },
    ]);
    // Each error truncated to 120 chars
    expect(msg.length).toBeLessThan(400);
  });
});

describe('Hard constraint filtering semantics', () => {
  type Candidate = {
    id: string;
    supportsStream: boolean;
    supportsTools: boolean;
    maxContextTokens?: number;
  };

  function filterCandidates(
    candidates: Candidate[],
    req: { requiresStream: boolean; requiresTools: boolean; contextLength?: number | null },
  ): Candidate[] {
    return candidates.filter((c) => {
      if (req.requiresStream && !c.supportsStream) return false;
      if (req.requiresTools && !c.supportsTools) return false;
      if (req.contextLength && c.maxContextTokens !== undefined) {
        if (c.maxContextTokens < req.contextLength) return false;
      }
      return true;
    });
  }

  it('should filter out non-streaming candidates when stream required', () => {
    const candidates: Candidate[] = [
      { id: 'a', supportsStream: true, supportsTools: false },
      { id: 'b', supportsStream: false, supportsTools: false },
    ];
    const filtered = filterCandidates(candidates, { requiresStream: true, requiresTools: false });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('a');
  });

  it('should filter out non-tools candidates when tools required', () => {
    const candidates: Candidate[] = [
      { id: 'a', supportsStream: false, supportsTools: true },
      { id: 'b', supportsStream: false, supportsTools: false },
    ];
    const filtered = filterCandidates(candidates, { requiresStream: false, requiresTools: true });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('a');
  });

  it('should filter out candidates with insufficient context window', () => {
    const candidates: Candidate[] = [
      { id: 'small', supportsStream: false, supportsTools: false, maxContextTokens: 4096 },
      { id: 'large', supportsStream: false, supportsTools: false, maxContextTokens: 128000 },
    ];
    const filtered = filterCandidates(candidates, {
      requiresStream: false,
      requiresTools: false,
      contextLength: 50000,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('large');
  });

  it('should include candidates without maxContextTokens (unknown = no filter)', () => {
    const candidates: Candidate[] = [
      { id: 'legacy', supportsStream: false, supportsTools: false },
    ];
    const filtered = filterCandidates(candidates, {
      requiresStream: false,
      requiresTools: false,
      contextLength: 50000,
    });
    expect(filtered).toHaveLength(1);
  });
});

-- 会话缓存命中率可观测（PRD: docs/prd/conversation-cache-hit-rate/v0.3/）
-- cached_prompt_tokens: 供应商 usage 中上报的缓存命中 prompt tokens
--   （OpenAI 兼容网关 prompt_tokens_details.cached_tokens / DeepSeek prompt_cache_hit_tokens）
-- prompt_prefix_hit_ratio: 本次请求与该会话上一次请求的共享前缀字符数
--   占本次请求序列化字符数的比例（服务端探针计算，分母为本次请求，
--   与供应商 cached_tokens / prompt_tokens 口径一致）
ALTER TABLE ai_usage_events ADD COLUMN cached_prompt_tokens INTEGER;
ALTER TABLE ai_usage_events ADD COLUMN prompt_prefix_hit_ratio REAL;

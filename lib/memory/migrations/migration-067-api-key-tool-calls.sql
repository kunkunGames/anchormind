-- migration-067-api-key-tool-calls.sql
--
-- 작성자: 최진호
-- 작성일: 2026-10-12
--
-- api_key_usage.call_count는 인증된 HTTP 요청마다 늘어 MCP 접속, 도구 목록 조회, 스트림 재연결까지 센다.
-- 키가 실제로 기억 도구를 썼는지 보려면 도구 호출만 따로 세야 한다.
--
--   tool_call_count  그날 tools/call 수(등록된 도구 이름만, 권한 거부 포함)
--   tool_calls       도구 이름별 그날 호출 수 {"recall": 12, "remember": 3}
--
-- call_count와 일일 한도(daily_limit) 판정은 바뀌지 않는다.
-- 멱등: ADD COLUMN IF NOT EXISTS

ALTER TABLE agent_memory.api_key_usage
    ADD COLUMN IF NOT EXISTS tool_call_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tool_calls      JSONB   NOT NULL DEFAULT '{}'::jsonb;

-- migration-065-fragment-world-time.sql
--
-- 작성자: 최진호
-- 작성일: 2026-10-12
--
-- 파편에 세계 시각 열을 더한다. created_at과 valid_from은 서버가 기록하고 유효로 본 시스템 시각이다.
-- 과거 대화를 가져오거나 지난 일을 말한 기억은 시스템 시각과 실제 시각이 다르다.
--
--   mention_time          그 내용을 말하거나 관찰한 시각. 클라이언트가 준다(remember의 mentionTime)
--   event_time            내용이 가리키는 사건의 시작 시각. 클라이언트가 주거나 본문의 날짜 표현에서 뽑는다
--   event_time_end        사건이 구간이면 끝 시각(배타 상한)
--   event_time_precision  event_time의 정밀도(minute, day, week, month, year)
--
-- 모두 nullable이며 기존 행은 백필하지 않는다. 읽는 쪽은 event_time, mention_time, created_at 순으로 대체한다.
-- 색인은 대형 표 규약에 따라 scripts/ops/index-manifest.json에 등록하고 online-index.mjs로 먼저 만든다.

SET LOCAL lock_timeout = '3s';

ALTER TABLE agent_memory.fragments
    ADD COLUMN IF NOT EXISTS mention_time         TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS event_time           TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS event_time_end       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS event_time_precision TEXT;

-- timeRange basis=event 조회용. 식은 lib/memory/WorldTime.js의 worldTimeSql과 같아야 색인을 탄다.
CREATE INDEX IF NOT EXISTS idx_fragments_world_time
    ON agent_memory.fragments ((COALESCE(event_time, mention_time, created_at)))
    WHERE valid_to IS NULL;

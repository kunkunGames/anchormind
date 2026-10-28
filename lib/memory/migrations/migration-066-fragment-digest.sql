-- migration-066-fragment-digest.sql
--
-- 작성자: 최진호
-- 작성일: 2026-10-12
--
-- fragment_digest: 여러 파편을 한 번에 읽는 파생 요약 표. 정리 주기(build_digests)가 규칙으로 만든다(LLM 없음).
--   topic_timeline      키, workspace, agent, topic별로 유효 파편을 세계 시각순 한 줄씩 늘어놓은 시간선
--   preference_profile  키, workspace, agent별 preference 파편을 말한 시각 역순으로 모은 선호 목록
--
-- fragments와 분리한 이유는 fragment_segment와 같다. QuotaChecker가 fragments 행 수로 fragment_limit을
-- 판정하므로 같은 표에 넣으면 사용자 할당량을 잠식하고, 요약은 언제든 다시 만들 수 있는 파생 자료다.
--
-- source_ids는 요약에 들어간 파편 id다. 읽는 쪽은 출처가 하나라도 유효하지 않으면 그 요약을 쓰지 않고,
-- forget의 삭제 연쇄는 지운 파편을 출처로 가진 요약을 같은 트랜잭션에서 지운다(본문 사본 제거).
-- source_hash는 출처 id와 content_hash로 만든 값이며 같으면 다시 쓰지 않는다.
--
-- 멱등: CREATE TABLE / INDEX IF NOT EXISTS

CREATE TABLE IF NOT EXISTS agent_memory.fragment_digest (
    id           BIGSERIAL   PRIMARY KEY,
    key_id       TEXT,
    workspace    TEXT,
    agent_id     TEXT        NOT NULL DEFAULT 'default',
    kind         TEXT        NOT NULL CHECK (kind IN ('topic_timeline', 'preference_profile')),
    subject      TEXT        NOT NULL,
    content      TEXT        NOT NULL,
    source_ids   TEXT[]      NOT NULL,
    source_hash  TEXT        NOT NULL,
    item_count   INTEGER     NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fragment_digest_scope
    ON agent_memory.fragment_digest (COALESCE(key_id, ''), COALESCE(workspace, ''), agent_id, kind, subject);

CREATE INDEX IF NOT EXISTS idx_fragment_digest_sources
    ON agent_memory.fragment_digest USING gin (source_ids);

ALTER TABLE agent_memory.fragment_digest ENABLE ROW LEVEL SECURITY;

-- fragments와 같은 에이전트와 키 격리 규약을 적용한다.
DROP POLICY IF EXISTS fdigest_isolation_policy ON agent_memory.fragment_digest;
CREATE POLICY fdigest_isolation_policy ON agent_memory.fragment_digest
    USING (
        (
            agent_id = current_setting('app.current_agent_id', true)
            OR agent_id = 'default'
            OR current_setting('app.current_agent_id', true) IN ('system', 'admin')
        )
        AND (
            COALESCE(current_setting('app.current_key_id', true), '') = ''
            OR key_id IS NOT DISTINCT FROM current_setting('app.current_key_id', true)
            OR current_setting('app.current_agent_id', true) IN ('system', 'admin')
        )
    );

COMMENT ON TABLE agent_memory.fragment_digest
  IS '여러 파편을 모은 파생 요약(topic 시간선, 선호 목록). 정리 주기가 규칙으로 다시 만든다.';

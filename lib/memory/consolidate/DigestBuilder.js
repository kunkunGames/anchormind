/**
 * DigestBuilder - 파편 묶음 요약(fragment_digest)을 규칙으로 만드는 정리 단계
 *
 * 작성자: 최진호
 * 작성일: 2026-10-12
 *
 * 여러 세션에 흩어진 기록을 모아야 하는 질문(집계, 순서, 선호)은 검색 상위 k개만으로 근거가 다 모이지
 * 않는다. 정리 주기(build_digests)가 두 가지 요약을 만들어 fragment_digest(migration-066)에 둔다.
 * LLM을 부르지 않으며 원문 한 줄씩을 그대로 늘어놓는다.
 *
 *   topic_timeline      키, workspace, agent, topic별 유효 파편이 DIGEST_MIN_ITEMS개 이상인 묶음. 세계 시각이 늦은
 *                       TIMELINE_MAX_ITEMS개를 세계 시각 오름차순으로 "날짜 | 유형 | 본문 앞부분" 한 줄씩 쓴다
 *   preference_profile  키, workspace, agent별 preference 파편이 2개 이상인 묶음. 말한 시각 역순으로
 *                       PROFILE_MAX_ITEMS개를 "날짜 | 본문" 한 줄씩 쓴다
 *
 * 대상에서 빼는 파편: 닫힌 파편, 작업 기억 행, 모순 해소 기록 topic, 검토 대기와 거절 파편, 신뢰 등급 1 이하.
 * 출처 id와 content_hash로 만든 source_hash가 같으면 다시 쓰지 않는다. 이번 주기에 다시 쓰지 않았고 출처가
 * 하나라도 유효하지 않은 요약은 지운다. 한 주기에 다루는 묶음 수는 최근 활동 순으로 DIGEST_GROUP_LIMIT개다.
 */

import crypto                        from "node:crypto";
import { queryWithAgentVector }      from "../../tools/db.js";
import { SCHEMA }                    from "../schema.js";
import { CONTRADICTION_AUDIT_TOPIC } from "../write/ForgetCascade.js";
import { notWorkingMemoryRow }       from "../WorkingMemorySql.js";
import { formatEventTime, worldTimeMs, statedAtMs } from "../WorldTime.js";
import { digestEnabled }         from "../../config.js";

export const DIGEST_MIN_ITEMS    = 5;
export const TIMELINE_MAX_ITEMS  = 40;
export const PROFILE_MAX_ITEMS   = 30;
export const DIGEST_GROUP_LIMIT  = 200;
export const DIGEST_LINE_CHARS   = 140;
export const DIGEST_MAX_CHARS    = 6000;

/** 요약 대상 파편 조건(별칭 f) */
const ELIGIBLE = `f.valid_to IS NULL
       AND ${notWorkingMemoryRow("f")}
       AND f.topic IS DISTINCT FROM '${CONTRADICTION_AUDIT_TOPIC}'
       AND (f.review_state IS NULL OR f.review_state NOT IN ('pending', 'rejected'))
       AND (f.trust_tier IS NULL OR f.trust_tier >= 2)`;

/** 묶음 열쇠가 같은 파편 조건. $1 key_id, $2 workspace, $3 agent_id */
const SAME_SCOPE = `f.key_id IS NOT DISTINCT FROM $1
       AND f.workspace IS NOT DISTINCT FROM $2
       AND f.agent_id = $3`;

/**
 * 본문 한 줄. 줄바꿈과 연속 공백을 하나로 줄이고 max자에서 자른다.
 *
 * @param {string} content
 * @param {number} max
 * @returns {string}
 */
export function digestLine(content, max = DIGEST_LINE_CHARS) {
  const flat = String(content ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/**
 * 출처 id와 content_hash로 만든 해시.
 *
 * @param {Array<{id: string, content_hash?: string}>} rows
 * @returns {string}
 */
export function sourceHash(rows) {
  const material = rows.map(r => `${r.id}:${r.content_hash ?? ""}`).sort().join("|");
  return crypto.createHash("sha256").update(material).digest("hex");
}

/**
 * topic 시간선 본문. 세계 시각 오름차순이며 시각이 없는 줄은 뒤에 둔다.
 *
 * @param {string} topic
 * @param {object[]} rows
 * @returns {string}
 */
export function renderTimeline(topic, rows) {
  const ordered = [...rows].sort((a, b) => {
    const ta = worldTimeMs(a);
    const tb = worldTimeMs(b);
    if (Number.isFinite(ta) !== Number.isFinite(tb)) return Number.isFinite(ta) ? -1 : 1;
    return (ta - tb) || String(a.id).localeCompare(String(b.id));
  });
  const lines = ordered.map(r => {
    const when = r.event_time
      ? formatEventTime(r.event_time, r.event_time_precision)
      : formatEventTime(Number.isFinite(statedAtMs(r)) ? new Date(statedAtMs(r)) : null, "day");
    return `${when ?? "????-??-??"} | ${r.type} | ${digestLine(r.content)}`;
  });
  return capText(`[timeline] ${topic} (${rows.length})\n${lines.join("\n")}`);
}

/**
 * 선호 목록 본문. 말한 시각 역순.
 *
 * @param {object[]} rows
 * @returns {string}
 */
export function renderProfile(rows) {
  const ordered = [...rows].sort((a, b) => (statedAtMs(b) - statedAtMs(a)) || String(a.id).localeCompare(String(b.id)));
  const lines   = ordered.map(r => {
    const when = formatEventTime(Number.isFinite(statedAtMs(r)) ? new Date(statedAtMs(r)) : null, "day");
    return `${when ?? "????-??-??"} | ${digestLine(r.content)}`;
  });
  return capText(`[preferences] (${rows.length}, 최근 순)\n${lines.join("\n")}`);
}

function capText(text) {
  return text.length > DIGEST_MAX_CHARS ? `${text.slice(0, DIGEST_MAX_CHARS)}...` : text;
}

/**
 * 요약 하나를 쓴다. 같은 범위의 source_hash가 같으면 updated_at만 바꾼다.
 *
 * @returns {Promise<boolean>} 본문을 새로 썼으면 true
 */
async function upsertDigest(run, scope, kind, subject, content, rows) {
  const hash = sourceHash(rows);
  const res  = await run(
    `INSERT INTO ${SCHEMA}.fragment_digest
            (key_id, workspace, agent_id, kind, subject, content, source_ids, source_hash, item_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9)
     ON CONFLICT (COALESCE(key_id, ''), COALESCE(workspace, ''), agent_id, kind, subject)
     DO UPDATE SET content     = CASE WHEN fragment_digest.source_hash = EXCLUDED.source_hash
                                      THEN fragment_digest.content ELSE EXCLUDED.content END,
                   source_ids  = EXCLUDED.source_ids,
                   item_count  = EXCLUDED.item_count,
                   updated_at  = NOW(),
                   source_hash = EXCLUDED.source_hash
     RETURNING (xmax = 0) AS inserted`,
    [scope.key_id, scope.workspace, scope.agent_id, kind, subject, content, rows.map(r => r.id), hash, rows.length]
  );
  return res.rows[0]?.inserted === true;
}

/**
 * 정리 단계 본체.
 *
 * @param {{run?: Function}} [deps] - run(sql, params). 기본은 system 에이전트 문맥의 질의
 * @returns {Promise<{status: string, affected: number, timelines: number, profiles: number, removed: number}>}
 */
export async function buildDigests({ run = (sql, params) => queryWithAgentVector("system", sql, params, "write") } = {}) {
  const startedAt = new Date().toISOString();
  let timelines = 0;
  let profiles  = 0;

  const timelineGroups = await run(
    `SELECT f.key_id, f.workspace, f.agent_id, f.topic, max(f.created_at) AS last_at
       FROM ${SCHEMA}.fragments f
      WHERE ${ELIGIBLE}
      GROUP BY f.key_id, f.workspace, f.agent_id, f.topic
     HAVING count(*) >= $1
      ORDER BY last_at DESC
      LIMIT $2`,
    [DIGEST_MIN_ITEMS, DIGEST_GROUP_LIMIT]
  );
  for (const g of timelineGroups.rows) {
    const items = await run(
      `SELECT f.id, f.content, f.type, f.content_hash, f.created_at, f.mention_time,
              f.event_time, f.event_time_precision
         FROM ${SCHEMA}.fragments f
        WHERE ${ELIGIBLE} AND ${SAME_SCOPE} AND f.topic = $4
        ORDER BY COALESCE(f.event_time, f.mention_time, f.created_at) DESC, f.id
        LIMIT $5`,
      [g.key_id, g.workspace, g.agent_id, g.topic, TIMELINE_MAX_ITEMS]
    );
    await upsertDigest(run, g, "topic_timeline", g.topic, renderTimeline(g.topic, items.rows), items.rows);
    timelines++;
  }

  const profileGroups = await run(
    `SELECT f.key_id, f.workspace, f.agent_id, max(f.created_at) AS last_at
       FROM ${SCHEMA}.fragments f
      WHERE ${ELIGIBLE} AND f.type = 'preference'
      GROUP BY f.key_id, f.workspace, f.agent_id
     HAVING count(*) >= 2
      ORDER BY last_at DESC
      LIMIT $1`,
    [DIGEST_GROUP_LIMIT]
  );
  for (const g of profileGroups.rows) {
    const items = await run(
      `SELECT f.id, f.content, f.type, f.content_hash, f.created_at, f.mention_time
         FROM ${SCHEMA}.fragments f
        WHERE ${ELIGIBLE} AND ${SAME_SCOPE} AND f.type = 'preference'
        ORDER BY COALESCE(f.mention_time, f.created_at) DESC, f.id
        LIMIT $4`,
      [g.key_id, g.workspace, g.agent_id, PROFILE_MAX_ITEMS]
    );
    await upsertDigest(run, g, "preference_profile", "preferences", renderProfile(items.rows), items.rows);
    profiles++;
  }

  /** 이번 주기에 다시 쓰지 않았고 출처가 하나라도 유효하지 않은 요약을 지운다 */
  const removed = await run(
    `DELETE FROM ${SCHEMA}.fragment_digest d
      WHERE d.updated_at < $1::timestamptz
        AND EXISTS (
          SELECT 1 FROM unnest(d.source_ids) AS s(id)
           WHERE NOT EXISTS (SELECT 1 FROM ${SCHEMA}.fragments f WHERE f.id = s.id AND f.valid_to IS NULL)
        )`,
    [startedAt]
  );

  const removedCount = removed.rowCount ?? 0;
  return { status: "ok", affected: timelines + profiles, timelines, profiles, removed: removedCount };
}

/**
 * 정리 주기의 build_digests 단계 정의. MEMENTO_DIGEST=off이면 건너뛴다.
 *
 * @param {Object} results - 정리 결과 집계 객체(digestsBuilt를 채운다)
 * @returns {{name: string, fn: Function, onResult: Function}}
 */
export function digestStage(results) {
  return {
    name    : "build_digests",
    fn      : () => (digestEnabled() ? buildDigests() : Promise.resolve({ status: "skipped", affected: 0 })),
    onResult: (s) => { results.digestsBuilt = s.affected; }
  };
}

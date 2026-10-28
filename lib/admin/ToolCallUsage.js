/**
 * ToolCallUsage - API 키별 도구 호출 수 기록과 조회
 *
 * 작성자: 최진호
 * 작성일: 2026-10-12
 *
 * api_key_usage.call_count는 인증된 요청마다 늘어 접속과 도구 목록 조회까지 센다. 키가 기억 도구를 실제로
 * 썼는지는 tools/call만 센 tool_call_count와 도구별 tool_calls(migration-067)로 본다. 기록은 응답을 늦추지
 * 않도록 기다리지 않는다. 마스터 키(키 id 없음)는 세지 않는다.
 */

import { getPrimaryPool }    from "../tools/db.js";
import { logWarn }           from "../logger.js";
import { SCHEMA }            from "../memory/schema.js";

/** 열이 없을 때(migration-067 이전) 경고를 한 번만 남긴다 */
let missingColumnWarned = false;

/**
 * 도구 호출 하나를 그날 사용량에 더한다. 실패해도 호출자에게 알리지 않는다.
 *
 * @param {string|null|undefined} keyId
 * @param {string} toolName - 등록된 도구 이름
 * @param {() => {query: Function}|null} [getPool]
 * @returns {Promise<void>}
 */
export async function recordToolCall(keyId, toolName, getPool = getPrimaryPool) {
  if (!keyId || typeof toolName !== "string" || toolName === "") return;
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO ${SCHEMA}.api_key_usage (key_id, usage_date, call_count, tool_call_count, tool_calls)
       VALUES ($1, CURRENT_DATE, 0, 1, jsonb_build_object($2::text, 1))
       ON CONFLICT (key_id, usage_date) DO UPDATE
         SET tool_call_count = api_key_usage.tool_call_count + 1,
             tool_calls      = api_key_usage.tool_calls
                               || jsonb_build_object($2::text, COALESCE((api_key_usage.tool_calls ->> $2)::int, 0) + 1)`,
      [keyId, toolName]
    );
  } catch (err) {
    if (err?.code === "42703") {
      if (!missingColumnWarned) logWarn("[ToolCallUsage] api_key_usage.tool_call_count가 없어 도구 호출을 세지 않는다(migration-067)");
      missingColumnWarned = true;
      return;
    }
    logWarn("[ToolCallUsage] record failed", { error: err?.message });
  }
}

/**
 * 키 하나의 최근 사용량. 요청 수(call_count)와 도구 호출 수를 함께 돌려준다.
 *
 * @param {string} keyId
 * @param {{query: Function}} pool
 * @returns {Promise<{requests30d: number, toolCalls7d: number, toolCalls30d: number, byTool30d: Object<string, number>,
 *   lastToolCallDate: string|null, daily: Array<{date: string, requests: number, toolCalls: number}>}>}
 */
export async function loadKeyUsage(keyId, pool) {
  const { rows } = await pool.query(
    `SELECT to_char(usage_date, 'YYYY-MM-DD') AS date, call_count, tool_call_count, tool_calls
       FROM ${SCHEMA}.api_key_usage
      WHERE key_id = $1 AND usage_date > CURRENT_DATE - 30
      ORDER BY usage_date`,
    [keyId]
  );
  const weekStart = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const byTool    = {};
  let requests30d = 0, toolCalls30d = 0, toolCalls7d = 0, lastToolCallDate = null;
  for (const r of rows) {
    requests30d  += r.call_count;
    toolCalls30d += r.tool_call_count;
    if (r.date > weekStart) toolCalls7d += r.tool_call_count;
    if (r.tool_call_count > 0) lastToolCallDate = r.date;
    for (const [tool, n] of Object.entries(r.tool_calls ?? {})) byTool[tool] = (byTool[tool] ?? 0) + Number(n);
  }
  return {
    requests30d, toolCalls7d, toolCalls30d, byTool30d: byTool, lastToolCallDate,
    daily: rows.map(r => ({ date: r.date, requests: r.call_count, toolCalls: r.tool_call_count }))
  };
}

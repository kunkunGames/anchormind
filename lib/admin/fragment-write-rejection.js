/**
 * 관리 API 파편 쓰기(PATCH·DELETE) 거절 응답.
 * 거절은 경고 로그로 남기고, amend 실패 결과는 상태와 본문으로 바꾼다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-14
 */

import { logWarn } from "../logger.js";

/** 파편 쓰기 거절을 경고 로그로 남기고 응답한다. */
export function rejectFragmentWrite(res, status, method, fragId, body) {
  logWarn(`[Admin] ${method} /memory/fragments/${fragId} rejected: status=${status} code=${body.code ?? "-"} error=${body.error ?? "-"}`);
  res.statusCode = status;
  res.end(JSON.stringify(body));
  return true;
}

/** amend 실패 결과를 응답 상태와 본문으로 바꾼다. 병합은 409, 없음·권한은 404, 그 밖은 400. */
export function amendRejection(result) {
  if (result?.merged) {
    return { status: 409, body: { error: "Content duplicates an existing fragment", code: "duplicate_content", existingId: result.existingId } };
  }
  const error = result?.error || "Update failed";
  return { status: /not found|permission/i.test(error) ? 404 : 400, body: result?.code ? { error, code: result.code } : { error } };
}

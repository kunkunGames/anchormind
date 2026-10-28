/**
 * 세계 시각과 상태 표지 파라미터 스키마
 *
 * 작성자: 최진호
 * 작성일: 2026-10-12
 *
 * remember, batch_remember 항목, amend가 펼쳐 쓰는 세계 시각 조각(WORLD_TIME_PARAMS)과, recall이 쓰는
 * timeRange.basis, includeHistory, order, intent 조각이다. 해석 규칙은 lib/memory/write/EventTimeExtractor.js,
 * lib/memory/WorldTime.js, lib/memory/read/EvidenceBundle.js에 있다.
 */

export const WORLD_TIME_PARAMS = {
  mentionTime: {
    type       : "string",
    maxLength  : 64,
    description: "그 내용을 말하거나 관찰한 시각 (ISO 8601). 지난 대화를 옮겨 저장할 때 원래 시각을 준다. " +
                 "생략하면 저장 시각으로 본다. 시간 근접 랭킹과 모순 해소의 선후 판정이 이 값을 쓴다.",
    examples   : ["2026-03-15T09:30:00+09:00", "2025-11-02"]
  },
  eventTime: {
    type       : "string",
    maxLength  : 64,
    description: "내용이 가리키는 사건 시각. YYYY, YYYY-MM, YYYY-MM-DD, ISO 시각, 또는 날짜 표현('어제', 'last week'). " +
                 "날짜 표현은 mentionTime(없으면 지금) 기준으로 해석한다. 생략하면 본문의 날짜 표현에서 뽑는다. " +
                 "해석할 수 없으면 버리고 validation_warnings에 eventTimeInvalid를 싣는다.",
    examples   : ["2026-03", "2026-03-14", "지난주"]
  },
  eventTimeEnd: {
    type       : "string",
    maxLength  : 64,
    description: "구간 사건의 끝 시각 (ISO 8601, 배타 상한). eventTime보다 늦어야 한다.",
    examples   : ["2026-03-20"]
  }
};

export const TIME_RANGE_BASIS_PARAM = {
  type       : "string",
  enum       : ["created", "event"],
  description: "비교할 시각. created(기본)는 저장 시각, event는 사건 시각(event_time, 없으면 mention_time, 없으면 created_at)",
  examples   : ["created", "event"]
};

export const RECALL_HISTORY_PARAM = {
  type       : "boolean",
  description: "true 시 결과 파편이 대체한 이전 값(닫힌 파편)을 그 파편 바로 뒤에 state=superseded로 끼우고, " +
               "대체한 파편에는 state=current를 단다. 한 recall에 최대 5건. 값이 어떻게 바뀌었는지 물을 때 쓴다. " +
               "아직 유효한 모순 상대는 이 값과 무관하게 conflicts_with와 state=conflict로 표시된다. 기본 false.",
  examples   : [false, true]
};

export const RECALL_ORDER_PARAM = {
  type       : "string",
  enum       : ["rank", "chronological"],
  description: "결과 순서. rank(기본)는 관련도 순, chronological은 세계 시각(event_time, 없으면 mention_time, " +
               "없으면 created_at) 오름차순이다. 사건 순서를 물을 때 쓴다. format=pack에도 적용된다.",
  examples   : ["rank", "chronological"]
};

export const RECALL_INTENT_PARAM = {
  type       : "string",
  enum       : ["auto", "lookup", "aggregate", "temporal", "state"],
  description: "질문 의도. auto(기본)는 text(없으면 keywords)로 가린다. 응답 _meta.evidence에 의도, 근거 상태" +
               "(no_evidence, conflicting, partial, supported), 질의 핵심 낱말 덮임 비율(coverage)과 덮이지 않은 낱말" +
               "(uncovered_terms)을 싣고, aggregate, temporal, state면 결과를 세계 시각순 행으로 편 근거 묶음(bundle: rows, " +
               "distinct_count, duplicate_ids, coverage=truncated|within_results)을 싣는다. 의도를 직접 주면 기본값도 바뀐다: " +
               "aggregate는 pageSize 하한 30, temporal은 order=chronological, state는 includeHistory=true(직접 준 값이 우선). " +
               "근거 상태가 partial이면 uncovered_terms로 다시 검색하고, no_evidence면 기억에 없다고 답한다.",
  examples   : ["auto", "aggregate", "temporal"]
};

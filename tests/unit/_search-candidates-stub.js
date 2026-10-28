/**
 * search()만 있는 검색 대역에 recall 후보 API(searchCandidates)를 채운다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-13
 *
 * MemoryRecaller는 searchCandidates로 예산 없는 후보를 받아 예산 안에서 고른다. search()만 흉내 내는
 * 대역은 그 결과를 후보 전체로 돌려주고, finalize는 고른 파편으로 결과를 다시 만든다.
 * 이미 searchCandidates가 있는 검색 객체는 그대로 둔다.
 */

/**
 * @param {Object} search search(query)를 가진 대역
 * @returns {Object}
 */
export function withSearchCandidates(search) {
  if (!search || typeof search.searchCandidates === "function") return search;
  return Object.assign(Object.create(search), {
    searchCandidates: async (query) => {
      const result     = await search.search(query);
      const candidates = result.fragments ?? [];
      return {
        candidates,
        baselineIds: new Set(candidates.map(f => f.id)),
        exactCounts: new Map(),
        tokenBudget: query.tokenBudget ?? 1000,
        finalize   : async (selected) => ({ ...result, fragments: selected, count: selected.length })
      };
    }
  });
}

/**
 * 검색 대역을 감싸는 MemoryRecaller 하위 클래스.
 *
 * @param {Function} Base MemoryRecaller
 * @returns {Function}
 */
export function recallerWithSearchStub(Base) {
  return class extends Base {
    constructor(deps = {}) {
      super({ ...deps, search: withSearchCandidates(deps.search) });
    }
  };
}

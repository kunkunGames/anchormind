/**
 * 종료 시 DB 풀 닫기 시한 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-13
 *
 * pool.end()는 빌려 간 연결이 반환될 때까지 끝나지 않는다. endPoolWithin은 시한 뒤 넘어간다.
 */

import { describe, it, mock } from "node:test";
import assert                 from "node:assert/strict";

const warnings = [];
mock.module("../../lib/logger.js", {
  namedExports: {
    logDebug: () => {}, logInfo: () => {}, logError: () => {},
    logWarn : (msg) => { warnings.push(msg); }
  }
});

const { endPoolWithin } = await import("../../lib/tools/db.js");

describe("endPoolWithin", () => {
  it("시한 안에 닫히면 true", async () => {
    assert.equal(await endPoolWithin({ end: async () => {} }, "T", 50), true);
  });

  it("반환되지 않는 연결이 있으면 시한 뒤 false와 남은 연결 수를 남긴다", async () => {
    const started = Date.now();
    const closed  = await endPoolWithin({ end: () => new Promise(() => {}), totalCount: 3, idleCount: 1 }, "T", 30);
    assert.equal(closed, false);
    assert.ok(Date.now() - started < 1000);
    assert.match(warnings.at(-1), /2 checked-out connection\(s\) not released within 30ms/);
  });
});

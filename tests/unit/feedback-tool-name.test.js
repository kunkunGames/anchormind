/**
 * tool_feedback 도구 이름 정규화 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-13
 */

import { describe, it } from "node:test";
import assert           from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";

const { normalizeFeedbackToolName, MEMORY_TOOL_NAMES } = await import("../../lib/tools/tool-name.js");

describe("normalizeFeedbackToolName", () => {
  it("이 서버 도구의 클라이언트 표기를 도구 이름으로 모은다", () => {
    for (const name of ["recall", " recall ", "mcp__anchormind__recall", "mcp__codex_apps__anchormind_recall", "anchormind-recall", "memento_recall"]) {
      assert.equal(normalizeFeedbackToolName(name), "recall", name);
    }
    assert.equal(normalizeFeedbackToolName("anchormind-reflect"), "reflect");
  });

  it("다른 서버 도구는 MCP 접두어만 뗀다", () => {
    assert.equal(normalizeFeedbackToolName("mcp__docs__db_query"), "db_query");
    assert.equal(normalizeFeedbackToolName("agent/thread"), "agent/thread");
    assert.equal(normalizeFeedbackToolName("anchormind-unknown"), "anchormind-unknown");
  });

  it("문자열이 아니면 그대로 둔다", () => {
    assert.equal(normalizeFeedbackToolName(undefined), undefined);
  });

  it("공개 기억 도구 이름 목록에 recall과 tool_feedback이 있다", () => {
    assert.ok(MEMORY_TOOL_NAMES.has("recall") && MEMORY_TOOL_NAMES.has("tool_feedback"));
  });
});

/**
 * tool_feedback 도구 이름 정규화
 *
 * 작성자: 최진호
 * 작성일: 2026-10-13
 *
 * 클라이언트는 같은 도구를 여러 이름으로 부른다(mcp__anchormind__recall,
 * mcp__codex_apps__anchormind_recall, anchormind-recall 등). 이 서버 도구는 서버의 도구 이름으로 모아
 * 도구별 집계가 갈라지지 않게 한다. 다른 서버의 도구 이름은 MCP 접두어만 떼고 그대로 둔다.
 */

import * as schemas from "./memory-schemas.js";

/** 이 서버가 공개하는 기억 도구 이름 */
export const MEMORY_TOOL_NAMES = new Set(
  Object.values(schemas)
    .filter(def => def && typeof def === "object" && typeof def.name === "string" && def.inputSchema)
    .map(def => def.name)
);

/**
 * @param {*} name 클라이언트가 보낸 도구 이름
 * @returns {*} 정규화한 이름. 문자열이 아니면 그대로 돌려준다.
 */
export function normalizeFeedbackToolName(name) {
  if (typeof name !== "string") return name;
  let tool = name.trim();
  /** MCP 클라이언트 표기: mcp__<서버>__<도구>. 서버 이름에 밑줄이 있을 수 있어 마지막 구분자로 자른다. */
  if (tool.startsWith("mcp__") && tool.lastIndexOf("__") > 3) {
    tool = tool.slice(tool.lastIndexOf("__") + 2);
  }
  const bare = tool.replace(/^(?:anchormind|memento)[-_]/i, "");
  return MEMORY_TOOL_NAMES.has(bare) ? bare : tool;
}

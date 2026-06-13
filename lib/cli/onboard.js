/**
 * CLI: onboard - 클라이언트 CLI(Claude Code / Codex)를 memento 서버에 연결
 *
 * 범위(CLIENT_SPEC v3): 환원 불가능한 델타만 설치한다 — 등록 + 검증.
 *   L0 등록 : Claude `claude mcp add --transport http`; Codex `[mcp_servers.memento]` 멱등 삽입
 *   검증    : 공급 키로 memory_stats를 호출해 키 인증·연결을 assert. 키/그룹을 생성하지 않는다
 *
 * 클라이언트 훅·OS 스케줄러는 설치하지 않는다(v3에서 전면 제거). 운영 동작(시작 context /
 *   recall / remember / reflect 트리거)은 서버 `instructions` 필드가 push하고, 세션종료·유휴
 *   reflect는 서버 autoReflect + 유휴 스윕이 담당한다.
 *
 * 보안(§12): 키는 argv가 아니라 환경변수(--key-env <NAME>)로만 받는다
 *   (값이 프로세스 목록·셸 이력에 남지 않도록). 키 평문을 stdout에 출력하지 않는다.
 *   Claude는 resolved bearer를 ~/.claude.json에 저장하므로 파일 권한을 제한한다.
 *
 * 종료 코드: 0 정상, 1 오류, 2 사전요구/필수 플래그 누락.
 *
 * 작성자: 최진호
 * 작성일: 2026-06-13
 */

import { spawnSync }                       from "node:child_process";
import { homedir }                         from "node:os";
import { join, dirname }                   from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  mkdirSync,
}                                          from "node:fs";
import { McpClient }                       from "./_mcpClient.js";

export const usage = [
  "Usage: memento-mcp onboard --endpoint <host:port> --key-env <NAME> [options]",
  "",
  "Connect a client CLI (Claude Code / Codex) to a running memento server.",
  "Installs only the irreducible delta: MCP registration (C1) + key auth assert (C7).",
  "Always-on rules (C2) are pushed by the server's MCP `instructions` field — nothing to install.",
  "",
  "Options:",
  "  --endpoint <host:port>    REQUIRED. MCP host (no localhost default). e.g. 127.0.0.1:57332",
  "  --key-env <NAME>          REQUIRED. env var NAME holding the bearer key.",
  "                            Read from the environment, never from argv. MEMENTO_ACCESS_KEY is allowed.",
  "                            Claude persists the resolved bearer in ~/.claude.json — restrict file perms.",
  "                            Raw --key <value> is rejected for security.",
  "  --claude                  Target Claude Code only (default: auto-detect installed CLIs)",
  "  --codex                   Target Codex CLI only (default: auto-detect installed CLIs)",
  "  --profile global|project  global=~/.claude·~/.codex (default); project=<cwd>",
  "  --dry-run                 Print every mutating action prefixed [dry-run]; change nothing",
  "  --uninstall               Reverse registration (remove memento from Claude/Codex), keep backups",
  "  -y                        Assume yes (non-interactive; reserved for future prompts)",
  "  --timeout <ms>            C7 assert request timeout in ms (default: 30000)",
  "",
  "Examples:",
  "  export MEMENTO_ACCESS_KEY=<master key>",
  "  memento-mcp onboard --endpoint 127.0.0.1:57332 --key-env MEMENTO_ACCESS_KEY --claude",
  "  memento-mcp onboard --endpoint memento.example.net:57332 --key-env MEMENTO_ACCESS_KEY --codex",
  "  memento-mcp onboard --endpoint 127.0.0.1:57332 --uninstall",
].join("\n");

const MCP_SERVER_NAME = "memento";

/**
 * `host:port` 또는 URL 형태의 --endpoint를 정규화한 MCP URL로 변환한다.
 * 스킴이 없으면 http://를 가정하고 /mcp 경로를 보장한다.
 *
 * @param {string} raw - --endpoint 값 (예: 127.0.0.1:57332, http://host:57332/mcp)
 * @returns {string} - 정규화된 MCP 엔드포인트 URL (예: http://127.0.0.1:57332/mcp)
 */
function normalizeEndpoint(raw) {
  let value = raw.trim();
  if (!/^https?:\/\//i.test(value)) {
    value = `http://${value}`;
  }
  const u = new URL(value);
  if (!u.pathname || u.pathname === "/") {
    u.pathname = "/mcp";
  }
  return u.toString().replace(/\/$/, "");
}

/**
 * Claude 설정 디렉터리 해석 ($CLAUDE_CONFIG_DIR 우선, 없으면 ~/.claude).
 * @returns {string}
 */
function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * Codex 설정 디렉터리 해석 ($CODEX_HOME 우선, 없으면 ~/.codex).
 * @returns {string}
 */
function codexConfigDir() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

/**
 * 설치된 클라이언트 CLI를 탐지한다. 설정 디렉터리 존재 여부로 판단한다.
 * @returns {{ claude: boolean, codex: boolean }}
 */
function detectClients() {
  return {
    claude: existsSync(claudeConfigDir()),
    codex:  existsSync(codexConfigDir()),
  };
}

/**
 * 타깃 CLI 집합을 결정한다. --claude/--codex가 주어지면 그것만, 아니면 탐지된 전부.
 *
 * @param {object} args
 * @param {{ claude: boolean, codex: boolean }} detected
 * @returns {{ claude: boolean, codex: boolean }}
 */
function resolveTargets(args, detected) {
  const explicit = Boolean(args.claude || args.codex);
  if (explicit) {
    return { claude: Boolean(args.claude), codex: Boolean(args.codex) };
  }
  return { ...detected };
}

/**
 * Bearer 키를 해석한다. 보안상 값은 argv가 아니라 환경변수(--key-env <NAME>)로만 받는다.
 * 마스터키 기존 운영 방식을 위해 MEMENTO_ACCESS_KEY도 허용한다.
 *
 * @param {object} args
 * @returns {{ value: string|null, envName: string|null }}
 */
function resolveKey(args) {
  if (typeof args.key === "string") {
    throw new Error(
      "보안상 --key <value>는 지원하지 않습니다(값이 argv·프로세스 목록·셸 이력에 남음). " +
      "키를 환경변수에 넣고 --key-env <NAME>으로 그 변수 이름을 지정하세요."
    );
  }

  const envName = typeof args["key-env"] === "string" ? args["key-env"] : null;
  if (!envName) {
    return { value: null, envName: null };
  }
  const value = process.env[envName] ?? null;

  return { value, envName };
}

/**
 * 타임스탬프 백업 + atomic write(temp→rename)로 설정 파일을 교체한다.
 *
 * @param {string} filePath
 * @param {string} contents
 */
function writeAtomicWithBackup(filePath, contents) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  if (existsSync(filePath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(filePath, `${filePath}.${stamp}.bak`);
  }

  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, filePath);
}

/**
 * `claude` CLI를 동기 실행한다.
 * @param {string[]} cliArgs
 * @returns {{ status: number, stdout: string, stderr: string, error?: Error }}
 */
function runClaude(cliArgs) {
  const res = spawnSync("claude", cliArgs, { encoding: "utf8", shell: process.platform === "win32" });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error:  res.error,
  };
}

/**
 * C1 — Claude 등록. 멱등: `claude mcp list`에 memento가 이미 있으면 skip.
 *
 * @param {object} ctx - { endpoint, keyValue, keyEnvName, dryRun }
 */
function registerClaude(ctx) {
  // Claude CLI does not expand environment variables inside --header because
  // we execute it without a shell. Resolve --key-env here and pass the actual
  // bearer key; dry-run output stays redacted below.
  const headerArg = `Authorization: Bearer ${ctx.keyValue}`;

  if (ctx.dryRun) {
    console.log(
      `[dry-run] claude mcp add ${MCP_SERVER_NAME} ${ctx.endpoint} ` +
      `--transport http --scope user --header "Authorization: Bearer <redacted>"`
    );
    return;
  }

  // 멱등: 자유 텍스트 list 파싱 대신 `claude mcp get`의 exit code로 정확 판정.
  const got = runClaude(["mcp", "get", MCP_SERVER_NAME]);
  if (got.error) {
    throw new Error(`'claude' CLI를 실행할 수 없습니다: ${got.error.message}`);
  }
  if (got.status === 0) {
    console.log(`[claude] '${MCP_SERVER_NAME}' 이미 등록됨 — skip (멱등).`);
    return;
  }
  if (!ctx.keyValue) {
    throw new Error(
      `Claude 등록에는 onboard 시점에 환경변수 ${ctx.keyEnvName} 값이 필요합니다(헤더에 보간됨). ` +
      `export 후 재실행하세요(빈 Bearer 등록 방지).`
    );
  }

  const add = runClaude([
    "mcp", "add", MCP_SERVER_NAME, ctx.endpoint,
    "--transport", "http",
    "--scope", "user",
    "--header", headerArg,
  ]);

  if (add.status !== 0) {
    throw new Error(`claude mcp add 실패 (exit ${add.status}): ${(add.stderr || add.stdout).trim()}`);
  }
  console.log(`[claude] '${MCP_SERVER_NAME}' 등록 완료 (HTTP, user scope).`);
}

/**
 * C1 uninstall — Claude 등록 제거. 멱등: 없으면 no-op.
 * @param {object} ctx - { dryRun }
 */
function unregisterClaude(ctx) {
  if (ctx.dryRun) {
    console.log(`[dry-run] claude mcp remove ${MCP_SERVER_NAME}`);
    return;
  }
  const got = runClaude(["mcp", "get", MCP_SERVER_NAME]);
  if (got.error) {
    throw new Error(`'claude' CLI를 실행할 수 없습니다: ${got.error.message}`);
  }
  if (got.status !== 0) {
    console.log(`[claude] '${MCP_SERVER_NAME}' 등록 없음 — skip (멱등).`);
    return;
  }
  const remove = runClaude(["mcp", "remove", MCP_SERVER_NAME]);
  if (remove.status !== 0) {
    throw new Error(`claude mcp remove 실패 (exit ${remove.status}): ${(remove.stderr || remove.stdout).trim()}`);
  }
  console.log(`[claude] '${MCP_SERVER_NAME}' 등록 제거 완료.`);
}

/**
 * smol-toml을 lazy-load한다. 미설치 시 명확한 에러(조용한 skip 금지, §14).
 * @returns {Promise<{ parse: Function, stringify: Function }>}
 */
async function loadToml() {
  try {
    return await import("smol-toml");
  } catch {
    throw new Error(
      "Codex 경로에는 'smol-toml'이 필요합니다. `npm install smol-toml`로 설치하세요 " +
      "(optionalDependencies — Codex TOML round-trip 전용)."
    );
  }
}

/**
 * C1 — Codex 등록. ~/.codex/config.toml에 [mcp_servers.memento] 멱등 삽입.
 * Codex는 토큰 값이 아니라 env 이름을 받으므로 keyEnvName이 필수다.
 *
 * @param {object} ctx - { endpoint, keyEnvName, dryRun }
 */
async function registerCodex(ctx) {
  if (!ctx.keyEnvName) {
    throw new Error(
      "Codex 경로에는 --key-env <NAME>이 필요합니다. Codex는 bearer 토큰의 '값'이 아니라 " +
      "'환경변수 이름'을 받습니다(bearer_token_env_var). --key <value>는 Codex에 쓸 수 없습니다."
    );
  }

  const configPath = join(codexConfigDir(), "config.toml");
  const existing   = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";

  const { parse, stringify } = await loadToml();
  let doc = {};
  if (existing.trim()) {
    try {
      doc = parse(existing);
    } catch (err) {
      throw new Error(`config.toml 파싱 실패 — 손상 의심, 변경 중단: ${err.message}`);
    }
  }

  if (doc.mcp_servers && doc.mcp_servers[MCP_SERVER_NAME]) {
    console.log(`[codex] [mcp_servers.${MCP_SERVER_NAME}] 이미 존재 — skip (멱등).`);
    return;
  }

  if (ctx.dryRun) {
    console.log(
      `[dry-run] config.toml에 [mcp_servers.${MCP_SERVER_NAME}] 삽입 ` +
      `(url="${ctx.endpoint}", bearer_token_env_var="${ctx.keyEnvName}") + 타임스탬프 백업`
    );
    return;
  }

  doc.mcp_servers = doc.mcp_servers || {};
  doc.mcp_servers[MCP_SERVER_NAME] = {
    url: ctx.endpoint,
    bearer_token_env_var: ctx.keyEnvName,
  };

  writeAtomicWithBackup(configPath, stringify(doc));
  console.log(`[codex] [mcp_servers.${MCP_SERVER_NAME}] 삽입 완료 → ${configPath}`);
}

/**
 * C1 uninstall — Codex 등록 제거. [mcp_servers.memento] 블록만 삭제, notify 등 보존.
 * @param {object} ctx - { dryRun }
 */
async function unregisterCodex(ctx) {
  const configPath = join(codexConfigDir(), "config.toml");
  if (!existsSync(configPath)) {
    console.log(`[codex] config.toml 없음 — skip (멱등).`);
    return;
  }

  const existing = readFileSync(configPath, "utf8");
  const { parse, stringify } = await loadToml();
  let doc;
  try {
    doc = parse(existing);
  } catch (err) {
    throw new Error(`config.toml 파싱 실패 — 손상 의심, 변경 중단: ${err.message}`);
  }

  if (!doc.mcp_servers || !doc.mcp_servers[MCP_SERVER_NAME]) {
    console.log(`[codex] [mcp_servers.${MCP_SERVER_NAME}] 없음 — skip (멱등).`);
    return;
  }

  if (ctx.dryRun) {
    console.log(`[dry-run] config.toml에서 [mcp_servers.${MCP_SERVER_NAME}] 제거 + 타임스탬프 백업`);
    return;
  }

  delete doc.mcp_servers[MCP_SERVER_NAME];
  if (Object.keys(doc.mcp_servers).length === 0) {
    delete doc.mcp_servers;
  }

  writeAtomicWithBackup(configPath, stringify(doc));
  console.log(`[codex] [mcp_servers.${MCP_SERVER_NAME}] 제거 완료 → ${configPath}`);
}

/**
 * C7 — 검증 전용 assert. 공급 키로 memory_stats를 호출해 키가 서버에 인증되는지 확인한다.
 * 키/그룹을 생성하지 않는다(§6.2). 검증 실패는 경고로 남기되 설치를 실패시키지 않는다.
 *
 * @param {object} ctx - { endpoint, keyValue, keyEnvName, timeoutMs }
 */
async function assertKeyGroup(ctx) {
  if (!ctx.keyValue) {
    console.warn(
      `[assert] C7 검증 미실행: 환경변수 ${ctx.keyEnvName ?? "(미지정)"} 값이 이 호스트에 없습니다. ` +
      "등록은 완료되었으나 키 인증은 확인하지 못했습니다 — 키를 export한 뒤 수동 확인하세요."
    );
    return;
  }

  const client = new McpClient(ctx.endpoint, ctx.keyValue, { timeoutMs: ctx.timeoutMs });
  try {
    await client.call("memory_stats", {});
    console.log("[assert] 키 인증 OK — 서버 연결·키 resolution 정상.");
  } catch (err) {
    console.warn(`[assert] 경고: C7 검증 호출 실패(등록은 완료됨): ${err.message}`);
  }
}

export default async function onboard(args) {
  if (args.help || args.h) {
    console.log(usage);
    process.exit(0);
  }

  // --- 사전요구/필수 플래그 검증 (exit 2) ---
  const endpointRaw = typeof args.endpoint === "string" ? args.endpoint : null;
  if (!endpointRaw) {
    console.error("--endpoint <host:port>는 필수입니다(localhost 기본값 금지). 예: --endpoint 127.0.0.1:57332");
    process.exit(2);
  }

  let endpoint;
  try {
    endpoint = normalizeEndpoint(endpointRaw);
  } catch (err) {
    console.error(`--endpoint 파싱 실패: ${err.message}`);
    process.exit(2);
  }

  const uninstall = Boolean(args.uninstall);
  const dryRun    = Boolean(args["dry-run"]);
  const timeoutMs = args.timeout ? parseInt(args.timeout, 10) : 30_000;
  const profile   = args.profile === "project" ? "project" : "global";

  if (profile === "project") {
    // 본 킷은 등록 + 검증만 하므로 user-scope 등록을 사용한다. project 프로파일은 안내만 남긴다.
    console.warn("[onboard] --profile project: 현재 킷은 user-scope 등록만 수행합니다.");
  }

  let keyValue = null;
  let keyEnvName = null;
  if (!uninstall) {
    let resolved;
    try {
      resolved = resolveKey(args);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    keyValue   = resolved.value;
    keyEnvName = resolved.envName;

    if (!keyEnvName) {
      console.error("--key-env <NAME>이 필요합니다(MEMENTO_ACCESS_KEY 등 Bearer 키를 담은 환경변수 이름).");
      process.exit(2);
    }
  }

  // --- 타깃 CLI 결정 ---
  const detected = detectClients();
  const targets  = resolveTargets(args, detected);

  if (!targets.claude && !targets.codex) {
    console.error(
      "타깃 CLI를 찾지 못했습니다. ~/.claude 또는 ~/.codex가 없거나 --claude/--codex로 명시되지 않았습니다 " +
      "($CLAUDE_CONFIG_DIR / $CODEX_HOME 확인)."
    );
    process.exit(2);
  }

  console.log(
    `[onboard] endpoint=${endpoint} targets=${[
      targets.claude ? "claude" : null,
      targets.codex ? "codex" : null,
    ].filter(Boolean).join(",")} ${dryRun ? "(dry-run)" : ""}${uninstall ? "(uninstall)" : ""}`.trim()
  );

  const ctx = { endpoint, keyValue, keyEnvName, dryRun, timeoutMs };

  try {
    if (uninstall) {
      if (targets.claude) unregisterClaude(ctx);
      if (targets.codex)  await unregisterCodex(ctx);
      console.log("[onboard] uninstall 완료. 백업(.bak)은 보존됩니다.");
      process.exit(0);
    }

    // C1 — 등록
    if (targets.claude) registerClaude(ctx);
    if (targets.codex)  await registerCodex(ctx);

    // C2 — no-op: 서버 instructions가 접속 시 운영 규칙을 push한다.
    console.log(
      "[onboard] C2: always-on 운영 규칙은 서버 `instructions` 필드가 접속 시 전 클라이언트에 자동 주입합니다 — 설치할 것 없음."
    );

    // C7 — 검증 전용
    if (!dryRun) {
      await assertKeyGroup(ctx);
    } else {
      console.log("[dry-run] C7 검증(memory_stats) 호출 생략.");
    }

    console.log("[onboard] 완료.");
    process.exit(0);
  } catch (err) {
    console.error(`[onboard] ${err.message}`);
    process.exit(1);
  }
}

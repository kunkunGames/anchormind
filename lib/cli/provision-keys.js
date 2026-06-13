/**
 * CLI: provision-keys - 서버/운영자 전용 per-platform 키·그룹 프로비저닝
 *
 * 이 명령은 CLIENT_SPEC C7이 의존하는 "운영자 1회 수행" 단계다(SERVER_SPEC §5).
 * 마스터 키 게이트 라우트(admin-keys.js:49,240,279)를 호출해:
 *   (1) 키 그룹을 생성(이미 있으면 재사용)
 *   (2) 플랫폼마다 per-platform API 키를 1개씩 발급
 *   (3) 각 키를 그룹에 배정 → 크로스-CLI 기억 공유
 * 그리고 각 플랫폼의 키 시크릿을 1회 출력하면서 다음에 실행할
 * `onboard --endpoint ... --key-env <NAME> --<platform>` 명령을 안내한다.
 *
 * !!! 마스터 키를 다루는 유일한 명령이다 !!!
 *   마스터 키는 env(--master-key-env, 기본 MEMENTO_ACCESS_KEY)에서만 읽고,
 *   stdout/파일에 절대 출력하지 않는다. onboard(클라이언트)는 마스터 키를 읽지 않는다.
 *
 * 종료 코드: 0 정상, 1 오류, 2 사전요구/필수 플래그 누락.
 *
 * 작성자: 최진호
 * 작성일: 2026-06-13
 */

import { request as httpRequest }  from "node:http";
import { request as httpsRequest } from "node:https";

const ADMIN_BASE = "/v1/internal/model/nothing";

export const usage = [
  "Usage: memento-mcp provision-keys --endpoint <host:port> --group <name> --platforms <csv> [options]",
  "",
  "OPERATOR-ONLY. Uses the MASTER key to create a key group, issue one per-platform API key",
  "per platform, and add each key to the group (cross-CLI memory sharing). The ONLY command",
  "that touches the master key — read from env only, never printed.",
  "",
  "Options:",
  "  --endpoint <host:port>    REQUIRED. Server host (admin API base). e.g. 127.0.0.1:57332",
  "  --group <name>            REQUIRED. Key group name (created if missing, reused if present)",
  "  --platforms <csv>         REQUIRED. Comma-separated platforms, e.g. claude,codex",
  "  --master-key-env <NAME>   Env var NAME holding the master key (default: MEMENTO_ACCESS_KEY)",
  "  --daily-limit <N>         Per-key daily request limit (optional; server default otherwise)",
  "  --dry-run                 Print every admin call prefixed [dry-run]; change nothing",
  "  --timeout <ms>            Admin request timeout in ms (default: 30000)",
  "",
  "Examples:",
  "  memento-mcp provision-keys --endpoint 127.0.0.1:57332 --group team-a --platforms claude,codex",
  "  memento-mcp provision-keys --endpoint 127.0.0.1:57332 --group team-a --platforms claude --dry-run",
].join("\n");

/**
 * --endpoint를 admin API base URL로 정규화한다(스킴 없으면 http:// 가정, 경로 제거).
 * @param {string} raw
 * @returns {string} - 예: http://127.0.0.1:57332
 */
function normalizeBaseUrl(raw) {
  let value = raw.trim();
  if (!/^https?:\/\//i.test(value)) {
    value = `http://${value}`;
  }
  const u = new URL(value);
  return `${u.protocol}//${u.host}`;
}

/**
 * 마스터 키 인증으로 admin API에 POST 요청을 보낸다.
 *
 * @param {string} baseUrl   - 서버 base URL (예: http://127.0.0.1:57332)
 * @param {string} masterKey - Bearer 마스터 키
 * @param {string} path      - ADMIN_BASE 하위 경로
 * @param {object} bodyObj   - JSON 직렬화할 요청 바디
 * @param {number} timeoutMs
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function adminPost(baseUrl, masterKey, path, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u        = new URL(path, baseUrl);
    const protocol = u.protocol;
    const hostname = u.hostname;
    const port     = u.port ? parseInt(u.port, 10) : (protocol === "https:" ? 443 : 80);
    const reqPath  = u.pathname + u.search;
    const fn       = protocol === "https:" ? httpsRequest : httpRequest;
    const payload  = JSON.stringify(bodyObj ?? {});

    const req = fn(
      {
        hostname,
        port,
        path    : reqPath,
        method  : "POST",
        headers : {
          "Authorization" : `Bearer ${masterKey}`,
          "Content-Type"  : "application/json",
          "Accept"        : "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data",  (c) => chunks.push(c));
        res.on("end",   ()  => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Admin request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/**
 * 키 그룹을 생성한다. 이미 있으면(409) 멤버 조회로 기존 그룹 id를 재사용한다.
 *
 * @returns {Promise<{ id: string, reused: boolean }>}
 */
async function ensureGroup(baseUrl, masterKey, groupName, timeoutMs) {
  const resp = await adminPost(baseUrl, masterKey, `${ADMIN_BASE}/groups`, { name: groupName }, timeoutMs);

  if (resp.statusCode === 201) {
    const group = JSON.parse(resp.body);
    return { id: group.id, reused: false };
  }

  if (resp.statusCode === 409) {
    // 중복 — 기존 그룹 id를 GET /groups로 찾는다.
    const listResp = await adminGet(baseUrl, masterKey, `${ADMIN_BASE}/groups`, timeoutMs);
    if (listResp.statusCode === 200) {
      const groups = JSON.parse(listResp.body);
      const arr = Array.isArray(groups) ? groups : (groups.groups ?? []);
      const found = arr.find((g) => g.name === groupName);
      if (found) return { id: found.id, reused: true };
    }
    throw new Error(`그룹 '${groupName}'이 이미 존재하나 id를 조회하지 못했습니다 (HTTP ${listResp.statusCode}).`);
  }

  throw new Error(`그룹 생성 실패 (HTTP ${resp.statusCode}): ${resp.body.slice(0, 200)}`);
}

/**
 * 마스터 키 인증 GET (기존 그룹 조회용).
 */
function adminGet(baseUrl, masterKey, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u        = new URL(path, baseUrl);
    const protocol = u.protocol;
    const hostname = u.hostname;
    const port     = u.port ? parseInt(u.port, 10) : (protocol === "https:" ? 443 : 80);
    const reqPath  = u.pathname + u.search;
    const fn       = protocol === "https:" ? httpsRequest : httpRequest;

    const req = fn(
      {
        hostname,
        port,
        path    : reqPath,
        method  : "GET",
        headers : {
          "Authorization": `Bearer ${masterKey}`,
          "Accept"       : "application/json",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data",  (c) => chunks.push(c));
        res.on("end",   ()  => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Admin request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

/**
 * 단일 플랫폼 키를 발급하고 그룹에 배정한다.
 *
 * @returns {Promise<{ id: string, rawKey: string }>}
 */
async function provisionPlatformKey(baseUrl, masterKey, group, platform, dailyLimit, timeoutMs) {
  const keyBody = { name: `${group.name}-${platform}` };
  if (dailyLimit !== undefined) keyBody.daily_limit = dailyLimit;

  const keyResp = await adminPost(baseUrl, masterKey, `${ADMIN_BASE}/keys`, keyBody, timeoutMs);
  if (keyResp.statusCode === 409) {
    throw new Error(
      `키 '${keyBody.name}'이 이미 존재합니다(이름 중복) — provision-keys는 키 생성에 멱등적이지 않습니다. ` +
      `같은 그룹을 다시 프로비저닝하려면 (a) 다른 --group 이름을 쓰거나, (b) 운영자가 기존 키를 ` +
      `Admin Console에서 해당 그룹에 직접 배정하세요. 부분 실패 후 재실행 시 이미 생성된 키가 이 에러를 냅니다.`
    );
  }
  if (keyResp.statusCode !== 201) {
    throw new Error(`키 발급 실패 (${platform}, HTTP ${keyResp.statusCode}): ${keyResp.body.slice(0, 200)}`);
  }
  const key = JSON.parse(keyResp.body);

  const memberResp = await adminPost(
    baseUrl, masterKey, `${ADMIN_BASE}/groups/${group.id}/members`, { key_id: key.id }, timeoutMs
  );
  if (memberResp.statusCode !== 200) {
    throw new Error(`그룹 배정 실패 (${platform}, HTTP ${memberResp.statusCode}): ${memberResp.body.slice(0, 200)}`);
  }

  return { id: key.id, rawKey: key.raw_key };
}

export default async function provisionKeys(args) {
  if (args.help || args.h) {
    console.log(usage);
    process.exit(0);
  }

  const endpointRaw = typeof args.endpoint === "string" ? args.endpoint : null;
  if (!endpointRaw) {
    console.error("--endpoint <host:port>는 필수입니다. 예: --endpoint 127.0.0.1:57332");
    process.exit(2);
  }
  const groupName = typeof args.group === "string" ? args.group.trim() : null;
  if (!groupName) {
    console.error("--group <name>은 필수입니다.");
    process.exit(2);
  }
  const platformsRaw = typeof args.platforms === "string" ? args.platforms : null;
  if (!platformsRaw) {
    console.error("--platforms <csv>는 필수입니다. 예: --platforms claude,codex");
    process.exit(2);
  }
  const platforms = platformsRaw.split(",").map((p) => p.trim()).filter(Boolean);
  if (platforms.length === 0) {
    console.error("--platforms에서 유효한 플랫폼을 파싱하지 못했습니다.");
    process.exit(2);
  }

  const masterKeyEnv = typeof args["master-key-env"] === "string" ? args["master-key-env"] : "MEMENTO_ACCESS_KEY";
  const masterKey    = process.env[masterKeyEnv];
  if (!masterKey) {
    console.error(`마스터 키 환경변수 '${masterKeyEnv}'가 설정되지 않았습니다. provision-keys는 마스터 키가 필요합니다.`);
    process.exit(2);
  }

  const dryRun     = Boolean(args["dry-run"]);
  const timeoutMs  = args.timeout ? parseInt(args.timeout, 10) : 30_000;
  const dailyLimit = args["daily-limit"] !== undefined ? parseInt(args["daily-limit"], 10) : undefined;
  const baseUrl    = normalizeBaseUrl(endpointRaw);

  console.log(`[provision-keys] base=${baseUrl} group=${groupName} platforms=${platforms.join(",")} ${dryRun ? "(dry-run)" : ""}`.trim());

  if (dryRun) {
    console.log(`[dry-run] POST ${ADMIN_BASE}/groups { name: "${groupName}" }  (없으면 생성, 있으면 재사용)`);
    for (const platform of platforms) {
      console.log(`[dry-run] POST ${ADMIN_BASE}/keys { name: "${groupName}-${platform}"${dailyLimit !== undefined ? `, daily_limit: ${dailyLimit}` : ""} }`);
      console.log(`[dry-run] POST ${ADMIN_BASE}/groups/<group-id>/members { key_id: "<new-key-id>" }`);
    }
    console.log("[dry-run] 변경 없음.");
    process.exit(0);
  }

  try {
    const group = { name: groupName, ...(await ensureGroup(baseUrl, masterKey, groupName, timeoutMs)) };
    console.log(`[provision-keys] 그룹 '${groupName}' ${group.reused ? "재사용" : "생성"} (id=${group.id}).`);

    const results = [];
    for (const platform of platforms) {
      const { id, rawKey } = await provisionPlatformKey(baseUrl, masterKey, group, platform, dailyLimit, timeoutMs);
      results.push({ platform, id, rawKey });
      console.log(`[provision-keys] '${platform}' 키 발급 + 그룹 배정 완료 (key id=${id}).`);
    }

    // 시크릿 1회 출력 + 다음 단계 안내. (시크릿은 화면에만; 파일/로그에 저장 금지)
    console.log("\n=== 발급된 per-platform 키 (지금 안전한 곳에 저장하세요 — 다시 표시되지 않습니다) ===");
    for (const r of results) {
      const envName = `MEMENTO_${r.platform.toUpperCase()}_KEY`;
      console.log(`\n[${r.platform}]`);
      console.log(`  key secret : ${r.rawKey}`);
      console.log(`  store now  : export ${envName}='${r.rawKey}'   (Windows: setx ${envName} "<secret>")`);
      console.log(`  next step  : memento-mcp onboard --endpoint ${baseUrl.replace(/^https?:\/\//, "")} --key-env ${envName} --${r.platform}`);
    }
    console.log("\n[provision-keys] 완료.");
    process.exit(0);
  } catch (err) {
    console.error(`[provision-keys] ${err.message}`);
    process.exit(1);
  }
}

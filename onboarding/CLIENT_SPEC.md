# Memento Onboarding — CLIENT SPEC (v3)

> **범위:** 이미 실행 중인 memento-mcp **서버에 클라이언트 CLI(Claude Code / Codex)를 연결**하는 온보딩 — **MCP 등록 + 키 검증만** 한다. 서버 설치/프로비저닝은 [`SERVER_SPEC.md`](./SERVER_SPEC.md), 두 온보딩 구분은 [`SPEC.md`](./SPEC.md) 인덱스. 클라이언트는 서버가 발급한 **엔드포인트 + 키**를 입력으로 받는다.

| 항목 | 값 |
|------|-----|
| 문서 | Memento CLIENT Onboarding 명세 (서버 연결 + 키 검증) |
| 위치 | `memento-mcp/onboarding/CLIENT_SPEC.md` |
| 대상 OS | Windows, macOS (Linux best-effort) |
| 대상 CLI | Claude Code, Codex CLI |
| 상태 | v3 — 클라이언트 훅·OS 스케줄러 전면 제거 (운영 동작은 서버 `instructions`가 구동) |
| memento 버전 | 4.5.0 (`package.json:3`) |
| 근거 | `lib/jsonrpc.js`, `lib/sessions.js`, `lib/scheduler.js`, `lib/handlers/health-handler.js`, `lib/tools/memory.js`, `lib/auth.js`, `migration-011-key-groups.sql`, `bin/memento.js`, `lib/cli/_mcpClient.js` |

---

## 0. 개정 이력

- **v3 (현재): 클라이언트 훅(SessionStart / UserPromptSubmit / SessionEnd)과 OS 스케줄러를 전면 제거.** 운영 동작(시작 context · recall · remember · reflect 트리거)은 서버 `instructions` 필드가 모든 클라이언트에 push하므로, 클라이언트가 결정적 훅으로 재현할 필요가 없다. 온보딩 = **L0 등록 + 키 검증**으로 환원. 훅은 외부 CLI 계약 미검증 + 서버 instructions 대비 한계 이득이라 제거.
- v2: L0 등록 + 선택적 L2 훅(context/recall/reflect) + L4 참조.
- v1: PowerShell+jq+python 3-런타임 인스톨러 + L1 파일 렌더 + L3 스케줄러. → 전부 폐기(서버가 대체).

> 사실 정정(이전 버전에서 확정): 헬스 응답은 `{"status":"healthy"}`(not `{"ok":true}`); `get_skill_guide` section은 enum이 아니라 핸들러 검증 자유 문자열 12개; Codex `[mcp_servers.memento]` 키는 외부 CLI 사양; 마스터키 미설정만으로 open-auth가 되는 게 아니라 `MEMENTO_AUTH_DISABLED=true` 명시일 때만.

---

## 1. 개요 — server-first

memento 서버는 (a) MCP `initialize`의 `instructions` 필드로 운영 규칙을 **전 클라이언트에 주입**, (b) 세션종료 autoReflect + 5분 유휴 스윕, (c) `get_skill_guide` 심층 가이드를 **이미 제공**한다. 따라서 클라이언트 온보딩의 본질은 **"각 CLI를 서버에 올바르게 연결(등록)하고, 키가 의도대로 인증·그룹 resolve되는지 검증"** 뿐이다. 규칙·reflect·스케줄링을 클라이언트에 이식하지 않는다.

### 비목표
- 서버 배포/DB/임베딩/포트(= `setup.sh`, `SERVER_SPEC.md`).
- **클라이언트 훅**(시작/질의/종료) — 설치하지 않는다. 운영 트리거는 서버 instructions가 구동(§2).
- **OS 스케줄러**(Windows `schtasks` / macOS `launchd` / cron) — **완전 폐기.** 서버 autoReflect + 유휴 스윕이 대체(§8).
- 세션종료·유휴 reflect, 주기 `memory_consolidate`(= 서버 책임, §8).
- 시크릿·내부 IP 하드코딩(§10).

---

## 2. 서버가 이미 하는 것 — 클라이언트가 재현하지 않음 (운영 트리거 일원화)

아래는 전부 **서버 책임**이며 클라이언트에 설치물이 없다. 운영 트리거(시작 context·recall·remember·reflect)는 서버 `instructions`가 모델에 전달하므로, 연결만 하면 자동 적용된다.

| 서버가 제공 | 소스 | 서버가 모델에 push하는 운영 트리거 |
|------------|------|-----------------------------------|
| **운영 규칙 `instructions`** | `jsonrpc.js:129-314` (`aiInstructions` → `instructions`) | 세션시작 `context`; recall-first(에러/설정/과거참조 시); remember 트리거(에러원인·기술결정·설정변경 확정 시); reflect-on-exit; 키워드 규칙; case/phase; `_meta.hints` 팔로우; `get_skill_guide` 포인터 |
| **세션종료 reflect** | `sessions.js:246,324` (autoReflect) | 종료 시 올바른 mcp-session-id로 자동 |
| **유휴 reflect 스윕(5분)** | `scheduler.js:94` → `sessions.js:492-514`, `IDLE_REFLECT_HOURS`(기본 24h) | 유휴 세션 자동 — **클라 스케줄러 불필요·불가** |
| **주기 consolidate** | `memory.js:620-622` (마스터키 전용) | 서버 측 작업 |
| **심층 가이드** | `get_skill_guide` (`memory.js:711-763`, 12섹션) | on-demand |

> 핵심: 운영 동작은 전부 서버가 구동(model-driven). 클라이언트는 **연결만** 하면 된다. 훅으로 "결정성"을 더하는 것은 외부 CLI 계약 의존 + 한계 이득이라 본 킷 범위 밖이다.

---

## 3. 킷 범위 = 환원 불가능한 델타 (등록 + 검증)

| 작업 | 포함 | 메커니즘 |
|------|------|----------|
| **L0 MCP 등록** | ✅ | Claude `claude mcp add --transport http`; Codex `[mcp_servers.memento]` 멱등 삽입 |
| **키 검증(assert-only)** | ✅ | 공급 키로 `memory_stats` 호출 → 인증 OK 확인. 키/그룹을 **생성하지 않음** |
| 운영 규칙·reflect·스케줄러·훅 | ❌ | 서버 책임(§2, §8) |
| 심층 참조 | ❌ | `get_skill_guide`(서버) |

---

## 4. 구현: `memento-mcp onboard` (단일 Node 런타임)

- `bin/memento.js`의 `COMMANDS`에 `onboard` 등록, `lib/cli/onboard.js`가 detect → 등록 → 검증.
- `lib/cli/_mcpClient.js`(initialize → `MCP-Session-Id` → `tools/call`, `Authorization: Bearer`) 재사용. JSON은 네이티브; Codex TOML은 `smol-toml`(optionalDependency) round-trip.
- **훅/스케줄러 설치 코드·디렉터리 없음**(`templates/`·`hooks/`·`scheduler/` 미생성).

```text
memento-mcp/
├─ bin/memento.js     # COMMANDS에 onboard 등록
└─ lib/cli/
   ├─ onboard.js      # detect → register(L0) → verify
   └─ _mcpClient.js   # 재사용 (MCP-over-HTTP)
```

---

## 5. L0 — 연결 & 인증

| 항목 | 값 | 소스 |
|------|-----|------|
| 포트 | 57332 (기본) | `lib/config.js` `PORT \|\| 57332` |
| 엔드포인트 | `POST /mcp` (+ `GET /mcp` SSE, `DELETE /mcp`) | `server.js` |
| 헬스 | `GET /health` → 미인증 `{status,timestamp}`, 인증 `{status:"healthy"\|"degraded"\|"unhealthy"}` (불건전 시 503) | `lib/handlers/health-handler.js:86-100` |
| 인증 헤더 | `Authorization: Bearer <key>` | `lib/auth.js` |
| 키 env | `MEMENTO_ACCESS_KEY`(마스터). 미설정+`MEMENTO_AUTH_DISABLED` 미설정 = fail-closed 거부 | `lib/auth.js:43-50` |
| transport | **HTTP only** (stdio 없음) | `server.js` |

**Claude 등록(User 스코프).** `settings.json`의 `mcpServers`는 무시되므로 CLI를 쓴다:
```bash
claude mcp add memento <endpoint>/mcp --transport http --scope user \
  --header "Authorization: Bearer $MEMENTO_ACCESS_KEY"
claude mcp list   # expect: memento ... (HTTP) - Connected
```

**Codex 등록.** `~/.codex/config.toml`에 멱등 삽입(중복 헤더는 TOML 파싱 에러 → 존재 시 skip, 없으면 round-trip). 아래 키는 **Codex CLI 외부 사양**:
```toml
[mcp_servers.memento]
url = "<endpoint>/mcp"
bearer_token_env_var = "MEMENTO_ACCESS_KEY"
```

> `<endpoint>`는 `--endpoint host:port`로 **필수 지정**(localhost 기본값 금지). 내부 IP를 문서/파일에 하드코딩하지 않는다(`INSTALL.md:423`).

---

## 6. 키 그룹 & 검증 (assert-only)

키 그룹(`migration-011-key-groups.sql`, 스키마 `agent_memory`): `api_key_groups` + `api_key_group_members`(N:M). 인증 시 `getGroupKeyIds(keyId)`(`ApiKeyStore.js:303`)가 같은 그룹 key_id를 반환 → recall/context가 그룹 전체 파편을 본다(그룹 없는 키는 자기 파편만).

> **키/그룹 생성·배정은 운영자가 서버 측에서 마스터 키로 1회 수행**(`SERVER_SPEC.md` §5; 생성 라우트 `admin-keys.js`는 전부 마스터 게이트). **onboard는 발급된 키를 입력받아 인증·그룹 resolution을 검증만** 한다(키 생성 안 함, 마스터 키 미요구). provenance용 플랫폼명(`claude`/`codex`) 키워드는 서버 instructions가 이미 권고.

---

## 7. `onboard` 동작 명세

### 7.1 단계
1. **detect** — OS(`process.platform`) + 설치 CLI(`~/.claude`/`$CLAUDE_CONFIG_DIR`, `~/.codex`/`$CODEX_HOME`). env override 존중.
2. **register (L0)** — Claude `claude mcp add ... --transport http`; Codex TOML round-trip 멱등(존재 시 skip).
3. **verify** — 공급 키로 `memory_stats` 호출해 인증·연결 확인(§7.3).
   (훅/스케줄러 설치 단계는 없다.)

### 7.2 플래그
| 플래그 | 동작 |
|--------|------|
| `--endpoint host:port` | **필수.** MCP URL. 미지정 시 종료코드 2(localhost 기본값 금지) |
| `--key-env <NAME>` | **필수.** Bearer 키를 담은 환경변수 이름(값은 argv가 아니라 env에서). `MEMENTO_ACCESS_KEY`(마스터키) 허용 — 기존 운영 방식 |
| `--claude` / `--codex` | 대상 CLI 한정(기본: 탐지된 전부) |
| `--profile global\|project` | global=`~/.claude`·`~/.codex`(기본); project=`<repo>` |
| `--dry-run` | 변경 없이 계획만 출력 |
| `--uninstall` | 등록 역행(Claude `mcp remove`, Codex 블록 제거), 백업 보존 |

### 7.3 수용 기준
1. **연결.** `claude mcp list`에 `memento ... Connected`; Codex `config.toml`에 `[mcp_servers.memento]` 정확히 1개, Codex 정상 기동.
2. **헬스.** `curl <endpoint>/health` → HTTP 200, `status ∈ {healthy,degraded}`.
3. **인증 강제.** Bearer 없는 `/mcp` 요청이 401/403로 거부됨. 서버 env에 `MEMENTO_ACCESS_KEY` 설정 + `MEMENTO_AUTH_DISABLED` 미설정 확인.
4. **키 검증.** 공급 키로 `memory_stats` 호출 성공(`키 인증 OK`).
5. **멱등.** 재실행 시 등록 skip(중복 없음), 타깃 바이트 동일; `config.toml` 재파싱 정상·기존 키 보존.
6. **uninstall 복원.** 등록 제거, 사용자 원본 보존, 종료 0.
7. **시크릿 부재.** 설정 파일에 키 평문 미기재(Bearer는 env/등록 시점만; Claude `--header`는 `~/.claude.json`에 남을 수 있어 §10 유의).

---

## 8. 세션종료 / 유휴 reflect & 스케줄러 = 전적으로 서버 책임 (클라이언트 없음)

- **세션종료/유휴 reflect는 서버가 수행:** 종료 시 autoReflect(`sessions.js:246,324`) + 5분 유휴 스윕(`scheduler.js:94` → `sessions.js:492-514`, `IDLE_REFLECT_HOURS`). 둘 다 올바른 mcp-session-id로 동작 → **클라이언트는 reflect 훅·스케줄러를 두지 않는다.**
- **윈도우 스케줄러 완전 폐기:** 클라이언트 측 OS 스케줄러(Windows `schtasks` / macOS `launchd` / cron)는 온보딩에서 **전면 삭제**. 클라이언트는 어떤 OS 스케줄러도 등록하지 않는다(선택 사항 아님).
- **주기 `memory_consolidate`:** 마스터 키 전용(`memory.js:620-622`)이라 클라이언트 호출 불가 → **서버 호스트의 cron/systemd timer**(서버 측, 마스터 키)로 운영. `CONSOLIDATE_INTERVAL_MS` 참고.

---

## 9. L4 — 심층 레퍼런스

`get_skill_guide`(서버, on-demand). `section`은 JSON-Schema enum이 아니라 핸들러 맵(`memory.js:711-725`)이 검증하는 **자유 문자열 12개**: `overview | lifecycle | keywords | search | episode | multiplatform | tools | importance | experiential | triggers | antipatterns | cbr`. 본문은 번들에 복제하지 않는다.

---

## 10. 보안
- 키 평문을 `settings.json`/`config.toml`/`CLAUDE.md`/`AGENTS.md`에 기재 금지. Codex는 `bearer_token_env_var`(값 아닌 env명). Claude `--header`는 `$MEMENTO_ACCESS_KEY` env 보간 — `~/.claude.json`에 평문이 남을 수 있으니 파일 권한 제한.
- **내부 IP 하드코딩 금지**(`INSTALL.md:423`) — 항상 `<endpoint>` 변수.
- fail-closed 유지: `MEMENTO_AUTH_DISABLED=true`를 자동 설정하지 않는다.
- 편집 전 타임스탬프 백업, atomic write(temp→rename), 손상 감지 시 변경 없이 중단.

---

## 11. 크로스플랫폼 매트릭스

| OS | CLI | 작업 | 메커니즘 | 경로 |
|----|-----|------|----------|------|
| Win/mac | Claude | L0 등록 | `claude mcp add --transport http` | `~/.claude.json` (settings.json `mcpServers` 무시) |
| Win/mac | Codex | L0 등록 | `[mcp_servers.memento]` round-trip | `~/.codex/config.toml`(`$CODEX_HOME`) |
| Win/mac | 공통 | 키 검증 | `memory_stats` over `_mcpClient` | (런타임) |
| Win/mac | 공통 | 운영 규칙 | **서버 `instructions`** (클라 설치물 없음) | `jsonrpc.js:314` |
| Win/mac | 공통 | 종료/유휴 reflect | **서버 auto/idle reflect** | `sessions.js`·`scheduler.js` |
| Win/mac | 공통 | 심층 참조 | `get_skill_guide` | (서버) |

핵심 로직은 단일 Node 서브커맨드이며 OS·CLI별로 등록 명령만 다르다. **훅·스케줄러 행 없음.**

---

## 12. 오픈 이슈 / 확장
- **C6 TOML 의존성:** TOML 라이브러리는 `optionalDependencies`로 두고 Codex 경로에서만 lazy-load(Claude는 네이티브 JSON). 골든-픽스처 CI로 바이트-멱등 재실행 + 미지 top-level 키 보존 + parse-back 무손실 검증.
- **C7 그룹 배정 자동 검증:** register 후 새 연결로 `memory_stats`를 호출해 공급 키가 의도한 키 그룹으로 resolve되는지 assert; 공급 키가 서버 마스터 키와 같으면 멀티-CLI 격리가 없다는 경고.
- **엔드포인트:** 단일 머신=`127.0.0.1:57332`, 원격=`<host>:57332`. `--endpoint` 필수화로 localhost 오등록 방지.
- **신규 CLI(Gemini/Qwen/OpenCode):** `lib/cli/onboard.js` 어댑터 테이블에 {configDir, instructionFile, mcpRegister}만 추가. 운영 규칙·reflect는 서버 공통이라 추가 작업 거의 없음.

---

## 부록 — 폐기 이력 (근거 file:line)

| 폐기/정정 | 근거 |
|-----------|------|
| **클라이언트 훅(SessionStart/UserPromptSubmit/SessionEnd) 전면 제거** | 운영 트리거는 서버 `instructions`(`jsonrpc.js:129-314`)가 모델에 push; 훅은 외부 CLI 계약 미검증 + 한계 이득 |
| **OS 스케줄러(schtasks/launchd/cron) 완전 폐기** | 서버 autoReflect(`sessions.js:246,324`) + 유휴 스윕(`scheduler.js:94`)이 대체 |
| L1 파일 렌더 → 서버 instructions 1차 | `jsonrpc.js:314` |
| 3-런타임 → Node 서브커맨드 | `package.json`(Node 전용), `bin/memento.js`, `lib/cli/_mcpClient.js` |
| health `{"ok":true}` → `{"status":"healthy"}` | `health-handler.js:86-100` |
| get_skill_guide 11 enum → 12 자유문자열(cbr) | `memory.js:711-725` |

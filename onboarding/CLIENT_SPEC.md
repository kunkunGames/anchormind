# Memento Onboarding — CLIENT SPEC (v2)

> **범위:** 이미 실행 중인 memento-mcp **서버에 클라이언트 CLI(Claude Code / Codex)를 연결**하는 온보딩(MCP 등록 + 선택적 시작/질의/종료 훅). 서버 자체 설치/프로비저닝은 [`SERVER_SPEC.md`](./SERVER_SPEC.md), 두 온보딩의 구분은 [`SPEC.md`](./SPEC.md) 인덱스를 참조한다. 클라이언트는 서버가 발급한 **엔드포인트 + per-platform 키**를 입력으로 받는다.

| 항목 | 값 |
|------|-----|
| 문서 | Memento **CLIENT** Onboarding 구현 명세 (서버 연결 + 훅) |
| 위치 | `memento-mcp/onboarding/CLIENT_SPEC.md` |
| 대상 OS | Windows, macOS (Linux best-effort) |
| 대상 CLI | Claude Code, Codex CLI |
| 작성일 | 2026-06-13 |
| 상태 | Draft v2.1 (CLIENT 적대적 audit 반영: C5 기본 OFF·C3 fail-open·C4 비용 정정·acceptance#3 정정) |
| memento 버전 | 4.5.0 (`package.json:3`) |
| 근거 | 검증된 소스: `lib/jsonrpc.js`, `lib/sessions.js`, `lib/scheduler.js`, `lib/handlers/health-handler.js`, `lib/tools/memory.js`, `lib/auth.js`, `migration-011-key-groups.sql`, `bin/memento.js`, `lib/cli/_mcpClient.js` |

---

## 0. 개정 이력 (v1 → v2)

v1은 4-레이어 bespoke 인스톨러(PowerShell+jq+python-tomlkit, L1 파일 렌더, L2 SessionEnd reflect, L3 스케줄러)로 설계됐다. 적대적 red-team(소스 file:line 대조)에서 **핵심 전제 2개가 틀린 것**으로 검증되어 v2로 재구성한다.

| v1 가정 | 검증 결과 (소스) | v2 조치 |
|---------|------------------|---------|
| 클라이언트 훅이 `reflect {sessionId=CLI session_id}`로 세션을 마감할 수 있다 | CLI 대화 `session_id` ≠ 파편 키잉용 서버 transport `mcp-session-id`(`mcp-handler.js:94,125`). **명시적 CLI session_id나 별도 connection(command 훅 curl)으로는 0행 매치=no-op.** 단 `tool_reflect`는 sessionId 미지정 시 connection의 transport id로 폴백(`memory.js:445-447`)하므로 **CLI 연결을 재사용하는 `mcp_tool` 훅 reflect(input:{})는 정상 동작**(§10) | command/CLI-id reflect·L3 스케줄러 삭제; **mcp_tool SessionEnd reflect는 선택 허용** |
| 세션종료/유휴 reflect를 클라이언트가 담당해야 한다 | 서버가 세션 종료 시 autoReflect(`sessions.js:246,324`) + 5분 유휴 스윕으로 `IDLE_REFLECT_HOURS`(기본 24h) 경과 세션 reflect(`scheduler.js:94`→`sessions.js:492-514`). 올바른 transport id로 이미 수행 | **서버 책임으로 명시, 킷 범위 밖** |
| L1 규칙을 각 CLI 파일에 렌더해야 한다 | 서버 `instructions` 필드(`jsonrpc.js:129-314`, ~185줄)가 session-start context·recall-first·remember 트리거·reflect-on-exit·tool_feedback·secret 제외·get_skill_guide 포인터를 **모든 MCP 클라이언트(Claude+Codex)에 이미 전달** | **L1 1차 = 서버 instructions**, 파일 렌더는 선택적 1줄 @import 백스톱으로 강등 |
| 3개 런타임(PowerShell+jq+python-tomlkit) 인스톨러 | 레포는 그중 무엇도 의존하지 않음(`package.json` Node 전용, `setup.sh`는 python3를 urllib 1회만). 이미 Node CLI(`bin/memento.js` COMMANDS)와 MCP-over-HTTP 클라이언트(`lib/cli/_mcpClient.js`) 보유 | **단일 Node 서브커맨드 `memento-mcp onboard`로 구현** |

추가 사실 정정: 헬스 응답은 `{"ok":true}`가 아니라 `{"status":"healthy"}`; get_skill_guide는 11개 enum이 아니라 **12개 섹션(`cbr` 포함) 자유 문자열**; Codex `bearer_token_env_var`/`[mcp_servers.memento]`/내부 IP는 memento 소스가 아닌 **외부 CLI 사실**(하드코딩 IP는 `INSTALL.md:423` 정책 위반).

---

## 1. 개요

### 1.1 목적
`memento-mcp` 저장소 안의 **얇은 클라이언트 온보딩 도구**를 정의한다. 여러 머신(Windows/macOS)·CLI(Claude Code/Codex)에서 memento를 잘 쓰도록 세팅하되, **서버가 이미 하는 일을 재발명하지 않고**(§3) 서버가 할 수 없는 **환원 불가능한 델타만**(§4) 설치한다.

### 1.2 핵심 원칙: server-first
memento 서버는 MCP 표준 `instructions` 필드(접속 시 전 클라이언트에 주입)와 server-side auto/idle reflect를 이미 제공한다. 따라서 온보딩의 본질은 "규칙·reflect를 클라이언트에 이식"이 아니라 **"각 CLI를 서버에 올바르게 연결(L0)하고, 선택적으로 시작 시 context 로드를 결정적으로(L2) 만드는 것"** 이다.

### 1.3 비목표
- 서버 배포/DB/임베딩/포트 바인딩(= `setup.sh` 책임).
- 세션종료·유휴 reflect, 주기 `memory_consolidate`(= **서버 책임**, §10).
- L4 가이드 본문 복제(= `get_skill_guide` on-demand, §9).
- Claude Skill을 always-on 규칙 매개체로 사용(Skill은 auto-fire 안 함; §4 노트).
- 시크릿 하드코딩, 내부 IP 하드코딩(§12, `INSTALL.md:423`).

---

## 2. 용어

| 용어 | 의미 |
|------|------|
| 서버 `instructions` | MCP `initialize` 응답의 instructions 필드. memento가 `jsonrpc.js:314`로 반환하는 ~185줄 AI 운영지침 |
| mcp-session-id | 서버 transport 세션 id. 파편·활동의 실제 키(`mcp-handler.js:94,125`). CLI 대화 session_id와 **다름** |
| L0/L2/L4 | 연결 / 시작-훅 / 심층참조. (v1의 L1·L3는 §0대로 강등/삭제) |
| onboard 서브커맨드 | `memento-mcp onboard` — 본 킷의 단일 진입점(Node) |

---

## 3. 서버가 이미 제공하는 것 (재발명 금지)

| 기능 | 소스 | 함의 |
|------|------|------|
| **always-on 운영 규칙 + get_skill_guide 포인터** | `lib/jsonrpc.js:129-314` (`aiInstructions`→`instructions`) | session-start context·recall-first·remember 트리거·reflect-on-exit·tool_feedback·secret 제외를 전 클라이언트에 자동 전달. **L1 본문을 파일로 렌더할 필요 없음** |
| **세션 종료 reflect** | `lib/sessions.js:246,324` (autoReflect) | 종료 시 서버가 올바른 mcp-session-id로 reflect |
| **유휴 reflect 스윕(5분 주기)** | `lib/scheduler.js:94` → `lib/sessions.js:492-514`, `IDLE_REFLECT_HOURS`=24h(`config.js`) | 유휴 세션 자동 reflect. **클라이언트 L3 스케줄러 불필요·불가** |
| **심층 사용 가이드** | `get_skill_guide`(`lib/tools/memory.js:711-763`) | 12개 섹션 on-demand. **번들 복제 없음** |
| **Node CLI + MCP-over-HTTP 클라이언트** | `bin/memento.js` COMMANDS, `lib/cli/_mcpClient.js` | onboard를 새 런타임 없이 서브커맨드로 추가 가능 |

> 결론: 온보딩이 추가할 "진짜 가치"는 **L0 등록 + 선택적 시작-훅** 뿐이다.

---

## 4. 킷 범위 = 환원 불가능한 델타

| Layer | 포함 여부 | 메커니즘 |
|-------|----------|----------|
| **L0 연결 & 키 그룹** | ✅ 포함 | CLI별 MCP 등록(Claude `mcp add --transport http`; Codex `[mcp_servers.memento]` 멱등 삽입) + 동일 키 그룹 배정 안내 |
| **L2 시작 시 context 로드** | ✅ 선택 포함 | 지원 CLI에 `SessionStart`→`context` 훅 1개. 미지원이면 서버 instructions가 모델에게 context 호출을 지시(soft) |
| L1 always-on 규칙 | ⛔ 1차 불포함 | **서버 `instructions`가 1차.** 선택적 1줄 `@import` 백스톱만(§8) |
| L3 유휴/주기 reflect | ❌ 삭제 | 서버 책임(§3, §10) |
| L4 심층참조 | ⛔ 불포함 | `get_skill_guide`(서버) |

> **Skill 노트.** Claude Skill은 auto-fire하지 않고(필요 시 로드) 번들 훅은 lifecycle-scoped라 always-on/세션 훅을 강제할 수 없다. 따라서 매개체는 CLI 네이티브 등록·훅이며, 원하면 "인스톨러를 실행만 하는" discovery-only Skill을 진입점으로 둘 수 있다(필수 아님).

---

## 5. 구현 형태: `memento-mcp onboard` (단일 Node 런타임)

v1의 PowerShell+jq+python-tomlkit 3-런타임 + 이중 `.ps1/.sh/.py`를 폐기한다. 대신 기존 Node CLI에 서브커맨드를 추가한다.

- `bin/memento.js`의 `COMMANDS`에 `onboard: () => import('../lib/cli/onboard.js')` 추가.
- `lib/cli/onboard.js`가 OS·CLI 탐지 → L0 등록 → (선택) L2 훅 → 검증.
- JSON 병합은 네이티브 `JSON.parse/stringify`(jq 불필요). TOML은 소형 라이브러리 1개(`smol-toml`/`@iarna/toml`) round-trip(python/tomlkit 불필요).
- 원격 호출이 필요하면 `lib/cli/_mcpClient.js`(initialize→`MCP-Session-Id`→`tools/call`, `Authorization: Bearer`)를 재사용.

```text
memento-mcp/
├─ bin/memento.js              # COMMANDS에 onboard 추가
├─ lib/cli/
│  ├─ onboard.js               # 신규: 진입점 (detect→register→hook→verify)
│  └─ _mcpClient.js            # 재사용 (MCP-over-HTTP)
└─ onboarding/
   ├─ SPEC.md                  # 본 문서
   ├─ templates/
   │  ├─ rules.snippet.md      # (선택) @import 백스톱 1줄 + get_skill_guide 포인터
   │  ├─ claude.sessionstart.json   # L2 Claude 훅 조각
   │  └─ codex.mcp.memento.toml     # L0 Codex 등록 조각(<endpoint> 변수)
   └─ hooks/
      ├─ inject-context.sh / .ps1    # (선택) command-훅 셔임: /mcp context POST
      └─ fire-marker 로그용 유틸
```

---

## 6. L0 — 연결 & 키 그룹

### 6.1 엔드포인트 / 인증 (소스 검증)

| 항목 | 값 | 소스 |
|------|-----|------|
| 포트 | 57332 (기본) | `lib/config.js` `PORT \|\| 57332` |
| 엔드포인트 | `POST /mcp` (+`GET /mcp` SSE, `DELETE /mcp`) | `server.js` |
| 헬스 | `GET /health` → 미인증 `{status,timestamp}`, 인증 `{status:"healthy"\|"degraded"\|"unhealthy",...}` (불건전 시 503) | `lib/handlers/health-handler.js:86-100` |
| 인증 헤더 | `Authorization: Bearer <key>` (legacy `memento-access-key: <key>`) | `lib/auth.js` |
| 키 env | `MEMENTO_ACCESS_KEY` (미설정 시 fail-closed, v2.7.0+) | `lib/auth.js:43-45` |
| transport | **HTTP only** (stdio 없음) | `server.js` |

**Claude 등록(권장, User 스코프).** `settings.json`의 `mcpServers`는 무시되므로 CLI를 쓴다:
```bash
claude mcp add memento <endpoint>/mcp \
  --transport http --scope user \
  --header "Authorization: Bearer $MEMENTO_ACCESS_KEY"
claude mcp list   # expect: memento ... (HTTP) - Connected
```

**Codex 등록.** `~/.codex/config.toml`에 멱등 삽입(중복 `[mcp_servers.memento]` 헤더는 TOML 파싱 에러 → 존재 시 skip, 없으면 round-trip insert). 아래 키는 **Codex CLI 외부 사양(이 레포 소스로는 미검증)**:
```toml
# 출처: Codex CLI 문서 (memento-mcp 소스 아님). <endpoint>는 onboard가 치환.
[mcp_servers.memento]
url = "<endpoint>/mcp"
bearer_token_env_var = "MEMENTO_ACCESS_KEY"
```

> `<endpoint>`는 `--endpoint host:port`로 **필수 지정**(localhost 기본값 금지, §11). 내부 IP를 문서/파일에 하드코딩하지 않는다(`INSTALL.md:423`).

### 6.2 키 그룹 (크로스-CLI 기억 공유)

`migration-011-key-groups.sql`, 스키마 `agent_memory`:
- `api_key_groups(id, name UNIQUE, description, created_at)`
- `api_key_group_members(group_id, key_id, joined_at, PK(group_id,key_id))` — N:M.

인증 시 `getGroupKeyIds(keyId)`(`lib/admin/ApiKeyStore.js:303`, 모듈 함수)가 같은 그룹 key_id를 반환하고 `lib/auth.js`가 `groupKeyIds` 필드로 소비 → recall/context가 그룹 전체 파편을 본다. 그룹 없는 키는 자기 파편만.

> **C7 범위 = 클라이언트 assert-only (go/no-go audit 정정).** 키/그룹 생성·배정 라우트(`POST /v1/internal/model/nothing/keys`·`/groups`·`/groups/:id/members`, `admin-keys.js:49,240,279`)는 **전부 마스터 키 게이트**(`admin-routes.js:149`→`admin-auth.js:75` validateMasterKey)다. onboard가 그룹 배정을 자동화하려면 클라이언트에 마스터 키가 필요 → §12 위반. 따라서:
> - **그룹 생성·키 발급·그룹 배정은 운영자가 서버 측에서 마스터 키로 1회 수행**(operator step, `SERVER_SPEC.md` §5).
> - **onboard는 이미 발급된 per-platform 키를 입력(`--key`/`--key-env`)으로 받고** 마스터 키를 절대 읽지 않는다. onboard는 키를 **생성하지 않는다**(`POST /keys`는 마스터 게이트).
> - onboard의 C7 역할은 **검증 전용**: 공급 키로 `recall`/`memory_stats`를 호출해 `getGroupKeyIds`(`ApiKeyStore.js:303-313`) 기반 그룹 resolution이 의도대로인지 assert(마스터 키 불필요).
>
> provenance를 위해 `remember` 키워드에 플랫폼명(`claude`/`codex`)을 포함(서버 instructions가 이미 권고).

---

## 7. L2 — 시작 시 context 로드 + 첫 질의 recall (선택)

SessionStart에는 아직 유저 질의가 없으므로 **일반 context**만 로드 가능하고, **질의별 recall**은 첫 유저 질의(UserPromptSubmit) 시점에서만 가능하다. context(일반·세션시작)와 recall(질의별)은 보완재다(서버 instructions/SKILL 원칙).

### 7.1 SessionStart → context (일반 기억, 결정적)
훅 스키마는 **CLI 벤더 사양(이 레포 미검증, 설치 버전 기준 재확인 필요)**. Claude(`~/.claude/settings.json` `hooks`), `mcp_tool` 훅 타입 지원 시:
```json
{ "hooks": { "SessionStart": [ { "hooks": [
  { "type": "mcp_tool", "server": "memento", "tool": "context", "input": { "structured": true } }
] } ] } }
```
- `mcp_tool` 훅 타입/최소버전 및 `{server,tool,input}` 스키마는 **검증 필요**(외부 CLI 벤더 사양, §14). 미지원이면 `type:"command"` 셔임으로 폴백 — audit 권고대로 **command 셔임을 1차 지원 경로로, `mcp_tool`은 버전-탐지된 기회적 업그레이드로** 취급한다. 어느 경로든 **짧은 명시 타임아웃(예 10–15s) + fail-open(`exit 0`)**으로 세션 초기화를 막지 않는다(C4와 동일 보장).
- 세션종료 reflect는 `mcp_tool`로 기술적으로 가능하나 **기본 OFF**(중복-reflect 레이스, §10) — 기본은 서버 autoReflect/유휴 스윕에 의존.

### 7.2 첫 유저 질의 → recall(text=프롬프트)
- **Claude 결정적 경로(채택) = 첫 질의 한정 `UserPromptSubmit` command 훅.** 모델 판단에 맡기지 않고 첫 유저 질의에서 `recall(text=<프롬프트>)`(pgvector 시맨틱 — 키워드 추출 불필요)를 **결정적으로** 실행해 첫 턴부터 그라운딩한다. (recall은 키/그룹 store 전체를 검색하므로 훅의 별도 connection이어도 무방 — reflect와 달리 세션 결합 문제 없음.)
- **Codex / 폴백 = 모델 주도.** Codex는 프롬프트 시점 주입 훅이 없어, 서버 instructions + AGENTS.md recall-first 의무로 모델이 `recall(text=프롬프트)`를 부른다(`tool_feedback` 루프 보존·이식).
- **Claude command 훅 세부:**
  - **`command` 타입만** 가능 — `mcp_tool` input은 `${prompt}`를 보간 못함(`${CLAUDE_PROJECT_DIR}` 등 경로 placeholder만 지원).
  - 셔임(권장: 크로스플랫폼 **Node 훅**, `lib/cli/_mcpClient.js` 재사용)이 stdin JSON의 `.prompt`를 읽어 `recall {text:<prompt>}` 호출 → `hookSpecificOutput.additionalContext`로 주입. 실패/타임아웃 시 `exit 0`(프롬프트 **차단 금지**, fail-open).
  - **첫 질의 감지(robust):** transcript 비어있음(`[ -s transcript ]`) 체크는 타이밍상 불안정(SessionStart 주입/현재 프롬프트가 이미 기록될 수 있음). 대신 **per-session 마커**를 쓴다 — stdin의 `session_id`로 `~/.memento/first-recall/<session_id>`를 **원자적 create-if-not-exists**(Node `fs.writeFileSync(m,…,{flag:'wx'})` / bash `set -C; : > m`)하여, 성공=첫 질의(recall 실행), 실패(이미 존재)=후속 질의 → `exit 0`(이후 recall은 모델이 판단). 마커는 `SessionEnd` 훅이 삭제 + `find -mtime +1 -delete` 백스톱.
  - (대안) **arm-then-consume:** `SessionStart` 훅이 `pending/<session_id>` 플래그 생성, 첫 `UserPromptSubmit`가 원자적 `rm`(성공 시에만 recall)으로 소비. SessionStart가 첫 UserPromptSubmit보다 먼저 발화하므로(검증됨) 정확히 1회.
  - 타임아웃 명시(UserPromptSubmit 기본 30s보다 짧게, 예 15–20s).
  - **비용(사실상 무시 가능):** 훅 주도 recall은 모델이 `_meta.searchEventId`를 못 봐 `tool_feedback`을 건너뛰지만, 그 피드백이 구동하는 **reconsolidation은 기본 OFF**(`ENABLE_RECONSOLIDATION!=='true'`, `memory.js:535`)라 **건너뛰어도 비용이 ~0**이다(audit 검증 — 이전 'reconsolidation 약화' 서술 정정). 필요 시 셔임이 `_meta.searchEventId`로 `tool_feedback`을 직접 POST해 복원 가능.
  - **이식성:** Codex는 프롬프트 시점 context 주입 훅이 없어(검증 필요) **Claude 전용**. 크로스-CLI 계약은 7.2 기본(모델 주도)로 유지.

> **혼동 주의:** 서버 `ProactiveRecall`(`lib/memory/RememberPostProcessor.js:181,298`)은 **`remember` 시점에 유사 파편을 `related_to`로 자동 링크**하는 write-time 그래프 보강(fire-and-forget, `proactive-gate.js`)이지 **프롬프트 시점 recall 주입이 아니다** — 7.2를 대체하지 않는다.

**Codex.** SessionStart 훅 지원 시 `command` 셔임 등록, 미지원이면 L0 등록 + 서버 instructions만으로 충분. 7.2 recall은 Codex에서 **모델 주도만**(훅 가속기 없음). *(호스트 실측 2026-06-13: Codex CLI 0.139.0의 `~/.codex/config.toml`은 `notify`(turn-ended 콜백)만 있고 `[hooks]` 없음 → 이 버전에서는 시작/첫질의/종료 context 주입 훅이 **부재**, Codex는 모델 주도 + 서버 autoReflect 경로로 동작. Claude Code 2.1.177은 `mcp_tool` 훅(≥v2.1.136) 지원.)*

**발화 검증.** 셔임은 발화 시 `~/.memento/hooks.log`에 `<ts> SessionStart`/`UserPromptSubmit` 1줄 기록 → §11에서 모델 회상이 아니라 이 로그로 발화를 검증.

---

## 8. L1 — always-on 규칙: 서버 instructions가 1차

- **1차 경로 = 서버 `instructions` 필드**(`jsonrpc.js:314`). 별도 파일 렌더 불필요. Claude·Codex 모두 접속 시 자동 수신.
- **선택 백스톱.** 서버 instructions를 과소 반영하는 클라이언트를 위해, `CLAUDE.md`/`AGENTS.md`에 **1줄 포인터**만 추가(전체 규칙 deep-merge 금지):
  ```markdown
  <!-- memento: 세션 시작 시 memento context 호출, recall-first, recall 후 tool_feedback. 상세: get_skill_guide -->
  ```
- v1의 정규식 관리블록 + 7규칙 렌더는 폐기(서버 instructions와 중복).

---

## 9. L4 — 심층 레퍼런스

`get_skill_guide`(서버, on-demand). `section`은 **JSON-Schema enum이 아니라** 핸들러 맵(`lib/tools/memory.js:711-725`)이 검증하는 **자유 문자열**이며 **12개**:
```
overview | lifecycle | keywords | search | episode | multiplatform | tools | importance | experiential | triggers | antipatterns | cbr
```
> 라이브 스키마 description은 `cbr`를 누락(11개)해 stale하나, 핸들러는 `section:"cbr"`를 정상 처리. 본문은 번들에 복제하지 않는다.

---

## 10. 세션종료 / 유휴 reflect

**서버 기본(backstop).** 종료 시 autoReflect(`lib/sessions.js:246,324`) + 5분 유휴 스윕(`lib/scheduler.js:94`→`lib/sessions.js:492-514`, `IDLE_REFLECT_HOURS` 기본 24h). 둘 다 올바른 mcp-session-id로 동작.

**결정적 클라이언트 reflect (기본 OFF — `--with-eager-reflect` opt-in, Claude `mcp_tool` 한정).** *[적대적 audit 결과 C5는 기본 비활성으로 강등.]* 기술적으로는 동작한다: `tool_reflect`는 `sessionId` 미지정 시 connection의 transport `mcp-session-id`로 폴백하고(`memory.js:445-447` ← handler가 `_sessionId=ctx.sessionId` 주입, `mcp-handler.js:94`), `mcp_tool` 훅은 CLI의 기존 MCP 연결로 호출되므로 `SessionEnd→reflect {input:{}}`는 그 세션 파편을 consolidate한다:
```json
{ "hooks": { "SessionEnd": [ { "hooks": [
  { "type": "mcp_tool", "server": "memento", "tool": "reflect", "input": {} }
] } ] } }
```
- 즉 red-team의 '클라이언트 reflect = no-op'은 **command 훅/명시적 CLI session_id에 한정**된 것이었고, **`mcp_tool` reflect는 동작**한다.
- **`command` 훅 reflect는 금지** — 자체 curl이 별도 connection(다른 mcp-session-id)을 만들어 0행 매치. reflect는 반드시 `mcp_tool`(연결 재사용).
- **왜 기본 OFF (audit 검증 위험):**
  - **중복-reflect 레이스(비멱등).** 클라이언트 `tool_reflect`는 `mgr.reflect()`를 **무조건** 호출하고 `markReflected().catch()`를 **await 없이** fire-and-forget한다(`memory.js:449,456`). 서버 autoReflect의 유일한 가드는 `activity.reflected`의 **비원자적 Redis GET+SETEX**(`SessionActivityTracker.js:31,72`)라, 클라이언트 reflect와 연결-종료 autoReflect가 **둘 다 실행 → 중복 세션 요약**이 날 수 있다. 또 클라이언트 경로엔 `_shouldSkipReflect`의 `explicitCount>=1` 게이트(`AutoReflect.js:181`)가 없어 서버 정책이면 억제할 요약을 낼 수 있다.
  - **연결 재사용 전제 미검증.** `mcp_tool`이 CLI 지속 연결을 재사용한다는 전제가 틀리면 **조용한 no-op**.
  - **graceful-only.** 크래시 미발화 → 서버 backstop 필요(단 서버 autoReflect는 **Gemini CLI 없으면 no-op**, `AutoReflect.js:55-62` → 순수 중복은 아님).
  - **활성화 전 선결.** `--with-eager-reflect`를 쓰려면 클라이언트 `tool_reflect`가 `activity.reflected` 시 skip하거나 `mgr.reflect()`를 **원자적 Redis SET NX**로 가드 + `markReflected`를 **await**하도록 수정돼야 한다. 그 전엔 서버 기본(autoReflect+유휴스윕)에 의존.

**`remember`는 세션종료 훅 대상이 아니다.** `remember`는 모델이 작성하는 **자기완결 content**가 필요한데 셸/훅은 그 품질의 파편을 합성할 수 없다. 세션종료 영속화 도구는 `reflect`(세션의 기존 파편 자동 종합)이며, 개별 사실의 `remember`는 세션 중 모델 주도로 남긴다.

**주기 `memory_consolidate`.** 마스터 키 전용(`lib/tools/memory.js:620-622`)이라 클라이언트 호출 불가 → 서버 측 유지보수. v1의 `schtasks`/`launchd` L3 스케줄러는 삭제(서버 유휴 스윕이 대체).

---

## 11. onboard 서브커맨드 동작 명세

### 11.1 단계
1. **detect** — OS(`process.platform`) + 설치 CLI(`~/.claude`/`$CLAUDE_CONFIG_DIR`, `~/.codex`/`$CODEX_HOME` 존재). env override 존중.
2. **register (L0)** — Claude `claude mcp add ... --transport http`; Codex TOML round-trip 멱등 삽입(존재 시 skip).
3. **hook (L2, 선택)** — 지원 CLI에 SessionStart→context 훅 deep-merge(네이티브 JSON, 기존 키 바이트 보존, 백업 후).
4. **backstop (L1, 선택)** — `--with-rules-pointer` 시 1줄 @import 추가(관리블록 마커).
5. **verify** — §11.3 수용 기준 실행, 적용/스킵 사유 로그.

### 11.2 플래그
| 플래그 | 동작 |
|--------|------|
| `--endpoint host:port` | **필수.** MCP URL. 미지정 시 종료코드 2(localhost 기본값 금지) |
| `--key <값>` / `--key-env <NAME>` | **필수.** 운영자가 발급한 **per-platform 키**(마스터 키 금지). onboard는 키를 생성하지 않음(생성 라우트는 마스터 게이트). 마스터 키와 동일하면 거부 |
| `--claude` / `--codex` | 대상 CLI 한정(기본: 탐지된 전부) |
| `--with-hook` / `--no-hook` | L2 SessionStart 훅 설치 여부(기본 설치, 미지원 시 자동 skip) |
| `--with-rules-pointer` | L1 1줄 백스톱 추가(기본 미추가 — 서버 instructions로 충분) |
| `--with-eager-reflect` | **기본 OFF.** SessionEnd→reflect mcp_tool 훅(C5). 중복-reflect 레이스 수정 + 연결재사용 버전 검증 후에만 사용(§10) |
| `--profile global\|project` | global=`~/.claude`·`~/.codex`(기본); project=`<repo>` |
| `--dry-run` | 변경 없이 계획만 출력 |
| `--uninstall` | 등록/훅/백스톱 역행, 백업 보존 |

### 11.3 수용 기준 (결정적·정정됨)
1. **연결.** `claude mcp list`에 `memento ... Connected`; Codex `config.toml`에 `[mcp_servers.memento]` 정확히 1개, Codex 정상 기동.
2. **헬스.** `curl <endpoint>/health` → HTTP 200, body `status ∈ {healthy,degraded}` (`{"ok":true}` 아님).
3. **인증 강제.** Bearer 없는 `/mcp` 요청이 **401/403로 거부**됨. *(정정: ACCESS_KEY 미설정만으로 open-auth가 되는 게 아니라 **`MEMENTO_AUTH_DISABLED=true` 명시 opt-in**일 때만 open-auth다 — `auth.js:44-46,49-50`. 미설정+AUTH_DISABLED 미설정 = fail-closed 거부.)* 서버 env에 `MEMENTO_ACCESS_KEY`가 설정됐고 `MEMENTO_AUTH_DISABLED`가 미설정인지 확인.
4. **L2 발화(선택).** 새 세션에서 `~/.memento/hooks.log`에 `SessionStart` 1줄 기록(모델 회상이 아닌 로그로 검증).
5. **멱등·머지 안전.** 재실행 시 타깃 바이트 동일(백업만 증가); `~/.claude/settings.json` 기존 top-level 키 바이트 보존, `hooks` 중복 엔트리 없음; `config.toml` 재파싱 정상·기존 `notify`/키 보존.
6. **uninstall 복원.** 등록/훅/백스톱 제거, 사용자 원본 보존, 종료 0.
7. **시크릿 부재.** 설정 파일에 키 평문 없음(Bearer는 env/등록 시점만).

---

## 12. 보안
- 마스터/발급 키를 `settings.json`/`config.toml`/`CLAUDE.md`/`AGENTS.md`에 평문 기재 금지. Codex는 `bearer_token_env_var`(값 아닌 env명). Claude `--header`는 `$MEMENTO_ACCESS_KEY` env 보간 — `~/.claude.json`에 평문이 남을 수 있으므로 **per-platform 키**(마스터 아님)만 사용, 파일 권한 제한.
- **내부 IP 하드코딩 금지**(`INSTALL.md:423`) — 항상 `<endpoint>` 변수.
- fail-closed 유지: `MEMENTO_AUTH_DISABLED=true`를 자동 설정하지 않는다.
- 편집 전 타임스탬프 백업, atomic write(temp→rename), 손상 감지 시 변경 없이 중단.

---

## 13. 크로스플랫폼 매트릭스

| OS | CLI | Layer | 메커니즘 | 경로 |
|----|-----|-------|----------|------|
| Win/mac | Claude | L0 | `claude mcp add --transport http` | `~/.claude.json` (settings.json `mcpServers` 무시) |
| Win/mac | Codex | L0 | `[mcp_servers.memento]` round-trip | `~/.codex/config.toml`(`$CODEX_HOME`) |
| Win/mac | Claude | L2 | SessionStart→context 훅(선택) | `~/.claude/settings.json` `hooks` |
| Win/mac | Codex | L2 | SessionStart command 훅(지원 시) 또는 서버 instructions | `~/.codex/config.toml` `[hooks]` |
| Win/mac | 공통 | L1 | **서버 instructions**(+선택 1줄 @import) | `jsonrpc.js:314` / `CLAUDE.md`·`AGENTS.md` |
| Win/mac | 공통 | L4 | `get_skill_guide` | (서버) |
| Win/mac | 공통 | 종료/유휴 reflect | **서버 auto/idle reflect** | `sessions.js`·`scheduler.js` |

OS차는 훅 셔임 인터프리터(`.sh`/`.ps1`)뿐 — 핵심 로직은 단일 Node 서브커맨드.

---

## 14. 오픈 이슈 / 확장
- **고정해야 할 외부-CLI 계약 5종(이 레포는 테스트 레버리지 0 — `lib`의 유일한 `mcp_tool` 문자열은 Prometheus 메트릭명):** ① Claude `mcp_tool` 훅 타입+최소버전+`{server,tool,input}` 스키마, ② `UserPromptSubmit` mcp_tool의 `${prompt}` 미보간, ③ `SessionEnd` graceful-only 발화, ④ `mcp_tool`의 CLI 지속연결 재사용, ⑤ Codex `bearer_token_env_var`/`[mcp_servers]` 테이블 형태. 스펙에 **버전 명시 상수**로 고정하고, onboard는 **CLI별 post-register liveness probe**(Claude `mcp list`→Connected; Codex spawn→connect)로 잘못된 형태가 **조용한 no-op이 아니라 설치 시 시끄럽게 실패**하게 한다. 이 가정들은 전부 선택 기능(C3/C5)에 몰려 있어 CLI 업데이트 시 core(C1/C2/C7)는 깨지지 않고 옵션만 no-op로 강등된다.
- **C6 TOML 의존성:** TOML 라이브러리는 `optionalDependencies`로 두고 **Codex 경로에서만 lazy-load**(Claude는 네이티브 JSON). 골든-픽스처 CI로 바이트-멱등 재실행 + 미지의 top-level 키 보존 + write 후 parse-back 무손실 검증.
- **C7 그룹 배정 자동 검증:** register 후 새 연결로 `recall`/`memory_stats`를 호출해 공급 키가 의도한 키 그룹으로 resolve되는지 assert; 멀티-CLI에서 공급 키가 서버 마스터 키와 같으면 경고/거부.
- **엔드포인트:** 단일 머신=`127.0.0.1:57332`, 원격=`<host>:57332`. `--endpoint` 필수화로 localhost 오등록 방지.
- **신규 CLI(Gemini/Qwen/OpenCode):** `lib/cli/onboard.js`의 어댑터 테이블에 {configDir, instructionFile, mcpRegister, hookSupport}만 추가. L1/L4는 서버 공통이라 추가 작업 거의 없음.
- **Codex 훅 안정화 시:** SessionStart 훅을 기본 결정 경로로 승격.

---

## 부록 A — v1에서 폐기/정정 (red-team 근거)

| 폐기/정정 | 근거 (file:line) |
|-----------|------------------|
| L2 SessionEnd 클라이언트 reflect 삭제 | `SessionLinker.js:29-30`, `FragmentIndex.js:230-232`, `SessionActivityTracker.js:84-85`, `mcp-handler.js:94,125` (CLI session_id ≠ mcp-session-id → no-op) |
| L3 스케줄러(schtasks/launchd) 삭제 | `sessions.js:246,324,492-514`, `scheduler.js:94`, `config.js`(IDLE_REFLECT_HOURS) (서버가 이미 수행) |
| L1 파일 렌더 → 서버 instructions 1차 | `jsonrpc.js:129-314` (instructions가 규칙 전달) |
| 3-런타임 → Node 서브커맨드 | `package.json`(Node 전용), `bin/memento.js`, `lib/cli/_mcpClient.js` |
| health `{"ok":true}` → `{"status":"healthy"}` | `health-handler.js:86-100`, `docs/getting-started/claude-code.md:139` |
| get_skill_guide 11 enum → 12 자유문자열(cbr) | `lib/tools/memory.js:711-725`, `memory-schemas.js:1005-1011`(no enum) |
| Codex 키/내부 IP → 외부·미검증 라벨, `<endpoint>` | repo grep 0건; `INSTALL.md:423` |
| 버전 v2.7.0 → 4.5.0 | `package.json:3` |

## 부록 B — Before / After 요약

| Before | After | Easy explanation | Example |
|--------|-------|------------------|---------|
| v1: 4레이어 bespoke 3-런타임 인스톨러 | v2: 서버-우선, Node 서브커맨드(L0+선택 훅) | 서버가 이미 하는 일(규칙·reflect) 재발명 제거 | `memento-mcp onboard --endpoint 127.0.0.1:57332` |
| L2/L3 reflect (검증 결과 no-op) | 삭제, 서버 auto/idle reflect에 위임 | 클라이언트 session_id로는 reflect가 0행 매치 | `sessions.js`·`scheduler.js` |
| 잘못된 사실(health `ok`, 11 enum, 내부 IP) | 소스 대조 정정 | 구현자가 깨진 값으로 코딩하는 것 방지 | `{"status":"healthy"}`, 12 sections incl `cbr` |
| Discord 스크린샷 업로드 | N/A | 문서 명세 작업, 시각/PIE 산출물 없음 | N/A |

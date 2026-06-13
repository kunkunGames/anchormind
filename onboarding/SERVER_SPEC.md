# Memento Onboarding — SERVER SPEC

| 항목 | 값 |
|------|-----|
| 문서 | memento-mcp **서버** 설치/프로비저닝 온보딩 명세 |
| 위치 | `memento-mcp/onboarding/SERVER_SPEC.md` |
| 대상 | memento-mcp 서버 호스트(서버를 띄우는 머신) |
| memento 버전 | 4.5.0 (`package.json:3`) |
| 1차 도구 | `setup.sh`(대화형) + `scripts/migrate.js` + `server.js` |
| 짝 문서 | 클라이언트 연결은 [`CLIENT_SPEC.md`](./CLIENT_SPEC.md), 구분은 [`SPEC.md`](./SPEC.md) 인덱스 |
| 근거 | `setup.sh`, `package.json`, `docs/INSTALL.md`, `lib/memory/memory-schema.sql`, `lib/config.js`, `lib/auth.js` |

---

## 1. 개요

### 1.1 목적
**memento-mcp 서버 자체를 설치·프로비저닝**한다: 의존성, `.env`, PostgreSQL(pgvector) 스키마/마이그레이션, 임베딩·LLM provider, 마스터 키, 서버 기동. 산출물은 **HTTP MCP 엔드포인트(`http://<host>:57332/mcp`)가 떠 있고 `GET /health`가 healthy인 상태**다.

### 1.2 비목표 (← CLIENT_SPEC 영역)
- 클라이언트 CLI(Claude/Codex)를 이 서버에 **연결**(MCP 등록·훅·키 그룹 배정)하는 작업은 [`CLIENT_SPEC.md`](./CLIENT_SPEC.md)가 다룬다.
- 서버는 한 번 설치되면 N개의 클라이언트가 붙는다. 본 문서는 **서버 1회 설치**, CLIENT_SPEC는 **클라이언트마다 반복**.

### 1.3 두 온보딩 구분

| | SERVER onboarding (본 문서) | CLIENT onboarding (`CLIENT_SPEC.md`) |
|---|---|---|
| 대상 | 서버 호스트 1대 | 클라이언트 CLI마다(Claude/Codex), 머신마다 |
| 무엇 | DB·임베딩·.env·마이그레이션·서버 기동 | MCP 등록 + (선택) 시작/질의/종료 훅 |
| 도구 | `setup.sh` / `scripts/migrate.js` / `server.js` | `memento-mcp onboard`(Node 서브커맨드) |
| 빈도 | 1회(+업그레이드) | 클라이언트×머신마다 |
| 산출 | `/mcp` 엔드포인트 + 마스터/플랫폼 키 | 연결된 CLI + 결정적 기억 훅 |

---

## 2. 사전 요구 (Prerequisites)

| 구성요소 | 요구 | 비고 |
|----------|------|------|
| Node.js | ESM(`"type":"module"`) + `node --test` 사용 → **Node 20+ 권장** | `package.json` |
| PostgreSQL | **pgvector 확장** 필요(`MEMENTO_STORAGE=pgvector` 기본, `INSTALL.md:270`) | 벡터 시맨틱 검색 |
| Redis | **선택**(세션/캐시). `REDIS_ENABLED=false`로 비활성 가능 | `ioredis` |
| 임베딩 provider | openai/gemini/ollama/localai/custom/transformers/none 중 1 | §6 |
| LLM provider | gemini-cli/codex-cli/copilot-cli/skip (formateme·consolidate·reflect용) | 로컬 CLI 로그인 필요 |
| psql 클라이언트 | 스키마/마이그레이션 적용에 필요 | `setup.sh`가 `psql` 호출 |

핵심 의존성(`package.json`): `@modelcontextprotocol/sdk`, `pg`, `ioredis`, `@huggingface/transformers`(로컬 임베딩), `openai`, 형태소 분석(`@node-rs/jieba`/`kuromoji`/`garu-ko`).

---

## 3. 설치 경로 (3종)

### 3.1 (A) 대화형 — `bash setup.sh` (권장)
`setup.sh`가 순서대로 묻고 `.env`를 생성한다(`chmod 600`):
1. **Server**: PORT(57332), SESSION_TTL_MINUTES(43200=30일), LOG_DIR, **MEMENTO_ACCESS_KEY**(v2.7.0+ 필수; 빈 값이면 `MEMENTO_AUTH_DISABLED=true` dev 모드 선택지).
2. **PostgreSQL**: host/port/db/user/password → `DATABASE_URL`(비밀번호는 `urllib.parse.quote` 인코딩), `DB_MAX_CONNECTIONS`.
3. **Redis**: enable 여부 + host/port/password/db (+ Sentinel HA 주석).
4. **Embedding provider**: §6.
5. **LLM chain**: primary + fallback(`[{"provider":"codex-cli"},{"provider":"copilot-cli"}]`).
6. `npm install` (선택).
7. **DB 스키마**: fresh(`memory-schema.sql`) 또는 upgrade(`migration-*.sql` 순차) §7.
8. 필요 시 `post-migrate-flexible-embedding-dims.js`(차원>2000), `normalize-vectors.js`(L2 정규화 1회), `check-embedding-consistency.js`.
9. 완료 → `node server.js`, `curl http://localhost:<PORT>/health`.

### 3.2 (B) 수동 설치 (`docs/INSTALL.md` "수동 설치")
```bash
npm install
# (CUDA 환경 ONNX 오류 시) npm install --onnxruntime-node-install-cuda=skip
# .env 작성 (.env.example 참조 — DATABASE_URL, MEMENTO_ACCESS_KEY 필수)
psql "$DATABASE_URL" -f lib/memory/memory-schema.sql   # fresh
node scripts/migrate.js                                # 또는 마이그레이션
node server.js
```

### 3.3 (C) Docker
`Dockerfile` + `docker-compose.dev.yml` 제공. 외부 Postgres/Redis를 환경변수로 주입. (운영 compose는 별도 — 본 문서 범위 밖, `docs/INSTALL.md` 참조.)

---

## 4. 환경변수(.env) 핵심 그룹

`setup.sh`가 생성하는 `.env`의 그룹(전체는 `.env.example`):

| 그룹 | 주요 키 | 메모 |
|------|---------|------|
| Server | `PORT`(57332), `SESSION_TTL_MINUTES`, `LOG_DIR`, `NODE_ENV`, `LOG_LEVEL` | |
| Auth | **`MEMENTO_ACCESS_KEY`**(마스터, 필수), `MEMENTO_AUTH_DISABLED`(dev) | §8 |
| CORS/RateLimit | `ALLOWED_ORIGINS`, `ADMIN_ALLOWED_ORIGINS`, `RATE_LIMIT_*` | |
| PostgreSQL | `DATABASE_URL`, `POSTGRES_*`, `DB_MAX_CONNECTIONS`, `DB_*_TIMEOUT*` | pgvector |
| Redis | `REDIS_ENABLED`, `REDIS_HOST/PORT/PASSWORD/DB`, `REDIS_SENTINEL_*` | 선택 |
| Cache | `CACHE_ENABLED`, `CACHE_DB_TTL` | |
| Embedding | `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `OPENAI_API_KEY`/`GEMINI_API_KEY`/`EMBEDDING_BASE_URL` | §6 |
| LLM | `LLM_PRIMARY`, `LLM_FALLBACKS` | consolidate/reflect |
| Consolidation | `CONSOLIDATE_INTERVAL_MS`(기본 21600000=6h) | §10 |
| TrustProxy | `TRUST_PROXY_HOPS` | 리버스 프록시 뒤 클라이언트 IP |

> 비밀(키/비밀번호)은 `.env`에만, `chmod 600`. 절대 커밋 금지.

---

## 5. 인증·키 모델 (서버가 발급, 클라이언트가 소비)

- **마스터 키 `MEMENTO_ACCESS_KEY`**: v2.7.0+ 필수. 미설정 + `MEMENTO_AUTH_DISABLED` 미설정 = **fail-closed**(모든 요청 거부, `lib/auth.js`). 마스터 키는 `keyId=null`로 인증되어 **모든 파편 + 마스터 전용 도구**(`memory_consolidate` 등) 접근.
- **per-platform DB API 키**: Admin Console(`/v1/internal/model/nothing`, 마스터 키 로그인) → API Keys → CREATE → 시크릿 1회 표시. 테넌트 격리용.
- **키 그룹**(`migration-011-key-groups.sql`): 여러 per-platform 키를 한 그룹에 넣으면 기억 공유. **클라이언트 온보딩(CLIENT_SPEC §6.2)이 이 키/그룹을 사용**한다 — 서버 온보딩은 마스터 키 + (필요 시) per-platform 키 발급까지 책임진다.

---

## 6. 임베딩 provider & 차원

| 선택 | provider | 모델 | dims |
|------|----------|------|------|
| 1 | openai | text-embedding-3-small | 1536 |
| 2 | gemini | gemini-embedding-001 | 3072 |
| 3 | ollama | nomic-embed-text | 768 |
| 4 | localai | (OpenAI 호환) | 1536 |
| 5 | custom | `EMBEDDING_BASE_URL` 지정 | 수동 |
| 6 | none | 시맨틱 검색 비활성 | — |
| 7 | transformers | Xenova/multilingual-e5-small(384) / bge-m3(1024) | 로컬, **API 키 금지**(상호배타 가드) |

- **dims > 2000**(예 gemini 3072) 또는 transformers → `scripts/post-migrate-flexible-embedding-dims.js` 필수(`fragments`+`morpheme_dict` 두 테이블 동시 처리, v2.9.0+).
- provider/모델 변경 시 `scripts/backfill-embeddings.js`로 기존 파편 재임베딩(임베딩 API 키 필요, 1회성).
- 설치 후 `scripts/normalize-vectors.js`(L2 정규화 1회) + `check-embedding-consistency.js`로 차원 일관성 검증.

---

## 7. DB 스키마 / 마이그레이션

- **Fresh**: `psql "$DATABASE_URL" -f lib/memory/memory-schema.sql`.
- **Upgrade**: `node scripts/migrate.js`(또는 `lib/memory/migration-*.sql`를 번호순 적용). `IF NOT EXISTS` 가드로 **멱등**.
- **대규모 DB 주의**: `migration-034-v2.16.0-bundle`의 `CREATE UNIQUE INDEX`가 테이블 잠금 유발 가능 → `docs/INSTALL.md`의 "CONCURRENTLY" 섹션대로 수동 선실행.
- 마이그레이션 후 **서버 재시작** 필요(새 컬럼/인덱스 반영).
- `npm run lint:migrations`로 마이그레이션 정합성 점검.

---

## 8. 서버 기동 / 서비스화

- 시작: `node server.js` 또는 `npm start` 또는 `memento-mcp serve`(`bin/memento.js`).
- 리스닝: `0.0.0.0:<PORT>`(기본 57332), 엔드포인트 `POST /mcp`(+`GET /mcp` SSE, `DELETE /mcp`), `GET /health`.
- 프로세스 관리: systemd/launchd/pm2/Docker로 상시 기동(본 문서는 권고만; OS별 유닛은 운영 환경에 맞춤).
- 리버스 프록시 뒤라면 `TRUST_PROXY_HOPS` 설정(클라이언트 IP 추출).

---

## 9. 운영 (서버 측 유지보수)

- **세션 종료/유휴 reflect**: 서버가 자동 수행 — 종료 시 autoReflect(`lib/sessions.js:246,324`), 5분 유휴 스윕으로 `IDLE_REFLECT_HOURS`(기본 24h) 경과 세션 reflect(`lib/scheduler.js:94`). **클라이언트는 이를 재발명하지 않는다**(CLIENT_SPEC §10).
- **주기 consolidate**: `memory_consolidate`는 마스터 키 전용(`lib/tools/memory.js:620-622`) → 서버 측 작업(cron 등)으로 마스터 키 사용. `CONSOLIDATE_INTERVAL_MS` 참고.
- **노이즈 정리/백필**: `scripts`의 정리/백필 스크립트(`docs/INSTALL.md`).
- **로그**: `LOG_DIR`(winston-daily-rotate), 메트릭 `prom-client`.

---

## 10. 검증 / 수용 기준

1. `curl http://localhost:<PORT>/health` → HTTP 200, body `{"status":"healthy"}`(미인증은 `{status,timestamp}`; 불건전 시 503).
2. **fail-closed 확인**: `MEMENTO_ACCESS_KEY` 설정 시, Bearer 없는 `/mcp` 요청이 401/403로 거부.
3. MCP 핸드셰이크: `initialize` → `MCP-Session-Id` 헤더 수신 → `tools/list`가 도구 16~17개 반환.
4. 임베딩 일관성: `check-embedding-consistency.js` 통과(`fragments`/`morpheme_dict` 차원 일치).
5. LLM 체인: `npm run test:integration:llm`(E2E_LLM_* 필요) 또는 한 번의 reflect가 요약 생성.
6. 재시작 후에도 마이그레이션/`.env`가 반영되어 동일 동작.

---

## 11. 보안
- `.env` `chmod 600`, 마스터 키·DB 비밀번호 평문은 `.env`에만. `MEMENTO_AUTH_DISABLED=true`는 dev 전용(운영 금지).
- 내부 IP/포트를 외부 문서에 하드코딩 금지(`docs/INSTALL.md:423`). 클라이언트엔 마스터 키가 아니라 **per-platform 키**만 배포(§5, CLIENT_SPEC §12).
- CORS(`ALLOWED_ORIGINS`/`ADMIN_ALLOWED_ORIGINS`) + RateLimit를 운영 도메인에 맞게 설정.

---

## 12. 핸드오프 → CLIENT_SPEC

서버 온보딩 완료 후 클라이언트 온보딩에 전달할 값:
- **엔드포인트** `http://<host>:57332/mcp`(로컬 단일 머신=`127.0.0.1`).
- **per-platform API 키**(마스터 아님) — 같은 키 그룹에 배정.
이 둘을 [`CLIENT_SPEC.md`](./CLIENT_SPEC.md)의 `memento-mcp onboard --endpoint ...` + 키 그룹 배정에 사용한다.

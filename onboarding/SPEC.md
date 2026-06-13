# Memento Onboarding — 인덱스 (Server vs Client)

memento 온보딩은 **명확히 다른 두 작업**이다. 이 디렉터리는 각각을 별도 스펙으로 분리한다.

| | **SERVER onboarding** | **CLIENT onboarding** |
|---|---|---|
| 문서 | [`SERVER_SPEC.md`](./SERVER_SPEC.md) | [`CLIENT_SPEC.md`](./CLIENT_SPEC.md) |
| 무엇을 | memento-mcp **서버 자체**를 설치·프로비저닝 (DB·pgvector·임베딩·`.env`·마이그레이션·마스터 키·서버 기동) | 실행 중인 서버에 **클라이언트 CLI**(Claude Code / Codex)를 연결 (MCP 등록 + 선택적 시작/질의/종료 훅) |
| 대상 | 서버 호스트 1대 | 클라이언트 CLI마다 · 머신마다 |
| 1차 도구 | `setup.sh` · `scripts/migrate.js` · `server.js` | `memento-mcp onboard` (Node 서브커맨드) |
| 빈도 | 1회 (+업그레이드) | 클라이언트 × 머신마다 반복 |
| 산출물 | `http://<host>:57332/mcp` 가동 + `/health` healthy + 키 발급 | 연결된 CLI + 결정적 기억 훅 |

## 순서

```
1) SERVER onboarding  (SERVER_SPEC.md)
   서버 설치 → /mcp 가동 → 마스터 키 + per-platform 키(키 그룹) 발급
        │  핸드오프: 엔드포인트(http://<host>:57332/mcp) + per-platform 키
        ▼
2) CLIENT onboarding  (CLIENT_SPEC.md)
   각 CLI를 그 엔드포인트/키로 등록 + (선택) SessionStart→context / 첫 질의→recall / SessionEnd→reflect 훅
```

## 핵심 경계
- **서버가 이미 하는 일**(클라이언트가 재발명하지 않음): always-on 규칙 전달(서버 `instructions` 필드), 세션종료·유휴 reflect(autoReflect + 유휴 스윕), 심층 가이드(`get_skill_guide`), 주기 consolidate(마스터 키). → 상세 근거는 각 스펙.
- **클라이언트만 할 수 있는 일**: 각 CLI의 MCP 등록(L0)과, 시작/질의 시점의 결정적 훅(L2). → `CLIENT_SPEC.md`.

> 본 `SPEC.md`는 인덱스다. 구현 명세는 위 두 문서에 있다.

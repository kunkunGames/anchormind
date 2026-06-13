# Memento Onboarding — 인덱스 (Server vs Client)

memento 온보딩은 **명확히 다른 두 작업**이다. 이 디렉터리는 각각을 별도 스펙으로 분리한다.

| | **SERVER onboarding** | **CLIENT onboarding** |
|---|---|---|
| 문서 | [`SERVER_SPEC.md`](./SERVER_SPEC.md) | [`CLIENT_SPEC.md`](./CLIENT_SPEC.md) |
| 무엇을 | memento-mcp **서버 자체**를 설치·프로비저닝 (DB·pgvector·임베딩·`.env`·마이그레이션·마스터 키·서버 기동) | 실행 중인 서버에 **클라이언트 CLI**(Claude Code / Codex)를 연결 (MCP 등록 + 키 검증) |
| 대상 | 서버 호스트 1대 | 클라이언트 CLI마다 · 머신마다 |
| 1차 도구 | `setup.sh` · `scripts/migrate.js` · `server.js` | `memento-mcp onboard` (Node 서브커맨드) |
| 빈도 | 1회 (+업그레이드) | 클라이언트 × 머신마다 반복 |
| 산출물 | `http://<host>:57332/mcp` 가동 + `/health` healthy + 키 발급 | 연결된 CLI (운영 규칙·reflect는 서버가 담당) |

## 순서

```
1) SERVER onboarding  (SERVER_SPEC.md)
   서버 설치 → /mcp 가동 → 마스터 키 + per-platform 키(키 그룹) 발급
        │  핸드오프: 엔드포인트(http://<host>:57332/mcp) + per-platform 키
        ▼
2) CLIENT onboarding  (CLIENT_SPEC.md)
   각 CLI를 그 엔드포인트/키로 등록 + 키 검증 (운영 규칙·reflect는 서버가 담당; 클라 훅·스케줄러 없음)
```

## 핵심 경계
- **서버가 이미 하는 일**(클라이언트가 재발명하지 않음): always-on 규칙 전달(서버 `instructions` 필드), 세션종료·유휴 reflect(autoReflect + 유휴 스윕), 심층 가이드(`get_skill_guide`), 주기 consolidate(마스터 키). → 상세 근거는 각 스펙.
- **윈도우 스케줄러 완전 폐기.** 클라이언트 측 OS 스케줄러(Windows `schtasks` / macOS `launchd` / cron)는 온보딩에서 **전면 삭제**한다. 주기·유휴 reflect는 **서버의 autoReflect-on-close + 5분 유휴 스윕(`IDLE_REFLECT_HOURS`)** 이, 주기 consolidate는 서버 측 작업이 대체한다(클라이언트 스케줄러 없음·불가). → 상세는 `CLIENT_SPEC.md` §10, `SERVER_SPEC.md` §9.
- **클라이언트만 할 수 있는 일**: 각 CLI의 MCP 등록(L0) + 키 검증. (클라 훅·OS 스케줄러는 제거됨 — 운영 동작은 서버 instructions/autoReflect가 담당.) → `CLIENT_SPEC.md`.

> 본 `SPEC.md`는 인덱스다. 구현 명세는 위 두 문서에 있다.

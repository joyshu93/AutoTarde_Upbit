# AutoTrade_Upbit Project Guide

작성 기준일: 2026-06-29

이 문서는 현재 프로젝트를 한눈에 보기 위한 한국어 운영/개발 지도입니다. 세부 안전 계약의 최종 기준은 `PRODUCT_BOUNDARY.md`, `ARCHITECTURE.md`, `RISK_POLICY.md`, `ORDER_LIFECYCLE.md`, `README.md`입니다.

## 1. 프로젝트 한 줄 정의

`AutoTrade_Upbit`는 Upbit 전용 `KRW-BTC`, `KRW-ETH` 현물 실행 시스템입니다.

목표는 단순 자동매매 봇이 아니라, 주문/체결/잔고/포지션/리스크/복구 이력을 로컬 SQLite에 명시적으로 남기고 Telegram으로 운영자가 확인/제어할 수 있는 실행 시스템을 만드는 것입니다.

## 2. 제품 경계

### 하는 일

- Upbit BTC/ETH 현물 시장만 지원합니다.
- deterministic rule-based strategy를 실행합니다.
- 기본 실행 모드는 항상 `DRY_RUN`입니다.
- `LIVE` 주문 전송은 `APP_EXECUTION_MODE=LIVE`, `ENABLE_LIVE_ORDERS=true`, Upbit credentials가 모두 있을 때만 가능합니다.
- Telegram은 운영자 인터페이스입니다.
- 로컬 SQLite DB는 주문, 체결, 스냅샷, 리스크, reconciliation, 알림, scheduler 이력을 저장합니다.

### 하지 않는 일

- Telegram으로 수동 현금/포지션을 입력받지 않습니다.
- LLM 판단으로 매수/매도하지 않습니다.
- 선물, 마진, 레버리지, 파생상품을 다루지 않습니다.
- 여러 거래소를 라우팅하지 않습니다.
- 실패를 조용히 무시하지 않습니다.

## 3. 현재 구현 상태 요약

현재 프로젝트는 `DRY_RUN` 검증과 제한적 `LIVE` 준비 단계까지 구현되어 있습니다.

- `DRY_RUN` 수동 실행, `/sync`, `/run BTC|ETH`, Telegram inspection, scheduler rehearsal, completion gate까지 검증되었습니다.
- `LIVE` 런타임은 scheduler disabled 상태에서 시작/readiness/sync 흐름까지 확인되었습니다.
- `LIVE` 자동 scheduler는 구현되어 있지만, 별도 confirmation과 preflight smoke를 거쳐야 하며 기본값은 비활성입니다.
- 실제 Upbit 주문 전송 경로는 구현되어 있으나 기본값은 막혀 있습니다.
- 장시간 안정성 테스트는 아직 별도 완료 항목으로 보지 않습니다.
- 사용자가 2026-06-29에 프로그램을 직접 종료했으므로, 현재 운영 기준은 "프로세스 꺼짐, 다음 실행 전 smoke/readiness 재확인 필요"입니다.

## 4. 개발 완료 목록

### 4.1 기반 구조

- TypeScript strict 기반 Node.js 프로젝트 구성
- modular monolith 구조 구성
- `domain`, `strategy`, `risk`, `exchange`, `execution`, `reconciliation`, `telegram`, `db`, `app`, `smoke` 모듈 경계 구성
- Node.js `node:sqlite` 기반 로컬 SQLite persistence 구성
- `DATABASE_PATH` 기반 DB 경로 설정
- runtime configuration 파서와 안전 기본값 구성
- `npm run build`, `npm run typecheck`, `npm run test`, `npm run check` 스크립트 구성

### 4.2 도메인/DB

- 지원 자산/시장 타입 정의: `BTC`, `ETH`, `KRW-BTC`, `KRW-ETH`
- 실행 모드 타입 정의: `DRY_RUN`, `LIVE`
- 주문, 주문 이벤트, 체결, 전략 결정, 잔고 스냅샷, 포지션 스냅샷 타입 정의
- 리스크 이벤트와 reconciliation record 타입 정의
- operator execution state와 transition 이력 정의
- SQLite migration 구성
- 주요 테이블 구성:
  - `users`
  - `exchange_accounts`
  - `execution_state`
  - `execution_state_transitions`
  - `strategy_decisions`
  - `balance_snapshots`
  - `position_snapshots`
  - `orders`
  - `order_events`
  - `fills`
  - `reconciliation_runs`
  - `strategy_scheduler_runs`
  - `operator_notifications`
  - `operator_notification_delivery_attempts`
  - `operator_notification_delivery_runs`
  - `telegram_inbound_offsets`
  - `risk_events`

### 4.3 리스크/실행 안전장치

- global kill switch guard
- pause/resume guard
- degraded startup health guard
- duplicate order guard
- stale price guard
- minimum order value guard
- per-asset allocation cap
- total exposure cap
- live-mode dual gate
- order idempotency key 생성
- persistence-before-submit 원칙 적용
- Upbit `orders/chance` precheck
- Upbit `orders/test` precheck
- risk rejection durable 기록
- live send path 기본 차단

### 4.4 주문 생명주기

- 공통 주문 상태 모델 구성:
  - `INTENT_CREATED`
  - `RISK_REJECTED`
  - `PERSISTED`
  - `SUBMITTING`
  - `OPEN`
  - `PARTIALLY_FILLED`
  - `FILLED`
  - `CANCEL_REQUESTED`
  - `CANCELED`
  - `REJECTED`
  - `FAILED`
  - `RECONCILIATION_REQUIRED`
- `DRY_RUN` adapter 구현
- `DRY_RUN` 주문의 synthetic accepted/filled evidence 기록
- simulated fill이 exchange balance truth로 취급되지 않도록 분리
- `LIVE` adapter wiring 조건 구현
- exchange UUID와 raw response 저장 흐름 구성
- 주문 단건 조회 `/order <order-id|identifier>` 구현

### 4.5 Upbit 연동

- Upbit private auth/signing 구현
- Upbit private client 구현
- Upbit public ticker/candle client 구현
- balance read 구현
- order chance/test/create/cancel/get-order interface 구성
- public market data를 PositionGuard snapshot input으로 정규화

### 4.6 Reconciliation/Recovery

- `/sync` 기반 operator-triggered reconciliation 구현
- startup recovery sweep 구현
- exchange-backed balance snapshot persistence
- exchange-backed position snapshot persistence
- active order reconciliation
- terminal order fill/status backfill
- portfolio drift detection
- simulated DRY_RUN fill 제외 처리
- `dryrun_*` UUID를 Upbit에 조회하지 않고 로컬 repair 처리
- per-run order lookup budget
- recent open/closed exchange order recovery
- checkpointed archival closed-order recovery
- recovery coverage/confidence metadata
- retention assumption metadata
- unresolved drift 발생 시 `DEGRADED` operator state 표시
- `/synchistory`, `/recovery` inspection 구현

### 4.7 전략/PositionGuard 포트

- deterministic strategy contract 구성
- safe `HOLD` scaffold 구성
- `PositionGuard_PaperTrade` core strategy port
- market structure analyzer port
- Upbit ticker/1h/4h/1d candle snapshot normalizer
- persisted balance/position/context assembler
- recent filled sell context 반영
- invalidation-first exit, no-chase entry, staged sizing, soft reduce, borderline confirmation semantics 포트
- PositionGuard runner 구성
- `/run BTC|ETH` operator trigger 구현
- eligible decision을 execution lifecycle로 연결

### 4.8 Telegram 운영자 인터페이스

구현된 주요 명령:

- `/help`
- `/start`
- `/config`
- `/readiness`
- `/status`
- `/statehistory`
- `/synchistory`
- `/recovery`
- `/alerts`
- `/risks`
- `/balances`
- `/positions`
- `/orders`
- `/order <order-id|identifier>`
- `/scheduler`
- `/inbound`
- `/pause`
- `/resume`
- `/killswitch`
- `/sync`
- `/run BTC|ETH`

구현된 경계:

- `/help`, `/config`, `/readiness`, `/scheduler`, `/inbound`, `/order`는 inspection 중심이며 주문/동기화/전송을 직접 트리거하지 않습니다.
- Telegram은 balance/position truth가 아닙니다.
- operator chat id만 inbound command로 허용합니다.
- raw secret은 출력하지 않습니다.

### 4.9 Telegram delivery/inbound

- durable `operator_notifications`
- `PENDING`, `SENT`, `FAILED` delivery status
- retry metadata
- delivery lease token
- delivery attempt audit trail
- delivery worker run record
- `/alerts` queue metrics
- Telegram inbound polling disabled-by-default
- inbound offset durable storage
- bounded `smoke:telegram:inbound`

### 4.10 Scheduler

- disabled-by-default strategy scheduler
- BTC/ETH interval 설정
- `RUN_ON_START` 옵션
- account-scoped runner lock
- `RUN_ON_START` 시 BTC/ETH sequential execution 처리
- `strategy_scheduler_runs` persistence
- `/scheduler` runtime + persisted history inspection
- scheduler failure/skip/order result notification
- `LIVE` scheduler startup preflight
- `LIVE` scheduler per-run preflight
- stale persisted health 차단
- startup block notification persistence
- `RUN_ON_START=false` 기본 live scheduler script 구성

### 4.11 Smoke/운영 스크립트

구현된 npm smoke:

- `npm run smoke:dryrun:operator`
- `npm run smoke:dryrun:readiness`
- `npm run smoke:dryrun:sync`
- `npm run smoke:dryrun:completion`
- `npm run smoke:telegram:inbound`
- `npm run smoke:live:readiness`
- `npm run smoke:live:scheduler-preflight`

구현된 PowerShell example scripts:

- `scripts/start-company-dryrun.example.ps1`
- `scripts/start-company-dryrun-scheduler.example.ps1`
- `scripts/start-company-live.example.ps1`
- `scripts/start-company-live-scheduler.example.ps1`
- `scripts/smoke-dryrun-readiness.example.ps1`
- `scripts/smoke-dryrun-sync.example.ps1`
- `scripts/smoke-dryrun-completion.example.ps1`
- `scripts/smoke-live-readiness.example.ps1`
- `scripts/smoke-live-scheduler-preflight.example.ps1`
- `scripts/register-autotrade-dryrun-task.example.ps1`
- `scripts/register-autotrade-live-scheduler-task.example.ps1`
- `scripts/unregister-autotrade-task.example.ps1`

중요 안전 처리:

- local `*.local.ps1`은 Git에 올리지 않는 전제입니다.
- live startup script는 live readiness smoke가 `BLOCK`이면 runtime을 시작하지 않습니다.
- live scheduler startup script는 scheduler preflight smoke가 실패하면 runtime을 시작하지 않습니다.
- Windows Task Scheduler helper는 manual launch만 등록하며 startup/logon trigger와 secret 저장을 하지 않습니다.

### 4.12 테스트

현재 테스트 축:

- env/config
- risk guards
- execution service
- SQLite wiring
- Upbit public/private client
- snapshot service
- portfolio drift
- reconciliation service
- sync controller
- startup recovery
- Telegram commands/contracts/delivery/inbound
- PositionGuard core/context/market-structure/snapshot/runner
- scheduler/preflight/runtime lifecycle
- dryrun smoke scripts
- live readiness/preflight smoke scripts
- Windows task/startup scripts

대표 검증 명령:

```powershell
npm run check
```

## 5. 사용자가 완료한 운영 검증

2026-06-29 기준으로 확인된 운영 검증:

- DRY_RUN exchange-backed `/sync` rehearsal 완료
- DRY_RUN readiness 확인
- DRY_RUN scheduler automatic rehearsal 확인
- DRY_RUN completion gate `PASS` 확인
- Telegram `/scheduler`, `/status`, `/readiness`에서 scheduler run history와 readiness 확인
- LIVE readiness smoke 실행
- LIVE runtime scheduler disabled 상태로 실행
- LIVE `/sync`로 deferred lookup/drift 상태 일부 해소
- LIVE `/readiness`에서 `system_status: RUNNING`, `live_gate: ENABLED`, `active_order_count: 0`, `pending_notification_count: 0` 확인
- LIVE 상태에서 실제 자동 scheduler는 시작하지 않음
- 이후 사용자가 프로그램 종료

현재 이 검증은 "장시간 안정성 테스트 완료"가 아니라 "DRY_RUN 자동 실행 검증 완료 및 LIVE 수동 런타임 진입 검증"으로 보는 것이 정확합니다.

## 6. 남은 개발 목록과 우선순위

### P0. 다음 안전 기능

1. `/preview BTC|ETH` 명령 추가
   - 전략 runner를 실행하되 주문 intent를 실제 execution으로 넘기지 않는 preview 명령입니다.
   - LIVE에서 `/run`을 누르기 전에 어떤 decision/action/order-intent가 나올지 확인하는 안전판입니다.
   - Telegram command, formatter, tests, docs를 함께 추가해야 합니다.

2. LIVE local script와 smoke 문서 재확인
   - 현재 example script에는 smoke 실패 시 runtime 시작 거부가 들어가 있습니다.
   - 사용자의 local copy에도 같은 안전 체크가 반영되어야 합니다.

3. 현재 변경분 checkpoint
   - `npm run check` 재실행
   - Git diff review
   - 적절한 commit 생성

### P1. 첫 실제 주문 전 운영 절차

1. 첫 LIVE `/run BTC|ETH` 운영 playbook 작성
   - 시작 전 `/readiness`
   - `/sync`
   - `/preview BTC|ETH`
   - `/run BTC|ETH`
   - `/orders`, `/order`, `/sync`, `/readiness` 후속 확인

2. LIVE 주문 크기/노출 한도 재검토
   - `MINIMUM_ORDER_VALUE_KRW`
   - `MAX_ALLOCATION_BTC`
   - `MAX_ALLOCATION_ETH`
   - `TOTAL_EXPOSURE_CAP`

3. 주문 후 recovery 관찰 강화
   - partial fill
   - rejected order
   - failed submit
   - reconciliation required

### P2. LIVE 자동 scheduler 전환

1. manual LIVE runtime에서 충분한 수동 검증
2. `npm run smoke:live:scheduler-preflight`
3. `start-company-live-scheduler.local.ps1` 구성
4. `STRATEGY_SCHEDULER_RUN_ON_START=false` 유지
5. 첫 scheduled tick 이후 `/scheduler`, `/alerts`, `/orders`, `/readiness` 확인

### P3. 운영 편의/관측성

1. operator runbook 확장
2. recovery issue code별 대응 표 추가
3. DB 백업/복구 절차 문서화
4. 장시간 runtime stability checklist 추가
5. dashboard 또는 report export 추가
6. 전략 파라미터와 risk budget을 운영자 친화적으로 점검하는 command 추가

## 7. 운영 가이드

### 7.1 기본 개발 검증

```powershell
npm install
npm run check
```

`npm run check`는 typecheck와 test를 함께 실행합니다.

### 7.2 DRY_RUN offline rehearsal

```powershell
npm run smoke:dryrun:operator
```

이 경로는 Upbit private read credential을 지우고 fixture market data를 사용합니다. 실거래 주문을 전송하지 않습니다.

### 7.3 DRY_RUN exchange-backed sync

```powershell
Copy-Item .\scripts\smoke-dryrun-sync.example.ps1 .\scripts\smoke-dryrun-sync.local.ps1
notepad .\scripts\smoke-dryrun-sync.local.ps1
powershell.exe -ExecutionPolicy Bypass -File .\scripts\smoke-dryrun-sync.local.ps1
```

목표:

- Upbit read credentials로 balance/position snapshot을 가져옵니다.
- `/sync` reconciliation evidence를 저장합니다.
- strategy, scheduler, Telegram transport, order transmission은 실행하지 않습니다.

### 7.4 DRY_RUN scheduler rehearsal

```powershell
Copy-Item .\scripts\start-company-dryrun-scheduler.example.ps1 .\scripts\start-company-dryrun-scheduler.local.ps1
notepad .\scripts\start-company-dryrun-scheduler.local.ps1
powershell.exe -ExecutionPolicy Bypass -File .\scripts\start-company-dryrun-scheduler.local.ps1
```

실행 중 Telegram에서 확인:

```text
/scheduler
/status
/alerts
/readiness
```

완료 gate:

```powershell
npm run smoke:dryrun:completion
```

### 7.5 LIVE manual runtime

```powershell
Copy-Item .\scripts\start-company-live.example.ps1 .\scripts\start-company-live.local.ps1
notepad .\scripts\start-company-live.local.ps1
powershell.exe -ExecutionPolicy Bypass -File .\scripts\start-company-live.local.ps1
```

주의:

- `$LiveOrderConfirmation = "I_UNDERSTAND_REAL_ORDERS"`가 필요합니다.
- scheduler는 첫 LIVE 검증에서 disabled가 기본입니다.
- startup script는 `smoke:live:readiness`가 block이면 runtime을 시작하지 않아야 합니다.

LIVE runtime에서 우선 확인할 명령:

```text
/readiness
/config
/sync
/balances
/positions
/orders
/alerts
```

### 7.6 LIVE scheduler

LIVE scheduler는 마지막 단계입니다.

```powershell
npm run smoke:live:scheduler-preflight
```

이 smoke가 통과하고 운영자가 자동 주문을 명시적으로 승인한 뒤에만:

```powershell
Copy-Item .\scripts\start-company-live-scheduler.example.ps1 .\scripts\start-company-live-scheduler.local.ps1
notepad .\scripts\start-company-live-scheduler.local.ps1
powershell.exe -ExecutionPolicy Bypass -File .\scripts\start-company-live-scheduler.local.ps1
```

기본 원칙:

- `STRATEGY_SCHEDULER_RUN_ON_START=false` 유지
- 첫 scheduled tick은 설정 interval 이후 발생
- scheduler도 `/run`과 동일한 risk/execution/reconciliation gate를 통과해야 합니다.

### 7.7 종료/중단

긴 runtime은 PowerShell에서 `Ctrl+C`로 종료합니다.

운영 중 신규 주문만 막고 싶으면 Telegram에서:

```text
/pause
```

재개:

```text
/resume
```

즉시 신규 실행을 강하게 막고 싶으면:

```text
/killswitch
```

## 8. 상태 해석

### `/readiness` 상태

- `PASS`: 현재 evidence 기준으로 진행 가능
- `WARN`: 실행은 가능할 수 있으나 운영자 확인 필요
- `BLOCK`: 다음 단계로 진행하면 안 됨

### LIVE에서 흔히 보이는 WARN

- live send path가 켜져 있다는 경고
- scheduler disabled 경고
- historical recovery progress 경고
- non-blocking reconciliation issue 경고

### 즉시 멈춰야 하는 상태

- `overall_status: BLOCK`
- `system_status: DEGRADED`
- `active_order_count`가 예상과 다름
- `pending_notification_count`가 쌓임
- `recent_risk_block_count`가 증가
- `ORDER_LOOKUP_DEFERRED`, unresolved portfolio drift, recovery-required order가 남음

## 9. 파일 지도

### 루트 문서

- `PRODUCT_BOUNDARY.md`: 제품 범위와 금지 범위
- `ARCHITECTURE.md`: 모듈 구조와 runtime flow
- `RISK_POLICY.md`: live gate, guardrail, recovery, operator control
- `ORDER_LIFECYCLE.md`: 주문 상태와 reconciliation trigger
- `README.md`: 설치/실행/스크립트 사용법
- `PROJECT_GUIDE.md`: 현재 문서

### 주요 코드

- `src/app/*`: runtime bootstrap, env, scheduler, sync, startup recovery
- `src/domain/types.ts`: 공유 도메인 타입
- `src/modules/db/*`: repository와 SQLite persistence
- `src/modules/exchange/*`: Upbit public/private client
- `src/modules/execution/*`: order execution service와 idempotency
- `src/modules/reconciliation/*`: snapshot, drift, sync/recovery
- `src/modules/risk/*`: pure guard logic
- `src/modules/strategy/*`: PositionGuard strategy port
- `src/modules/telegram/*`: Telegram command, delivery, inbound
- `src/smoke/*`: smoke entry points
- `tests/*`: regression tests
- `scripts/*`: local operator scripts
- `migrations/*`: SQLite schema migrations

## 10. 지금 추천하는 다음 순서

현재 사용자가 장시간 안정성 테스트 없이 다음 개발 단계로 가겠다고 결정했으므로, 가장 합리적인 다음 개발은 `/preview BTC|ETH`입니다.

권장 순서:

1. `/preview BTC|ETH` 구현
2. tests와 docs 업데이트
3. `npm run check`
4. 현재 변경분 commit
5. LIVE manual runtime 재시작
6. `/sync`, `/readiness`, `/preview BTC|ETH`
7. preview 결과를 보고 `/run BTC|ETH` 여부 결정

자동 LIVE scheduler는 `/preview`와 첫 manual LIVE 주문 검증 이후로 미루는 것이 안전합니다.

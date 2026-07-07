# AutoTrade Upbit Strategy Review

작성일: 2026-07-07

## 목적

이 문서는 현재 `PositionGuard_PaperTrade` 매수/매도 판단 로직을 전문가 관점에서 점검하고, 강세장/횡보장/약세장에서 수익 가능성을 높이기 위한 개선 후보를 정리한다.

이 문서는 투자 수익을 보장하지 않는다. 목적은 live 전략을 임의로 더 공격적으로 만드는 것이 아니라, 검증 가능한 개선 후보를 분리하고 실제 주문 전 필요한 백테스트 기준을 정하는 것이다.

## 현재 전략 요약

현재 전략은 `src/modules/strategy`의 순수 판단 계층에서 만들어진다.

- `market-structure.ts`
  - Upbit 공개 시세와 `1h`, `4h`, `1d` 캔들을 사용한다.
  - 각 시간대별 EMA20/50/200, ATR14, RSI14, MACD histogram, volume ratio를 계산한다.
  - `BULL_TREND`, `PULLBACK_IN_UPTREND`, `EARLY_RECOVERY`, `RECLAIM_ATTEMPT`, `RANGE`, `WEAK_DOWNTREND`, `BREAKDOWN_RISK` 장세를 분류한다.
  - `pullbackZone`, `reclaimStructure`, `breakoutHoldStructure`, `failedReclaim`, `breakdown4h`, `breakdown1d`, `bearishMomentumExpansion`, `atrShock` 같은 구조 신호를 만든다.

- `position-guard-core.ts`
  - 보유 수량이 없으면 `ENTER` 또는 `HOLD`를 결정한다.
  - 보유 수량이 있으면 먼저 `EXIT`, 다음 `REDUCE`, 마지막으로 `ADD` 또는 `HOLD`를 결정한다.
  - `EXIT`는 invalidation broken, 1d breakdown, 4h breakdown + bearish momentum expansion에서 즉시 발생한다.
  - `ENTER`/`ADD`는 bullish score와 장세/진입 경로/회복 품질을 통과해야 한다.
  - borderline 진입은 한 시간 추가 확인을 요구한다.
  - `REDUCE`는 약세 점수와 weakening stage를 통과해야 하며, 최근 수정으로 `weakeningStage=NONE`에서는 독립 약세 증거 없이 borderline bearish momentum만으로 매도하지 않는다.

- `position-guard-runner.ts`
  - `/preview`는 같은 전략 판단을 계산하지만 DB 저장/주문 제출을 하지 않는다.
  - `/run`과 scheduler는 판단을 DB에 남기고, `ENTER/ADD/REDUCE/EXIT`가 주문 의도를 만들면 execution/risk 계층으로 넘긴다.

## 외부 근거에서 얻은 핵심

1. 짧은 주기의 crypto 전략은 거래비용을 넘는 신호만 거래해야 한다.
   - 2026년 BTC 시간봉 연구는 양의 gross 성과가 있어도 거래비용 10bp를 넣으면 단순 신호 기반 전략이 무너질 수 있고, 비용 기반 실행 필터가 turnover를 크게 줄이며 일부 설정에서 성과를 회복한다고 보고한다.
   - 시사점: 현재 전략도 `매매할 만한 신호인가`뿐 아니라 `수수료/스프레드/슬리피지를 이길 만큼 충분한 신호인가`를 별도 판단해야 한다.

2. crypto trend following은 근거가 있지만, 짧은 intraday 추세는 특히 조심해야 한다.
   - 2020년 crypto trend following 연구는 긴 구간의 trend following 가능성을 제시하지만, intraday trend following은 유의미한 성과가 약하다고 지적한다.
   - 2026년 AdaptiveTrend 연구는 6시간 단위 trend following, 동적 trailing stop, 장세별 성과 분해, 거래비용 모델링을 결합해 좋은 백테스트 결과를 보고한다.
   - 시사점: 현재의 `1h/4h/1d` 구조는 방향이 나쁘지 않지만, 1h 신호만으로 잦은 거래를 만들면 비용에 취약하다.

3. mean reversion은 횡보장에서 유혹적이지만 비용과 표본 편향에 약하다.
   - 평균회귀 전략 연구는 벤치마크 데이터에서는 좋아 보여도 최근 실제 데이터와 거래비용 조건에서는 실패할 수 있다고 보고한다.
   - 시사점: 횡보장이라고 단순 RSI/Bollinger 하단 매수를 추가하는 것은 위험하다. range 전략은 reward/risk와 비용을 명시해야 한다.

4. 백테스트 과최적화가 가장 큰 위험이다.
   - 금융 시계열은 regime shift, fat tail, serial dependence가 크다.
   - 임계값을 최근 손실 사례에 맞춰 조정하면 live 성과가 나빠질 가능성이 높다.
   - 시사점: 전략 개선은 `코드 수정 -> live 테스트`가 아니라 `가설 -> walk-forward 백테스트 -> 비용 반영 -> 작은 live rollout` 순서여야 한다.

5. Upbit 실행 제약은 전략 설계에 직접 들어가야 한다.
   - Upbit `orders/chance`는 적용 수수료율, 지원 주문 방향/유형, 최소/최대 주문 가능 금액을 제공한다.
   - Upbit 시장가 매수는 `ord_type=price`와 총액, 시장가 매도는 `ord_type=market`과 수량을 사용하며 체결 가격 변동 가능성이 있다.
   - 시사점: 전략 판단은 최소주문금액뿐 아니라 예상 비용, 시장가 매도 slippage, identifier/idempotency, 주문 유형별 제약을 고려해야 한다.

## 장세별 평가

### 강세장

강점:
- `BULL_TREND`와 `PULLBACK_IN_UPTREND`에 높은 bullish score를 부여한다.
- EMA stack, trend alignment, pullback/reclaim/breakout-hold 구조를 함께 본다.
- `strongTrendPerAssetMaxAllocation`으로 좋은 추세에서는 per-asset cap을 완화할 수 있다.
- upper range chase를 막아 과열 추격매수를 줄인다.

취약점:
- trend continuation과 over-extension의 구분이 다소 거칠다.
- strong trend에서 추가 매수는 가능하지만, 추세 추종형 trailing stop이나 profit lock 구조가 약하다.
- 현재 sizing은 `entryAllocation=0.30`, `addAllocation=0.18` 중심이며 변동성 기반 sizing이 아니다.
- 1h 신호가 4h/1d와 충돌할 때 기대수익 대비 비용이 충분한지 판단하지 않는다.

개선 여지:
- 강세장에서는 `breakout-hold`와 `pullback`을 분리해 백테스트해야 한다.
- ATR 기반 trailing stop 또는 profit lock을 도입 후보로 검토한다.
- 변동성 높은 강세장에서는 같은 30% 진입도 위험이 커질 수 있으므로 volatility targeting을 검토한다.

### 횡보장

강점:
- middle/upper range에서 무리한 진입을 잘 피한다.
- constructive pullback은 lower location 또는 volume recovery가 있어야 quality가 생긴다.
- 최근 수정으로 단일 borderline momentum 약화만으로 손실 포지션을 줄이지 않는다.

취약점:
- range trade의 명시적 target/reward-risk가 없다.
- 하단 매수 후 상단 근처에서 일부 이익실현하는 규칙이 약하다.
- 횡보장에서 너무 오래 HOLD해 기회비용이 생기는 경우를 평가하지 않는다.
- `RANGE`에서 `PULLBACK`과 `no trade`의 경계가 고정 rule 위주라, BTC/ETH 변동성 차이를 반영하지 않는다.

개선 여지:
- range 전용 playbook을 분리한다.
  - 진입: lower third + reversal quality + expected upside가 cost와 stop risk를 초과할 때만.
  - 청산/축소: upper third + profit buffer + momentum fade이면 부분 trim.
  - 보류: middle range에서는 원칙적으로 신규 진입 금지.

### 약세장

강점:
- invalidation broken, 1d breakdown, 4h breakdown + bearish momentum expansion은 즉시 `EXIT`한다.
- `BREAKDOWN_RISK`와 failed reclaim은 진입 후보에서 제외된다.
- `DEGRADED`, `PAUSED`, preflight, risk guard가 전략 외부에서 live 실행을 방어한다.

취약점:
- 큰 손실 이전의 점진적 위험 축소 기준이 아직 제한적이다.
- `WEAK_DOWNTREND`에서 반등 시도를 어떻게 다룰지 충분히 분리되어 있지 않다.
- 손절/축소 기준은 구조 기반이지만, 계좌 단위 drawdown 또는 trade-level maximum adverse excursion 기준이 없다.
- 하락장 반등을 `RECLAIM_ATTEMPT`로 오인할 때의 비용이 클 수 있다.

개선 여지:
- 약세장에서는 신규 `ENTER/ADD`를 더 엄격하게 제한한다.
- 4h/1d 회복 확인 전에는 reclaim 신호도 preview-only 또는 reduced sizing으로 둔다.
- position-level loss budget, trade-level max adverse excursion, time stop을 검토한다.

## 우선순위 개선 후보

### P0: 백테스트/리플레이 하네스 구축

코드 전략을 더 바꾸기 전에 가장 먼저 필요하다.

요구사항:
- Upbit 공개 캔들 또는 저장된 OHLCV로 `1h`, `4h`, `1d` snapshot을 시점별 재현한다.
- 미래 캔들을 절대 보지 않는 cutoff 로직을 유지한다.
- 현재 `analyzePositionGuardMarketStructure -> build context -> decidePositionGuardCore -> toStrategyDecision` 흐름을 그대로 실행한다.
- 수수료, spread/slippage, 최소주문금액, 시장가 매도 체결 가정, 주문 지연을 넣는다.
- 성과를 장세별로 분해한다.
- 비교 기준을 둔다: buy-and-hold, cash-only, simple long trend filter, current strategy.

합격 기준:
- 전체 CAGR/Sharpe보다 장세별 손익, maximum drawdown, turnover, fee drag, win/loss asymmetry, time in market을 우선 본다.
- BTC와 ETH를 분리해서 본다.
- 동일 파라미터가 여러 기간에서 버티는지 확인한다.

### P1: 비용 인식 action gate

현재 전략은 신호 점수는 있지만 `이 거래가 비용을 이길 만큼 좋은가`를 직접 계산하지 않는다.

개선 방향:
- `ENTER/ADD`: 예상 상승 여지 또는 target distance가 all-in cost와 stop risk를 충분히 초과할 때만 주문 의도 생성.
- `REDUCE`: risk-reducing 성격이므로 buy보다 낮은 비용 문턱을 적용하되, churn을 막기 위한 최소 수량/최소 notional 유지.
- `HOLD`: 신호가 애매하면 기존처럼 no-order.

검증 조건:
- turnover와 fee drag가 줄어야 한다.
- 손익이 특정 한두 구간에만 몰리면 보류한다.

### P1: volatility-aware sizing

현재 sizing은 기본 allocation 중심이다.

개선 방향:
- ATR% 또는 realized volatility가 높을수록 진입 금액을 줄인다.
- 강세장이라도 변동성이 극단적으로 높으면 add를 제한한다.
- 약세/불안정 regime에서는 max exposure cap을 더 낮춘다.

검증 조건:
- 최대 낙폭과 downside tail이 줄어야 한다.
- bull run 성과를 과도하게 희생하지 않아야 한다.

### P2: range playbook 분리

현재 range는 trend 전략 안에서 보수적으로 다뤄진다.

개선 방향:
- `RANGE_LOWER_RECLAIM`, `RANGE_MIDDLE_NO_TRADE`, `RANGE_UPPER_TRIM` 같은 의사결정 하위 상태를 만든다.
- range 하단 매수는 lower location + 회복 신호 + reward/risk 조건이 모두 맞아야 한다.
- range 상단에서는 신규 매수 금지, 보유분은 profit buffer가 있을 때만 일부 trim.

검증 조건:
- 횡보장에서 turnover가 늘어도 fee-adjusted PnL이 개선되어야 한다.
- 추세장 초입에서 너무 빨리 이익실현해 큰 추세를 놓치지 않아야 한다.

### P2: trailing stop / profit lock

현재 `EXIT`은 invalidation-first이고, `REDUCE`는 weakening 중심이다.

개선 방향:
- 이익 중인 포지션은 ATR 기반 trailing floor를 계산한다.
- 강세장에서는 trailing floor가 너무 촘촘하지 않게 한다.
- 횡보/약세 전환 시에는 profit lock을 빠르게 당긴다.

검증 조건:
- 대형 상승 추세에서 조기 청산이 늘지 않아야 한다.
- 급락 구간에서 손실 또는 이익 반납이 줄어야 한다.

### P3: ML/예측 모델

지금 당장 도입하지 않는다.

이유:
- 데이터 파이프라인, walk-forward, 비용 인식, overfitting 통제가 먼저다.
- 현재 프로젝트 경계는 deterministic rule-based execution stack이다.
- ML은 나중에 `signal research`로 분리하고, live order decision은 여전히 결정론적 wrapper 안에 둬야 한다.

## 하지 말아야 할 것

- 최근 한두 번의 live 결과에 맞춰 임계값을 조정하지 않는다.
- RSI/Bollinger 같은 단일 indicator를 추가해 바로 live 자동매매에 넣지 않는다.
- 수수료와 slippage를 빼고 백테스트하지 않는다.
- BTC에서 좋아 보이는 파라미터를 ETH에 그대로 적용하지 않는다.
- 매수/매도 판단을 LLM에게 실시간 위임하지 않는다.

## 추천 개발 순서

1. `P0` 백테스트/리플레이 하네스 구축
2. 현재 전략을 그대로 백테스트해 baseline 확보
3. 비용 인식 action gate 후보를 추가해 A/B 비교
4. volatility-aware sizing 후보를 추가해 A/B 비교
5. range playbook과 trailing stop 후보는 백테스트 결과를 보고 순차 적용
6. 통과한 후보만 DRY_RUN scheduler로 재검증
7. 마지막에 LIVE scheduler로 소액/기존 포지션 제한 테스트

## PM 관점 결론

현재 전략은 live 실행 안전장치와 운영 감사성은 강하다. 하지만 수익성 개선 관점에서는 아직 `전략 연구 체계`가 부족하다.

가장 큰 개선 여지는 매수/매도 조건을 즉흥적으로 더하는 것이 아니라, 다음 세 가지다.

1. 과거 여러 장세에서 현재 전략이 실제로 어디서 벌고 어디서 잃는지 측정한다.
2. 모든 action에 거래비용을 이기는 최소 기대효과 필터를 넣는다.
3. 고정 sizing을 변동성/장세/계좌 위험에 맞게 조절한다.

따라서 다음 개발 작업은 전략 로직 변경이 아니라 `백테스트/리플레이 하네스`가 가장 합리적이다.

## 참고 자료

- [Machine Learning-Based Bitcoin Trading Under Transaction Costs: Evidence From Walk-Forward Forecasting](https://arxiv.org/abs/2606.00060)
- [A Decade of Evidence of Trend Following Investing in Cryptocurrencies](https://arxiv.org/abs/2009.12155)
- [Systematic Trend-Following with Adaptive Portfolio Construction](https://arxiv.org/abs/2602.11708)
- [Empirical investigation of state-of-the-art mean reversion strategies for equity markets](https://arxiv.org/abs/1909.04327)
- [Determining Optimal Trading Rules without Backtesting](https://arxiv.org/abs/1408.1159)
- [Upbit 주문 가능 정보 조회 API](https://docs.upbit.com/kr/reference/available-order-information)
- [Upbit 주문 생성 API](https://docs.upbit.com/kr/reference/new-order)

# Performance Evidence Recovery and Stability Validation

## Scope

This change remains an offline, read-only research feature. It does not call Upbit,
poll Telegram, run reconciliation, execute strategy cycles, install scheduler timers,
or mutate the operational SQLite database.

## Persisted fee evidence

`fills.fee_amount` remains the primary fee source. A missing fill fee may be recovered
from the persisted `orders.exchange_response_json` only when all of these conditions
hold:

- the order has exactly one persisted selected fill;
- the response contains exactly one trade;
- market, side, trade UUID, price, and volume match the persisted fill;
- `paid_fee` is a finite non-negative KRW amount; and
- no contradictory per-trade fee is present.

Ambiguous multi-fill allocation, malformed JSON, partial trade evidence, or any
mismatch leaves the fee unknown and produces an explicit data-quality warning. The
reader never writes the recovered value back to SQLite.

## Attribution baseline

The report retains the requested half-open `[from,to)` fill filter and its period
opening snapshot. It also selects the latest persisted position snapshot strictly
before the first selected fill as an attribution baseline. This baseline is used only
to identify inventory that existed before the selected strategy stream began.

Inventory from the attribution baseline is classified as external/opening inventory,
not selected strategy PnL. Its aggregate average price can support an opening-inventory
gross estimate, but missing historical lot fees and holding time remain unknown. The
baseline snapshot timestamp must be strictly earlier than the first fill; equal-time
evidence is rejected as ambiguous.

## Anchored forward stability validation

`NO_ADD` robustness is evaluated over caller-supplied, non-overlapping validation
windows. Every scenario and cost cell is replayed once from the dataset initial state;
window metrics slice that continuous forward path rather than resetting cash,
positions, or decision state at every boundary.

For each `[from,to)` window the report records start/end equity, period return,
maximum drawdown, fills, turnover, fees, completed and carry-in episodes, suppressed
ADD exposure, candle coverage, and the paired `NO_ADD - BASELINE` return delta. Missing
candles are not interpolated. Windows without policy exposure are not evidence for or
against the policy.

The stability classification is descriptive, not a statistical significance claim.
It remains separate by asset and cost cell and never treats modeled cost cells as
independent observations.

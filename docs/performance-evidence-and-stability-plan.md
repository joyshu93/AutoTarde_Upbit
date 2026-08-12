# Performance Evidence and Stability Implementation Plan

1. Add failing reader tests for strict single-fill fee recovery, ambiguous evidence,
   and first-fill attribution baseline provenance.
2. Extend the read-only SQLite adapter and report provenance without changing schema
   or runtime wiring.
3. Add failing pure tests for explicit validation windows, continuous-path slicing,
   half-open boundaries, drawdown, exposure, coverage, and stability classification.
4. Implement the pure stability validator and integrate it as an optional section of
   `report:strategy-evaluation` through explicit `--validation-windows` input.
5. Update text/JSON output and root documentation while retaining backward-compatible
   behavior when no validation windows are supplied.
6. Run focused tests, typecheck, the full test suite, `git diff --check`, independent
   code review, and a read-only LIVE DB report. Do not commit or push.

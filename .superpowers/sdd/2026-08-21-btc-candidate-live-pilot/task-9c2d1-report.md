# Task 9C2d1 Report: Checked-In Abandonment Authority Loader

## Scope

This task adds only the narrow offline loader and validator for the checked-in
`PCS-2026-001` prospective-shadow registry. It does not wire the authority into
`createApp`, the scheduler, execution, recovery, or any LIVE path.

A valid `ABANDONED` registry event is historical governance evidence. It is not
LIVE approval, deployment approval, an order-send authority, or permission to
enable a scheduler.

## Implemented Contract

- Production reads only `docs/research/prospective-shadow/registry.jsonl` below
  `process.cwd()`; env, Git, GitHub, arbitrary runtime paths, and the network are
  not consulted.
- UTF-8 decoding is fatal. Exact LF and whole-file CRLF are accepted; CRLF is
  normalized to LF while mixed newlines and bare CR are rejected.
- Canonical LF bytes must match SHA-256
  `23dcdbd775d14176afb6ce0bd1be3c024e13cf97c98267a4dd3a2930c8e9cdf9`.
- JSONL must contain exactly the checked-in `REGISTERED -> ABANDONED` records.
  The parsed abandonment also passes the hardened exact-record validator.
- Returned validation evidence is detached and frozen.
- The repository root and every fixed path component reject symlinks and
  junctions. Realpath containment, regular-file status, descriptor/path file
  identity, and file stability are checked before and after descriptor reads.
  The descriptor is closed on success and failure.
- The test seam can replace only the repository root and opened-descriptor byte
  reader; returned fixture bytes still pass the production byte validator.
- The existing abandonment validator now requires a plain object with exact own
  string keys and enumerable data descriptors. It rejects accessors without
  invoking getters, symbols, non-enumerable keys, inherited keys, extra keys,
  arrays, null-prototype records, and custom-prototype records.

## TDD Evidence

RED:

- The focused authority/loader harness failed with `ERR_MODULE_NOT_FOUND` for
  `src/app/position-guard-pilot-registry-loader.ts` before implementation.

GREEN:

- Focused authority and loader tests: 15 passed.
- Covered exact LF/CRLF, invalid UTF-8, mixed/bare-CR newlines, missing registry,
  missing/extra/reversed/duplicated events, field and whitespace mutation,
  duplicate JSON keys, fixture-reader bypass, junction path, path swap, closed
  descriptor, exact object descriptors, and detached frozen output.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `git diff --check`: passed.

## Ownership And Safety

The read-only design review was supplied by subagent `01a0279a-2d9f-7df3-8207-81aa81468774`;
it changed no files. Main-agent implementation and integration stayed within the
Task 9C2d1 ownership list.

No operational database, Upbit API, Telegram API, runtime process, scheduler,
sync, strategy run, order path, migration, config/default, script, secret, Git
network operation, or LIVE activation was opened or invoked.

## Deferred Work

Candidate-only `createApp` validation before database construction, baseline
zero-read proof, preparation wiring, scheduler market hooks, and startup
candidate verification remain in later Task 9C2d/9C3 steps.

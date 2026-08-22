# Task 9C2d1 Report: Checked-In Abandonment Authority Loader

## Scope

This task adds only the narrow offline loader and validator for the checked-in
`PCS-2026-001` prospective-shadow registry. It does not wire the authority into
`createApp`, the scheduler, execution, recovery, or any LIVE path.

A valid `ABANDONED` registry event is historical governance evidence. It is not
LIVE approval, deployment approval, an order-send authority, or permission to
enable a scheduler.

## Implemented Contract

- Production derives the repository root from the fixed loader module URL via
  `import.meta.url` and `fileURLToPath`. Source `src/app` and compiled
  `dist/src/app` layouts project to the same repository root, so Task Scheduler
  `Start in` and `process.cwd()` cannot select authority. The explicit
  `repositoryRoot` test seam remains available; env, Git, GitHub, arbitrary
  runtime paths, and the network are not consulted.
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
  When both descriptor and path report unavailable `dev=0, ino=0` identity,
  stable regular-file type, size, mtime, ctime, birthtime, mode, link count,
  owner, group, and device metadata provide the fallback before canonical
  content validation. Partial identity availability, nonzero identity mismatch,
  and fallback metadata changes fail closed. The descriptor is closed on success
  and failure.
- The test seam can replace the repository root, opened-descriptor byte reader,
  and observed stats projection; returned fixture bytes still pass the
  production byte validator and all production path operations remain fixed.
- The existing abandonment validator now requires a plain object with exact own
  string keys and enumerable data descriptors. It rejects accessors without
  invoking getters, symbols, non-enumerable keys, inherited keys, extra keys,
  arrays, null-prototype records, and custom-prototype records.

## TDD Evidence

RED:

- The focused authority/loader harness failed with `ERR_MODULE_NOT_FOUND` for
  `src/app/position-guard-pilot-registry-loader.ts` before implementation.
- The P2 regression run failed three new tests before the fix: module-root
  projection was absent, the stats seam was not observed, and partial or
  mismatched identities were not rejected through that seam.

GREEN:

- Initial focused authority and loader tests: 15 passed.
- Final focused authority and loader tests: 19 passed (7 authority, 12 loader).
- Covered exact LF/CRLF, invalid UTF-8, mixed/bare-CR newlines, missing registry,
  missing/extra/reversed/duplicated events, field and whitespace mutation,
  duplicate JSON keys, fixture-reader bypass, junction path, path swap, closed
  descriptor, source/compiled module-root projection, unavailable identity
  fallback, partial and mismatched identity rejection, fallback metadata swap,
  exact object descriptors, and detached frozen output.
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

## Review Follow-Up

Initial independent reviewer Ohm (`01a027ac-6e8a-7ccb-b84b-3732a2f8039c`)
reported two P2 findings: production authority depended on `process.cwd()`, and
normal filesystems reporting unavailable `dev/ino` identity were rejected. Both
findings now have TDD regression coverage and implementation fixes in this task.
Closure remains pending a fresh independent re-review.

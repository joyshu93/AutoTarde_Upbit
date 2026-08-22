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
  and fallback metadata changes fail closed. After reading the originally opened
  descriptor, production independently reopens the current fixed path, repeats
  symlink, containment, identity, metadata, bounded-read, and stability checks,
  validates its canonical bytes, and compares its canonical SHA-256 with the
  original evidence. A same-size replacement with matched fallback metadata but
  different content therefore fails closed. Both descriptors are closed on
  success and failure.
- Production descriptor reads use a fixed `MAX_REGISTRY_BYTES + 1` buffer and
  positional `readSync` loop. Short reads continue until EOF, the 4,097th byte
  fails closed, and concurrent growth cannot cause an unbounded whole-file
  allocation. The same bounded reader handles the originally opened descriptor
  and the independently reopened current path. Fixture bytes still pass the
  independent validator, which retains the same 4 KiB limit.
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
- The second P2 regression test failed against `b264e44`: replacing the current
  path with different same-size content while projecting `dev=0, ino=0` and all
  compared metadata identically returned the original descriptor's authority
  instead of rejecting the replacement.
- The third P2 regression run failed against `02accda`: no directly testable
  bounded production descriptor reader existed, so initial-stat-followed-by-
  growth and short-read/EOF contracts both failed before implementation.

GREEN:

- Initial focused authority and loader tests: 15 passed.
- Final focused authority and loader tests: 22 passed (7 authority, 15 loader).
- Covered exact LF/CRLF, invalid UTF-8, mixed/bare-CR newlines, missing registry,
  missing/extra/reversed/duplicated events, field and whitespace mutation,
  duplicate JSON keys, fixture-reader bypass, junction path, path swap, closed
  descriptor, source/compiled module-root projection, unavailable identity
  fallback, partial and mismatched identity rejection, fallback metadata swap,
  identical-metadata different-content path replacement, exact object
  descriptors, bounded concurrent-growth rejection, safe short-read/EOF
  handling, and detached frozen output.
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
A second independent review found that the zero-identity fallback did not bind
the originally opened content to the post-read current path target. The current
path is now independently reopened and canonical-hash matched to the original
descriptor. This second P2 is addressed; closure remains pending a fresh scoped
re-review. A third independent review found that descriptor reads still used
whole-file `readFileSync` after only a pre-read size check. Both production
descriptor paths now share the fixed-budget reader. This third P2 is addressed;
closure remains pending a fresh scoped re-review.

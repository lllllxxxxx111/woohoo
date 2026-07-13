# Ark 34 Agent Long-Run Evaluation Completion

Completed on 2026-07-12 for evaluation `34期方舟Agent长程评测` using Hermes.

## Submission status

Both evaluation tasks are complete. Every model exceeded 300 tool calls and has three scored questions plus one product-feedback comment with a local validation-image attachment. The platform task pages show `已反馈` for all eight runs.

| Task | Model | Tool calls | Quality | Efficiency | Overall |
| --- | --- | ---: | ---: | ---: | ---: |
| K7SH2XS: endpoint routing, fallback, and audit | dynamo | 346 | 8 | 8 | 8 |
| K7SH2XS: endpoint routing, fallback, and audit | aegis | 449 | 8 | 7 | 8 |
| K7SH2XS: endpoint routing, fallback, and audit | basalt | 328 | 6 | 5 | 6 |
| K7SH2XS: endpoint routing, fallback, and audit | cipher | 330 | 6 | 6 | 6 |
| UIVTKK0: AI task and pipeline SSE recovery | dynamo | 323 | 9 | 6 | 8 |
| UIVTKK0: AI task and pipeline SSE recovery | aegis | 308 | 8 | 7 | 8 |
| UIVTKK0: AI task and pipeline SSE recovery | basalt | 306 | 9 | 7 | 8 |
| UIVTKK0: AI task and pipeline SSE recovery | cipher | 309 | 7 | 5 | 6 |

## Local validation evidence

Downloaded and extracted artifacts were checked locally where package size was proportionate. The following commands passed in the indicated artifacts:

- K7SH2XS/dynamo: `npm run typecheck`, `npm run test` (215 tests), `npm run build`.
- K7SH2XS/aegis: `npm run typecheck`, `npm run test` (214 tests), `npm run build`.
- UIVTKK0/dynamo: `npm run typecheck`, `npm run test` (337 tests), `npm run build`.
- UIVTKK0/aegis: `npm run typecheck`, `npm run test` (274 tests), `npm run build`.
- UIVTKK0/basalt: `npm run typecheck`, `npm run test` (340 tests), `npm run build`.
- UIVTKK0/cipher: pre-final downloaded artifact passed `npm run typecheck`, `npm run test` (274 tests), and `npm run build`.

The two K7SH2XS basalt/cipher quick artifacts were approximately 1.02 GB and 829 MB. They were reviewed through platform traces and package metadata rather than full local extraction; this package-hygiene limitation is reflected in their lower scores. `cargo check` in extracted Windows artifact directories was blocked by `os error 5` while executing a `libsqlite3-sys` build script, treated as an environment limitation rather than a source failure.

Validation reports and uploaded screenshots are under `eval-results/crowdtest34_*_light_validation.txt` and `eval-results/crowdtest34_*_validation.png`.

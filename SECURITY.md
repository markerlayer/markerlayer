# Security Policy

## Reporting a vulnerability

Please report security issues privately to **security@markerlayer.com**
(or hello@markerlayer.com). Do not open a public issue for vulnerabilities.

We aim to acknowledge reports within 72 hours. Because MarkerLayer processes
behavioural data for regulated operators, we treat reports affecting data
isolation, authentication, or the integrity of marker computations with the
highest priority.

## Scope notes

- The engine ingests **no PII by design** — pseudonymous player IDs,
  monetary amounts in minor units, and categorical fields only.
- The reference API server authenticates with bearer keys compared in
  constant time; keys must be ≥16 characters.
- Scoring is deterministic: identical event logs produce identical outputs,
  which makes any suspected integrity issue independently verifiable.

## Supported versions

Security fixes are applied to the latest minor release line.

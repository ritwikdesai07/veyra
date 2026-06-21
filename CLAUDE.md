# CLAUDE.md

## Loop stop rules

- Stop when all checks pass.
- Stop after 5 cycles.
- Stop if the same failure appears twice in a row.
- Stop if a fix breaks a previously passing check.
- Never report success without final checker proof.
- Never weaken, delete, skip, or bypass tests/checks.

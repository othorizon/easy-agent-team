# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This is a single-context repo: one glossary at the root, one ADR directory.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.
- **`docs/product-design.md` §10**: decisions 1–92, recorded before ADRs existed. Read the ones that touch your area. This document is no longer maintained: never append to it or update it. `CLAUDE.md` refers to these as「决策 N」.
- **`docs/<feature>.md`** (e.g. `docs/oss-storage.md`): the current behavior of each feature.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── GLOSSARY.md
├── docs/
│   ├── adr/
│   │   ├── 0001-<slug>.md
│   │   └── 0002-<slug>.md
│   └── product-design.md        ← history only (decisions 1–92)
└── apps/ packages/
```

ADRs are numbered sequentially from `0001` and written in Chinese, like the rest of the docs. The ADR numbers are a separate sequence from the historical「决策 N」.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR or a historical decision in `docs/product-design.md` §10, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

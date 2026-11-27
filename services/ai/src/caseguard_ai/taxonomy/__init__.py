"""Case taxonomy v1 (#164) and the statute→area classifier (#200).

- ``rules``: loads ``packages/contracts/taxonomy/case-taxonomy.v1.yaml`` into typed rules and
  compares PPC section numbers ("338-H").
- ``classify``: the deterministic classifier (docs/engineering/case-taxonomy.md §5) and
  ``python -m caseguard_ai.taxonomy.classify`` (``pnpm ai:classify-areas``).
- ``review``: the stratified hand-labelling sample and its scoring (doc §6).
"""

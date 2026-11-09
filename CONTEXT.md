# CaseGuard AI

A verifiable legal research and drafting workspace for Pakistani civil and criminal law. This glossary pins down the words the team uses for its data.

## Language

### Public corpus

**Corpus**:
The public legal material CaseGuard answers from: statutes and court judgments collected from official sources.
_Avoid_: dataset, database (when meaning the content)

**Partition**:
A slice of the crawl, such as one source or one area of law within a source, that one team member owns and collects at a time.
_Avoid_: shard, chunk, batch

**Partition owner**:
The team member who crawls a partition and is the only one who publishes snapshots of it.

**Corpus snapshot**:
A dated, immutable copy of one partition's collected output (original files, extracted records and crawl state), with a manifest.
_Avoid_: backup, export, latest

**Manifest**:
The description that travels with a snapshot or dump: what it contains, how much, and what produced it.

**Integrator**:
The team member who combines the latest snapshot of every partition into one corpus dump.

**Corpus dump**:
A dated copy of the loaded, embedded corpus database that a team member restores locally instead of rebuilding it.
_Avoid_: snapshot (that is the per-partition collector output)

### Private data

**User upload**:
A file a user adds to one of their own cases. It belongs to that user and case only, and is never part of the corpus.
_Avoid_: document (ambiguous with corpus documents)

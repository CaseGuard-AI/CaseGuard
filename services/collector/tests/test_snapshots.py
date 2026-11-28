"""Corpus snapshots (#152): pack, gate, publish, pull, status. Offline, with a fake HfApi."""

from __future__ import annotations

import gzip
import json
import tarfile
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from huggingface_hub.errors import EntryNotFoundError

from snapshots import FILES_TAR, MANIFEST_FILE, RECORDS_FILE, STATE_FILE, SnapshotRefused
from snapshots.gate import check_publishable, problems
from snapshots.hub import SnapshotHub
from snapshots.manifest import Manifest, verify_snapshot
from snapshots.pack import pack, relative_file_path, unpack
from snapshots.pull import pull
from snapshots.status import WARN_BYTES, report, usage_lines
from storage.state_store import StateStore

CLEAN = {"publisher": "tester", "git": {"commit": "abc123", "dirty": False}}


def _record(n: int, partition_dir: Path, **extra: Any) -> dict[str, Any]:
    return {
        "id": f"pakistan_code-{n:04d}",
        "source": "pakistan_code",
        "source_url": f"https://pakistancode.gov.pk/{n}",
        "document_type": "act",
        "extraction_status": "ok",
        "full_text": f"The text of act {n}.",
        "file_path": str(partition_dir / "raw" / "pakistan_code" / "2020" / f"act_{n}.pdf"),
        **extra,
    }


def make_partition(
    root: Path, name: str = "pk-code-seed", records: list[dict] | None = None
) -> Path:
    """A tiny partition as the collector lays it out."""
    pdir = root / "partitions" / name
    docs = pdir / "documents"
    docs.mkdir(parents=True)
    rows = records if records is not None else [_record(n, pdir) for n in range(3)]
    lines = [json.dumps(r) for r in rows]
    (docs / "pakistan_code.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    if lines:  # a dated per-run copy, which a snapshot leaves out
        dated = docs / "pakistan_code_2026-11-10_ab12cd.jsonl"
        dated.write_text(lines[0] + "\n", encoding="utf-8")
    for n in range(len(rows)):
        raw = pdir / "raw" / "pakistan_code" / "2020" / f"act_{n}.pdf"
        raw.parent.mkdir(parents=True, exist_ok=True)
        raw.write_bytes(b"%PDF-1.4 act " + bytes([n]))
        text = pdir / "text" / "pakistan_code" / "2020" / f"act_{n}.txt"
        text.parent.mkdir(parents=True, exist_ok=True)
        text.write_text(f"act {n}", encoding="utf-8")
    (pdir / "logs").mkdir()
    (pdir / "logs" / "run.log").write_text("log", encoding="utf-8")
    store = StateStore(pdir / "state" / "state.db")
    store.start_run(
        "run1",
        "pakistan_code",
        partition=name,
        selection_file="selections/pk-code-seed.txt",
        selection_sha256="f" * 64,
    )
    store.finish_run("run1", "ok")
    store.close()
    return pdir


def packed(tmp_path: Path, pdir: Path | None = None, *, folder: str = "2026-11-28", prov=CLEAN):
    pdir = pdir or make_partition(tmp_path)
    out = tmp_path / "out" / folder
    result = pack(pdir, out, partition=pdir.name, folder=folder, prov=prov)
    return pdir, out, result


# ── manifest + pack ───────────────────────────────────────────────────────────────────────────


def test_manifest_records_identity_provenance_counts_and_checksums(tmp_path: Path) -> None:
    pdir, out, result = packed(tmp_path)
    m = Manifest.read(out / MANIFEST_FILE)
    assert m.snapshot == "pk-code-seed@2026-11-28"
    assert m.data["git"] == CLEAN["git"]
    assert m.data["collector_settings"]["source"] == "pakistan_code"
    assert m.data["run_ids"] == ["run1"]
    assert m.data["selection"]["file"] == "selections/pk-code-seed.txt"
    c = m.counts
    assert c["records"] == 3 and c["files"] == 6
    assert c["by_source"] == {"pakistan_code": 3}
    assert c["by_document_type"] == {"act": 3}
    assert c["by_extraction_status"] == {"ok": 3}
    assert c["headnote_only"] == 0 and c["third_party"] == 0
    assert set(m.files) == {RECORDS_FILE, STATE_FILE, FILES_TAR}
    assert all(len(f["sha256"]) == 64 and f["bytes"] > 0 for f in m.files.values())
    assert result.duplicates == 0
    verify_snapshot(out)


def test_pack_leaves_out_logs_and_dated_copies_and_relativises_paths(tmp_path: Path) -> None:
    _, out, _ = packed(tmp_path)
    with tarfile.open(out / FILES_TAR) as tar:
        names = tar.getnames()
    assert all(n.startswith(("raw/", "text/")) and "\\" not in n for n in names)
    with gzip.open(out / RECORDS_FILE, "rt", encoding="utf-8") as fh:
        rows = [json.loads(line) for line in fh]
    assert len(rows) == 3  # the dated copy didn't double the first record
    assert rows[0]["file_path"] == "raw/pakistan_code/2020/act_0.pdf"


def test_a_recrawled_record_keeps_only_its_newest_line(tmp_path: Path) -> None:
    root = tmp_path / "d"
    pdir_probe = root / "partitions" / "pk-code-seed"
    rows = [_record(0, pdir_probe), _record(1, pdir_probe), _record(0, pdir_probe, title="new")]
    pdir = make_partition(root, records=rows)
    _, out, result = packed(tmp_path, pdir)
    assert result.duplicates == 1
    assert Manifest.read(out / MANIFEST_FILE).counts["records"] == 2


def test_relative_file_path_from_another_machine() -> None:
    value = r"D:\crawl\data\partitions\pk-code-seed\raw\pakistan_code\2020\x.pdf"
    assert relative_file_path(value, Path("/elsewhere/pk-code-seed")) == (
        "raw/pakistan_code/2020/x.pdf"
    )
    assert relative_file_path(None, Path(".")) is None


def test_pack_refuses_a_partition_without_records_or_state(tmp_path: Path) -> None:
    with pytest.raises(SnapshotRefused, match="doesn't exist"):
        pack(tmp_path / "nope", tmp_path / "o", partition="x", folder="2026-11-28", prov=CLEAN)
    empty = tmp_path / "partitions" / "x"
    (empty / "state").mkdir(parents=True)
    with pytest.raises(SnapshotRefused, match="state.db is missing"):
        pack(empty, tmp_path / "o", partition="x", folder="2026-11-28", prov=CLEAN)


# ── gate: every refusal ───────────────────────────────────────────────────────────────────────


def test_a_clean_snapshot_passes_the_gate(tmp_path: Path) -> None:
    pdir, out, _ = packed(tmp_path)
    assert problems(pdir, out) == []
    check_publishable(pdir, out)


def test_gate_refuses_a_checksum_mismatch(tmp_path: Path) -> None:
    pdir, out, _ = packed(tmp_path)
    (out / STATE_FILE).write_bytes(b"tampered")
    with pytest.raises(SnapshotRefused, match="checksum"):
        check_publishable(pdir, out)


def test_gate_refuses_a_count_mismatch(tmp_path: Path) -> None:
    pdir, out, _ = packed(tmp_path)
    m = Manifest.read(out / MANIFEST_FILE)
    m.data["counts"]["records"] = 99
    m.write(out / MANIFEST_FILE)
    assert any("count" in p for p in problems(pdir, out))


@pytest.mark.parametrize(
    ("git", "needle"),
    [
        ({"commit": "abc", "dirty": True}, "uncommitted changes"),
        ({"commit": "abc", "dirty": None}, "uncommitted changes"),
        ({"commit": None, "dirty": None}, "no git commit"),
    ],
)
def test_gate_refuses_a_dirty_or_unknown_tree(tmp_path: Path, git: dict, needle: str) -> None:
    pdir, out, _ = packed(tmp_path, prov={"publisher": None, "git": git})
    assert any(needle in p for p in problems(pdir, out))


@pytest.mark.parametrize("name", [".env", "hf_token", "id_rsa", "server.key", "token.txt"])
def test_gate_refuses_secret_files(tmp_path: Path, name: str) -> None:
    pdir = make_partition(tmp_path)
    (pdir / "raw" / name).write_text("x", encoding="utf-8")
    _, out, _ = packed(tmp_path, pdir)
    assert any("secret-looking" in p and name in p for p in problems(pdir, out))


def test_gate_refuses_upload_looking_files(tmp_path: Path) -> None:
    pdir = make_partition(tmp_path)
    (pdir / "raw" / "pakistan_code" / "2020" / "scan.png").write_bytes(b"png")
    (pdir / "raw" / "my-case.pdf").write_bytes(b"pdf")  # not under a source folder
    _, out, _ = packed(tmp_path, pdir)
    found = " ".join(problems(pdir, out))
    assert "scan.png" in found and "my-case.pdf" in found


def test_gate_refuses_an_uploads_folder(tmp_path: Path) -> None:
    pdir = make_partition(tmp_path)
    (pdir / "raw" / "pakistan_code" / "uploads").mkdir()
    (pdir / "raw" / "pakistan_code" / "uploads" / "a.pdf").write_bytes(b"x")
    _, out, _ = packed(tmp_path, pdir)
    assert any("uploads" in p for p in problems(pdir, out))


def test_gate_refuses_a_token_inside_the_records(tmp_path: Path) -> None:
    root = tmp_path / "d"
    probe = root / "partitions" / "pk-code-seed"
    token = "hf_" + "A1b2C3d4" * 5
    pdir = make_partition(root, records=[_record(0, probe), _record(1, probe, summary=token)])
    _, out, _ = packed(tmp_path, pdir)
    found = problems(pdir, out)
    assert any("token" in p and "lines 2" in p for p in found)
    assert token not in " ".join(found)  # never echoed


def test_gate_refuses_hf_records_in_a_normal_partition(tmp_path: Path) -> None:
    root = tmp_path / "d"
    probe = root / "partitions" / "pk-code-seed"
    pdir = make_partition(root, records=[_record(0, probe), _record(1, probe, source="hf_x")])
    _, out, _ = packed(tmp_path, pdir)
    assert any("third-party" in p for p in problems(pdir, out))


def test_gate_refuses_normal_records_in_a_bootstrap_partition(tmp_path: Path) -> None:
    pdir = make_partition(tmp_path, name="bootstrap-hf")
    _, out, _ = packed(tmp_path, pdir)
    assert any("bootstrap partition" in p for p in problems(pdir, out))


def test_gate_refuses_an_empty_partition(tmp_path: Path) -> None:
    pdir = make_partition(tmp_path, records=[])
    with pytest.raises(SnapshotRefused, match="no records"):
        packed(tmp_path, pdir)


# ── pack -> unpack ────────────────────────────────────────────────────────────────────────────


def test_round_trip_restores_the_partition_layout(tmp_path: Path) -> None:
    pdir, out, _ = packed(tmp_path)
    target = tmp_path / "elsewhere" / "pk-code-seed"
    pulled = pull("pk-code-seed", target, source_dir=out, with_files=True)
    assert pulled.with_files
    got = [
        json.loads(x)
        for x in (target / "documents" / "pakistan_code.jsonl").read_text("utf-8").splitlines()
    ]
    assert [r["id"] for r in got] == [f"pakistan_code-{n:04d}" for n in range(3)]
    assert (target / "raw/pakistan_code/2020/act_1.pdf").read_bytes() == (
        pdir / "raw/pakistan_code/2020/act_1.pdf"
    ).read_bytes()
    assert StateStore(target / "state" / "state.db").runs()[0]["run_id"] == "run1"
    assert json.loads((target / "snapshot.json").read_text("utf-8"))["folder"] == "2026-11-28"
    # and the unpacked partition packs to the same records
    again = pack(target, tmp_path / "again", partition="pk-code-seed", folder="x", prov=CLEAN)
    assert (
        again.manifest.files[RECORDS_FILE] == Manifest.read(out / MANIFEST_FILE).files[RECORDS_FILE]
    )


def test_pull_skips_files_tar_by_default(tmp_path: Path) -> None:
    _, out, _ = packed(tmp_path)
    (out / FILES_TAR).unlink()  # as if never downloaded: not even checked
    target = tmp_path / "t"
    pulled = pull("pk-code-seed", target, source_dir=out)
    assert not pulled.with_files and not (target / "raw").exists()


def test_pull_refuses_a_bad_checksum(tmp_path: Path) -> None:
    _, out, _ = packed(tmp_path)
    (out / RECORDS_FILE).write_bytes(gzip.compress(b"{}\n"))
    with pytest.raises(SnapshotRefused, match="checksum"):
        pull("pk-code-seed", tmp_path / "t", source_dir=out)


def test_pull_refuses_to_clobber_without_yes(tmp_path: Path) -> None:
    pdir, out, _ = packed(tmp_path)
    with pytest.raises(SnapshotRefused, match="--yes"):
        pull("pk-code-seed", pdir, source_dir=out)
    pull("pk-code-seed", pdir, source_dir=out, yes=True)
    assert not (pdir / "documents" / "pakistan_code_2026-11-10_ab12cd.jsonl").exists()


def test_pull_refuses_another_partitions_snapshot(tmp_path: Path) -> None:
    _, out, _ = packed(tmp_path)
    with pytest.raises(SnapshotRefused, match="not shc-meta"):
        pull("shc-meta", tmp_path / "t", source_dir=out)


def test_unpack_refuses_a_tar_with_unexpected_entries(tmp_path: Path) -> None:
    _, out, _ = packed(tmp_path)
    evil = tmp_path / "evil.txt"
    evil.write_text("x", encoding="utf-8")
    with tarfile.open(out / FILES_TAR, "a") as tar:
        tar.add(evil, arcname="state/state.db")
    with pytest.raises(SnapshotRefused, match="unexpected entry"):
        unpack(out, tmp_path / "t", with_files=True)


# ── the hub, with a fake HfApi ────────────────────────────────────────────────────────────────


@dataclass
class FakeHf:
    """An in-memory dataset repo: files per commit, tags pointing at commits."""

    commits: list[dict[str, bytes]] = field(default_factory=lambda: [{}])
    tags: dict[str, int] = field(default_factory=dict)
    root: Path = Path(".")

    def _at(self, revision: str | None) -> dict[str, bytes]:
        if revision in (None, "main"):
            return self.commits[-1]
        return self.commits[self.tags[revision]]

    def list_repo_refs(self, repo_id: str, **_: Any) -> Any:
        return SimpleNamespace(
            tags=[SimpleNamespace(name=t) for t in self.tags],
            branches=[SimpleNamespace(name="main", target_commit=str(len(self.commits) - 1))],
        )

    def file_exists(self, repo_id: str, filename: str, **_: Any) -> bool:
        return filename in self.commits[-1]

    def create_commit(self, repo_id: str, *, operations: Any, parent_commit: Any, **_: Any) -> Any:
        assert parent_commit == str(len(self.commits) - 1)
        files = dict(self.commits[-1])
        for op in operations:
            assert op.path_in_repo not in files, "overwrote a published file"
            src = op.path_or_fileobj
            files[op.path_in_repo] = src if isinstance(src, bytes) else Path(src).read_bytes()
        self.commits.append(files)
        return SimpleNamespace(oid=len(self.commits) - 1)

    def create_tag(self, repo_id: str, *, tag: str, revision: int, **_: Any) -> None:
        assert tag not in self.tags
        self.tags[tag] = revision

    def list_repo_tree(
        self, repo_id: str, path_in_repo: str | None = None, *, recursive: bool = False, **_: Any
    ) -> Any:
        files = self.commits[-1]
        prefix = f"{path_in_repo}/" if path_in_repo else ""
        under = [p for p in files if p.startswith(prefix)]
        if path_in_repo and not under:
            raise EntryNotFoundError(path_in_repo)
        if recursive:
            return [SimpleNamespace(path=p, size=len(files[p])) for p in under]
        children = {prefix + p[len(prefix) :].split("/")[0] for p in under}
        return [
            SimpleNamespace(path=c, size=len(files[c]) if c in files else None) for c in children
        ]

    def hf_hub_download(
        self, repo_id: str, filename: str, *, revision: str = "main", **_: Any
    ) -> str:
        out = self.root / revision.replace("/", "_") / filename
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(self._at(revision)[filename])
        return str(out)


def _hub(tmp_path: Path) -> tuple[FakeHf, SnapshotHub]:
    fake = FakeHf(root=tmp_path / "cache")
    return fake, SnapshotHub(fake, "caseguard/corpus")


def _publish(tmp_path: Path, hub: SnapshotHub, pdir: Path, day: str, tag: str) -> str:
    folder = hub.next_folder("pk-code-seed", day)
    out = tmp_path / "out" / tag
    pack(pdir, out, partition="pk-code-seed", folder=folder, prov=CLEAN)
    return hub.publish(out)


def test_next_folder_adds_n_and_publish_never_overwrites(tmp_path: Path) -> None:
    fake, hub = _hub(tmp_path)
    pdir = make_partition(tmp_path / "d")
    names = [_publish(tmp_path, hub, pdir, "2026-11-28", str(i)) for i in range(3)]
    assert names == ["2026-11-28", "2026-11-28-2", "2026-11-28-3"]
    assert set(fake.tags) == {f"snap/pk-code-seed/{n}" for n in names}
    files = fake.commits[-1]
    assert "snapshots/pk-code-seed/2026-11-28-2/files.tar" in files
    assert "snapshots/pk-code-seed/2026-11-28/manifest.json" in files
    assert hub.folders("pk-code-seed") == names
    assert hub.folders("shc-meta") == []


def test_a_folder_uploaded_by_hand_is_never_added_to_or_pulled(tmp_path: Path) -> None:
    fake, hub = _hub(tmp_path)
    fake.commits.append({"snapshots/pk-code-seed/2026-11-10/pk-code-seed.tar": b"old tar"})
    assert hub.folders("pk-code-seed") == []
    assert hub.next_folder("pk-code-seed", "2026-11-10") == "2026-11-10-2"
    text = report(hub.repo_id, hub.inventory())
    assert "uploaded by hand" in text and "latest none" in text


def test_publish_refuses_a_folder_taken_meanwhile(tmp_path: Path) -> None:
    fake, hub = _hub(tmp_path)
    pdir = make_partition(tmp_path / "d")
    out = tmp_path / "late"
    pack(pdir, out, partition="pk-code-seed", folder="2026-11-28", prov=CLEAN)
    _publish(tmp_path, hub, pdir, "2026-11-28", "first")
    with pytest.raises(SnapshotRefused, match="meanwhile"):
        hub.publish(out)
    assert len(fake.commits) == 2


def test_publish_refuses_a_tampered_snapshot(tmp_path: Path) -> None:
    fake, hub = _hub(tmp_path)
    _, out, _ = packed(tmp_path)
    (out / FILES_TAR).write_bytes(b"x")
    with pytest.raises(SnapshotRefused, match="checksum"):
        hub.publish(out)
    assert fake.commits == [{}]


def test_resolve_and_pull_from_the_hub(tmp_path: Path) -> None:
    _, hub = _hub(tmp_path)
    pdir = make_partition(tmp_path / "d")
    for i, day in enumerate(["2026-11-10", "2026-11-10", "2026-11-12"]):
        _publish(tmp_path, hub, pdir, day, str(i))
    assert hub.resolve("pk-code-seed", None) == "2026-11-12"
    assert hub.resolve("pk-code-seed", "2026-11-10") == "2026-11-10"
    assert hub.resolve("pk-code-seed", "2026-11-10-2") == "2026-11-10-2"
    with pytest.raises(SnapshotRefused, match="no snapshot"):
        hub.resolve("pk-code-seed", "2026-11-11")
    with pytest.raises(SnapshotRefused, match="no snapshots of shc-meta"):
        hub.resolve("shc-meta", None)

    target = tmp_path / "t"
    pulled = pull("pk-code-seed", target, hub=hub, date="2026-11-10-2")
    assert pulled.manifest.folder == "2026-11-10-2" and not pulled.with_files
    assert not (
        tmp_path
        / "cache"
        / "snap_pk-code-seed_2026-11-10-2"
        / "snapshots"
        / "pk-code-seed"
        / "2026-11-10-2"
        / FILES_TAR
    ).exists()  # files.tar never downloaded
    assert (target / "documents" / "pakistan_code.jsonl").is_file()


# ── status ────────────────────────────────────────────────────────────────────────────────────


def test_status_lists_snapshots_dumps_and_usage(tmp_path: Path) -> None:
    fake, hub = _hub(tmp_path)
    pdir = make_partition(tmp_path / "d")
    _publish(tmp_path, hub, pdir, "2026-11-28", "a")
    files = dict(fake.commits[-1])
    files["dumps/2026-11-20/corpus.dump"] = b"d" * 10
    files["dumps/LATEST"] = b"2026-11-20\n"
    fake.commits.append(files)
    inv = hub.inventory()
    assert set(inv.snapshots["pk-code-seed"]) == {"2026-11-28"}
    assert inv.dumps == {"2026-11-20": 10} and inv.latest_dump == "2026-11-20"
    assert inv.total_bytes == sum(len(v) for v in files.values())
    text = report(hub.repo_id, inv, tmp_path / "d" / "partitions")
    assert "pk-code-seed" in text and "LATEST = 2026-11-20" in text and "WARNING" not in text
    assert "crawled here" in text


def test_status_warns_from_75_gb() -> None:
    assert not any("WARNING" in line for line in usage_lines(WARN_BYTES - 1))
    warned = usage_lines(WARN_BYTES)
    assert any("caseguard/corpus-v2" in line for line in warned)


# ── review fixes (#255) ───────────────────────────────────────────────────────────────────────


def _files_of(pdir: Path) -> dict[str, bytes]:
    """Every file of a partition, for "left exactly as it was" checks."""
    return {p.relative_to(pdir).as_posix(): p.read_bytes() for p in pdir.rglob("*") if p.is_file()}


def test_a_refused_unpack_leaves_the_partition_as_it_was(tmp_path: Path) -> None:
    _, out, _ = packed(tmp_path)
    target = make_partition(tmp_path / "local")
    before = _files_of(target)
    evil = tmp_path / "evil.txt"
    evil.write_text("x", encoding="utf-8")
    with tarfile.open(out / FILES_TAR, "a") as tar:
        tar.add(evil, arcname="logs/evil.txt")
    with pytest.raises(SnapshotRefused, match="unexpected entry"):
        unpack(out, target, with_files=True)
    assert _files_of(target) == before
    assert [p.name for p in target.parent.iterdir()] == [target.name]  # no temp folders left


def test_a_bad_source_name_leaves_the_partition_as_it_was(tmp_path: Path) -> None:
    root = tmp_path / "d"
    probe = root / "partitions" / "pk-code-seed"
    pdir = make_partition(root, records=[_record(0, probe), _record(1, probe, source="../x")])
    out = tmp_path / "out"
    pack(pdir, out, partition="pk-code-seed", folder="2026-11-28", prov=CLEAN)
    target = make_partition(tmp_path / "local")
    before = _files_of(target)
    with pytest.raises(SnapshotRefused, match="bad source name"):
        unpack(out, target, with_files=False)
    assert _files_of(target) == before


def test_unpack_drops_the_old_wal_files(tmp_path: Path) -> None:
    _, out, _ = packed(tmp_path)
    target = make_partition(tmp_path / "local")
    (target / "state" / "state.db-wal").write_bytes(b"old wal")
    (target / "state" / "state.db-shm").write_bytes(b"old shm")
    (target / "logs" / "keep.log").write_text("kept", encoding="utf-8")
    unpack(out, target, with_files=False)
    assert sorted(p.name for p in (target / "state").iterdir()) == ["state.db"]
    store = StateStore(target / "state" / "state.db")
    assert store.runs()[0]["run_id"] == "run1"
    store.close()
    assert (target / "logs" / "keep.log").is_file()  # logs are never touched


def test_an_absolute_file_path_left_over_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "d"
    probe = root / "partitions" / "pk-code-seed"
    outside = _record(1, probe, file_path=r"C:\Users\Some One\Downloads\act.pdf")
    pdir = make_partition(root, records=[_record(0, probe), outside])
    _, out, _ = packed(tmp_path, pdir)
    found = " ".join(problems(pdir, out))
    assert "absolute local path" in found and "lines 2" in found


def test_a_failed_tag_is_never_latest_and_the_next_publish_repairs_it(tmp_path: Path) -> None:
    fake, hub = _hub(tmp_path)
    pdir = make_partition(tmp_path / "d")
    real_tag = fake.create_tag

    def broken(*a: Any, **k: Any) -> None:
        raise RuntimeError("tag failed")

    fake.create_tag = broken  # type: ignore[method-assign]
    with pytest.raises(RuntimeError):
        _publish(tmp_path, hub, pdir, "2026-11-28", "a")
    assert hub.folders("pk-code-seed") == []  # committed, but not pullable
    assert hub.untagged("pk-code-seed") == ["2026-11-28"]
    assert "no tag" in report(hub.repo_id, hub.inventory())
    with pytest.raises(SnapshotRefused, match="no snapshots"):
        hub.resolve("pk-code-seed", None)

    fake.create_tag = real_tag  # type: ignore[method-assign]
    assert _publish(tmp_path, hub, pdir, "2026-11-28", "b") == "2026-11-28-2"
    assert hub.folders("pk-code-seed") == ["2026-11-28", "2026-11-28-2"]
    assert hub.untagged("pk-code-seed") == []


def test_a_refused_pull_downloads_nothing(tmp_path: Path) -> None:
    fake, hub = _hub(tmp_path)
    pdir = make_partition(tmp_path / "d")
    _publish(tmp_path, hub, pdir, "2026-11-28", "a")
    calls: list[str] = []
    real = fake.hf_hub_download

    def counted(*a: Any, **k: Any) -> str:
        calls.append(a[1])
        return real(*a, **k)

    fake.hf_hub_download = counted  # type: ignore[method-assign]
    with pytest.raises(SnapshotRefused, match="--yes"):
        pull("pk-code-seed", pdir, hub=hub)
    assert calls == []


# the CLI


@pytest.fixture
def cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    import snapshots.__main__ as cli_module

    monkeypatch.setattr(cli_module, "STAGING", tmp_path / "staging")
    return cli_module


def test_a_second_push_the_same_day_replaces_the_leftover_staging(tmp_path: Path, cli: Any) -> None:
    pdir = make_partition(tmp_path / "d")
    argv = ["push", "--snapshot", "pk-code-seed", "--dir", str(pdir), "--no-upload"]
    argv += ["--date", "2026-11-28"]
    assert cli.main(argv) == 0
    assert (tmp_path / "staging" / "pk-code-seed" / "2026-11-28" / MANIFEST_FILE).is_file()
    assert cli.main(argv) == 0  # used to fail: "... is not empty"


def test_an_explicit_out_that_is_not_empty_is_still_refused(tmp_path: Path, cli: Any) -> None:
    pdir = make_partition(tmp_path / "d")
    out = tmp_path / "mine"
    out.mkdir()
    (out / "keep.txt").write_text("x", encoding="utf-8")
    argv = ["push", "--snapshot", "pk-code-seed", "--dir", str(pdir), "--no-upload"]
    assert cli.main([*argv, "--out", str(out)]) == 2
    assert (out / "keep.txt").is_file()


@pytest.mark.parametrize("day", ["28-11-2026", "2026-11-28-2", "today"])
def test_push_checks_the_date_even_without_upload(tmp_path: Path, cli: Any, day: str) -> None:
    pdir = make_partition(tmp_path / "d")
    argv = ["push", "--snapshot", "pk-code-seed", "--dir", str(pdir), "--no-upload"]
    assert cli.main([*argv, "--date", day]) == 2
    assert not (tmp_path / "staging").exists()


def test_a_network_error_is_one_line_not_a_traceback(
    cli: Any, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import httpx2

    class Offline:
        def list_repo_refs(self, *a: Any, **k: Any) -> Any:
            raise httpx2.ConnectError("no route to host")

        def list_repo_tree(self, *a: Any, **k: Any) -> Any:
            raise httpx2.ConnectError("no route to host")

    monkeypatch.setattr(SnapshotHub, "from_env", classmethod(lambda c: c(Offline(), "x/y")))
    assert cli.main(["status"]) == 1
    assert "could not reach Hugging Face (ConnectError" in capsys.readouterr().err

"""Split corpus documents into retrieval chunks (#18, PRD §8.2).

Pure and deterministic: the same text and settings always give the same chunks, so a re-run
changes nothing and two machines build the same corpus. Bump ``CHUNKER_VERSION`` whenever the
output can change; the embed job then re-chunks every document.

- **Statutes, rules and the Constitution** are split by section (article, rule). A chunk never
  crosses a section; a long section is split at its sub-sections, then at sentences. The table of
  contents, page headers and amendment footnotes are left out. In the CPC's First Schedule,
  rules restart under each Order, so they get "O. XXI r. 60" locators.
- **Judgments** are windows of whole paragraphs of about ``target_tokens``, with the paragraph
  numbers as the locator ("paras 4-6").
- **Head-note-only records** (SHC table rows, collector README §10.4) are one chunk, flagged.

Token counts are an estimate (words and punctuation marks), not a model tokenizer's: bge-m3
reads up to 8,192 tokens, so the estimate only has to keep chunks near the target size, and
keeping the model out of chunking keeps the chunks the same whichever embedder is used.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

CHUNKER_VERSION = "2"  # 2: the contents end of a statute without an enacting formula (#263)

_TOKEN = re.compile(r"\w+|[^\w\s]")
_SENTENCE_END = re.compile(r"(?<=[.;:])\s+(?=[(\[A-Z0-9“\"])")


def estimate_tokens(text: str) -> int:
    return len(_TOKEN.findall(text))


@dataclass(frozen=True)
class ChunkerSettings:
    target_tokens: int = 500
    max_tokens: int = 600
    min_tokens: int = 3  # fragments shorter than this (page furniture, stray numbers) are dropped

    def as_dict(self) -> dict[str, int | str]:
        return {**asdict(self), "version": CHUNKER_VERSION, "token_estimate": "words+punct"}


@dataclass(frozen=True)
class Chunk:
    ordinal: int
    text: str
    token_count: int
    locator: str | None
    section_id: str | None


# ── statutes ────────────────────────────────────────────────────────────────────────────────

# "302. Punishment of qatl-i-amd.—Whoever ...", "24A. Appearance ...", "3[3A. Inserted ...",
# "7. 5[* * *]", or the number alone on its line with the title below it (the CrPC's layout).
# Amendments can nest their marks: "3[2[375. Rape.__" (#263).
_SECTION_HEAD = re.compile(
    r"^\s*(?:\d{1,2}\[){0,2}(\d{1,4}[A-Z]{0,3})\s?\.\]?(?:\s+(?=[\[“\"'(A-Za-z]|\d{1,2}\[)|\s*$)"
)
_ORDER_HEAD = re.compile(r"^\s*ORDER\s+([IVXLC]+)\s*$")  # the CPC's First Schedule
# "THE FIRST SCHEDULE", "SCHEDULE III", "1SCHEDULE–II", "4[SCHEDULE IV", "SCHEDULE I.__ [Rep.]"
_SCHEDULE_HEAD = re.compile(r"^\s*(?:\d{1,2}\[?)?(?:THE\s+)?(?:[A-Z]+\s+){0,2}SCHEDULE\b")
_ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100}
_PAGE_HEADER = re.compile(r"^\s*Page\s+\d+\s+of\s+\d+\s*$", re.I)
# Amendment footnotes: "2Subs. by Ord. ...", "1For statement ...", "6S.12 was renumbered ...".
# A footnote mark is glued to the word; a section heading always has "." after its number.
_FOOTNOTE = re.compile(
    r"^\s*\d{1,3}(?:S\.\s?\d|Ss\.|Subs|Ins|Added|Omitted|Rep|Renumbered|The|For|See|Words|"
    r"Clause|Section|Proviso|Sub|Now|First|Second|Explanation|Original|Amended|Inserted|"
    r"Substituted)\b"
)
_ENACTING = re.compile(
    r"(hereby enacted|be it enacted|promulgate the following|"
    r"now,? therefore,? .{0,80}(enacted|made|ordered))",
    re.I,
)
_SUBSECTION = re.compile(r"^\s*(?:\d{1,2}\[)?\((\d{1,3}[A-Z]?)\)\s")
MAX_SECTION_GAP = 100  # omitted sections leave gaps; a bigger jump is a year or a stray number
# A number alone on its line is a heading only for a small step: margins and tables are full of
# stray numbers, while a real heading with its title on the same line can follow a long gap.
MAX_BARE_NUMBER_GAP = 3


@dataclass
class Section:
    section_id: str
    locator: str
    lines: list[str] = field(default_factory=list)


def _unit_label(title: str, kind: str) -> str:
    if kind == "rule":
        return "r."
    return "Art." if "constitution" in title.lower() else "s."


def _numeric(number: str) -> int:
    match = re.match(r"\d+", number)
    return int(match.group()) if match else 0


def _roman(value: str) -> int:
    total = 0
    for index, char in enumerate(value):
        n = _ROMAN[char]
        after = value[index + 1] if index + 1 < len(value) else ""
        total += -n if after and _ROMAN[after] > n else n
    return total


def _clean_lines(text: str) -> list[str]:
    return [
        line.rstrip()
        for line in text.replace("\r", "").split("\n")
        if not (_PAGE_HEADER.match(line) or _FOOTNOTE.match(line))
    ]


def _body_start(lines: list[str]) -> int:
    """The line after the enacting formula, which ends the table of contents; else 0."""
    for index, line in enumerate(lines):
        if _ENACTING.search(line):
            return index + 1
    return 0


@dataclass(frozen=True)
class _Candidate:
    line: int
    number: str
    bare: bool  # the number alone on its line
    stripped: bool = False  # read with a footnote mark removed from the front

    @property
    def weight(self) -> int:
        # A run is scored by its headings: a heading with its title on the line counts most,
        # and a number as written beats the same line read without a footnote mark.
        return (6 if self.bare else 8) - (1 if self.stripped else 0)


def _candidates(lines: list[str], start: int, end: int) -> list[_Candidate]:
    """Every line that could be a heading. A footnote mark glued to the front ("125." for s. 25
    carrying footnote 1) gives alternative readings; the best run picks at most one."""
    out: list[_Candidate] = []
    for index in range(start, end):
        head = _SECTION_HEAD.match(lines[index])
        if not head:
            continue
        number = head.group(1)
        bare = not lines[index][head.end() :].strip()
        for variant in dict.fromkeys((number, number[1:], number[2:])):
            if variant[:1].isdigit() and variant[0] != "0":
                out.append(_Candidate(index, variant, bare, stripped=variant != number))
    return out


def _steps(previous: str, number: str, bare: bool) -> bool:
    """Whether ``number`` can be the heading after ``previous``: upwards, with gaps for omitted
    sections, and "24A" may follow "24". A bare number only takes a small step."""
    gap = MAX_BARE_NUMBER_GAP if bare else MAX_SECTION_GAP
    last, value = _numeric(previous), _numeric(number)
    if value == last:
        return number > previous
    return last < value <= last + gap


def _best_run(candidates: list[_Candidate]) -> list[_Candidate]:
    """The longest run of headings in order (a longest increasing subsequence).

    Stray numbers (a "1." list inside s. 302, a year, a cross-reference that starts a line)
    rarely continue a run, so choosing the whole run at once ignores them, where reading
    heading by heading would follow the first stray number and lose the real ones after it.
    Inline headings beat bare numbers on a tie.
    """
    score = [0] * len(candidates)
    back = [-1] * len(candidates)
    for i, cand in enumerate(candidates):
        weight = cand.weight
        score[i] = weight
        for j in range(i - 1, -1, -1):
            prev = candidates[j]
            if (
                score[j]
                and prev.line != cand.line
                and score[j] + weight > score[i]
                and _steps(prev.number, cand.number, cand.bare)
            ):
                score[i], back[i] = score[j] + weight, j
    if not candidates or not max(score):
        return []
    i = max(range(len(candidates)), key=lambda k: (score[k], -k))
    run: list[_Candidate] = []
    while i != -1:
        run.append(candidates[i])
        i = back[i]
    return run[::-1]


def _contents_end(lines: list[str]) -> int:
    """Without an enacting formula: where a table of contents (a run of one-line entries
    starting at "1.") ends and the body's own "1." begins; 0 when there is no such table."""
    # Only a "1." as written: "11." and "21." also read as "1" with a footnote mark stripped,
    # which put the PPC's end of contents at its "11." entry, inside the contents (#263).
    starts = [
        c.line for c in _candidates(lines, 0, len(lines)) if c.number == "1" and not c.stripped
    ]
    if len(starts) < 2:
        return 0
    entries = [c for c in _candidates(lines, starts[0], starts[1]) if c.number != "1"]
    span = starts[1] - starts[0]
    return starts[1] if entries and span / (len(entries) + 1) < 4 else 0


def _schedule_starts(lines: list[str], start: int) -> list[int]:
    return [
        i
        for i in range(start, len(lines))
        if _SCHEDULE_HEAD.match(lines[i]) and len(lines[i]) < 160
    ]


def statute_sections(text: str, title: str = "", kind: str = "statute") -> list[Section]:
    """Split a statute into sections, in text order.

    The body runs from the enacting formula (or the end of the table of contents) to the first
    schedule. Its headings are the best run of section numbers. After that, each schedule is a
    section of its own, except that ORDER headings (the CPC's First Schedule) open Orders whose
    rules are found the same way as sections.
    """
    label = _unit_label(title, kind)
    lines = _clean_lines(text)
    start = _body_start(lines) or _contents_end(lines)
    schedules = _schedule_starts(lines, start)
    body_end = schedules[0] if schedules else len(lines)

    # (line, section) heads, then every line is filed under the last head before it.
    heads: list[tuple[int, Section]] = [(start, Section("", "preamble"))]
    for cand in _best_run(_candidates(lines, start, body_end)):
        heads.append((cand.line, Section(cand.number, f"{label} {cand.number}")))

    order_lines = [i for i in range(body_end, len(lines)) if _ORDER_HEAD.match(lines[i])]
    orders: list[tuple[int, str]] = []
    for i in order_lines:
        name = _ORDER_HEAD.match(lines[i]).group(1)  # type: ignore[union-attr]
        if not orders or _roman(name) > _roman(orders[-1][1]):
            orders.append((i, name))
    for i in schedules:
        heads.append((i, Section(f"Sch.{i}", _schedule_name(lines[i]))))
    for n, (i, name) in enumerate(orders):
        # An Order's rules run to the next Order or the next schedule, whichever comes first.
        end = min([o for o, _ in orders[n + 1 :]] + [x for x in schedules if x > i] + [len(lines)])
        heads.append((i, Section(f"O.{name}", f"O. {name}")))
        for cand in _best_run(_candidates(lines, i + 1, end)):
            heads.append(
                (cand.line, Section(f"O.{name}.r.{cand.number}", f"O. {name} r. {cand.number}"))
            )

    heads.sort(key=lambda h: h[0])
    for n, (i, section) in enumerate(heads):
        stop = heads[n + 1][0] if n + 1 < len(heads) else len(lines)
        section.lines = lines[i:stop]
    return [s for _, s in heads if "".join(s.lines).strip()]


def _schedule_name(line: str) -> str:
    """ "1SCHEDULE–II " -> "Schedule II"; "THE FIRST SCHEDULE" -> "First Schedule"."""
    match = re.search(r"(?:THE\s+)?((?:[A-Z]+\s+){0,2}SCHEDULE)\W*([IVXLC]+\b)?", line)
    if not match:
        return "Schedule"
    words = match.group(1).title().replace("The ", "")
    return f"{words} {match.group(2)}" if match.group(2) else words


def _join(lines: list[str]) -> str:
    text = "\n".join(lines)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def _split_long(text: str, settings: ChunkerSettings) -> list[tuple[str, str | None]]:
    """Split one section at sub-sections, then sentences. Returns (text, its first sub-section)."""
    if estimate_tokens(text) <= settings.max_tokens:
        return [(text, None)]
    pieces: list[tuple[str, str | None]] = []
    current: list[str] = []
    current_sub: str | None = None
    for line in text.split("\n"):
        sub = _SUBSECTION.match(line)
        if sub and current and estimate_tokens("\n".join(current)) >= settings.target_tokens // 2:
            pieces.append(("\n".join(current), current_sub))
            current, current_sub = [], sub.group(1)
        elif sub and not current:
            current_sub = sub.group(1)
        current.append(line)
    if current:
        pieces.append(("\n".join(current), current_sub))
    return [(window, sub) for piece, sub in pieces for window in _windows(piece, settings)]


def _windows(text: str, settings: ChunkerSettings) -> list[str]:
    """Sentence windows of about the target size; one over-long sentence is cut by words."""
    if estimate_tokens(text) <= settings.max_tokens:
        return [text]
    windows: list[str] = []
    current: list[str] = []
    size = 0
    for sentence in _SENTENCE_END.split(text):
        n = estimate_tokens(sentence)
        if n > settings.max_tokens:
            if current:
                windows.append(" ".join(current))
                current, size = [], 0
            windows.extend(_cut_words(sentence, settings.target_tokens))
            continue
        if current and size + n > settings.target_tokens:
            windows.append(" ".join(current))
            current, size = [], 0
        current.append(sentence)
        size += n
    if current:
        windows.append(" ".join(current))
    return windows


def _cut_words(text: str, size: int) -> list[str]:
    out: list[str] = []
    current: list[str] = []
    count = 0
    for word in text.split():
        n = estimate_tokens(word)
        if current and count + n > size:
            out.append(" ".join(current))
            current, count = [], 0
        current.append(word)
        count += n
    if current:
        out.append(" ".join(current))
    return out


def chunk_statute(
    text: str, title: str = "", kind: str = "statute", settings: ChunkerSettings | None = None
) -> list[Chunk]:
    settings = settings or ChunkerSettings()
    chunks: list[Chunk] = []
    for section in statute_sections(text, title, kind):
        for piece, sub in _split_long(_join(section.lines), settings):
            tokens = estimate_tokens(piece)
            if tokens < settings.min_tokens:
                continue
            locator = section.locator if sub in (None, "1") else f"{section.locator}({sub})"
            chunks.append(Chunk(len(chunks), piece, tokens, locator, section.section_id or None))
    return chunks


# ── judgments ───────────────────────────────────────────────────────────────────────────────

_PARA_NUMBER = re.compile(r"^\s*(\d{1,3})\s?[.)]\s+\S")


def _paragraphs(text: str) -> list[tuple[str | None, str]]:
    """(paragraph number or None, text). A blank line or a numbered line starts a paragraph."""
    paragraphs: list[tuple[str | None, list[str]]] = []
    for line in _clean_lines(text):
        if not line.strip():
            if paragraphs and paragraphs[-1][1]:
                paragraphs.append((None, []))
            continue
        numbered = _PARA_NUMBER.match(line)
        if numbered or not paragraphs:
            paragraphs.append((numbered.group(1) if numbered else None, [line]))
        else:
            paragraphs[-1][1].append(line)
    return [(n, body) for n, lines in paragraphs if (body := _join(lines))]


def _para_locator(numbers: list[str]) -> str | None:
    if not numbers:
        return None
    return f"para {numbers[0]}" if len(numbers) == 1 else f"paras {numbers[0]}-{numbers[-1]}"


def chunk_judgment(text: str, settings: ChunkerSettings | None = None) -> list[Chunk]:
    settings = settings or ChunkerSettings()
    chunks: list[Chunk] = []
    window: list[str] = []
    numbers: list[str] = []
    size = 0
    last_number: str | None = None

    def add(body: str, locator: str | None) -> None:
        tokens = estimate_tokens(body)
        if tokens >= settings.min_tokens:
            chunks.append(Chunk(len(chunks), body, tokens, locator, None))

    for number, body in _paragraphs(text):
        number = number or last_number  # an unnumbered paragraph continues the numbered one
        last_number = number
        n = estimate_tokens(body)
        if window and size + n > settings.target_tokens:
            add("\n".join(window), _para_locator(numbers))
            window, numbers, size = [], [], 0
        if n > settings.max_tokens:
            for piece in _windows(body, settings):
                add(piece, _para_locator([number] if number else []))
            continue
        window.append(body)
        if number and number not in numbers:
            numbers.append(number)
        size += n
    if window:
        add("\n".join(window), _para_locator(numbers))
    return chunks


# ── entry point ─────────────────────────────────────────────────────────────────────────────


def chunk_document(
    *,
    kind: str,
    title: str,
    full_text: str,
    headnote_only: bool,
    settings: ChunkerSettings | None = None,
) -> list[Chunk]:
    settings = settings or ChunkerSettings()
    if headnote_only:
        body = _join(_clean_lines(full_text))
        pieces = [p for p in _windows(body, settings) if estimate_tokens(p) >= settings.min_tokens]
        return [Chunk(i, p, estimate_tokens(p), "head-note", None) for i, p in enumerate(pieces)]
    if kind in {"statute", "rule"}:
        chunks = chunk_statute(full_text, title, kind, settings)
        if len(chunks) > 1:
            return chunks
        # No section headings (a short notification, an unusual layout): paragraph windows.
    return chunk_judgment(full_text, settings)

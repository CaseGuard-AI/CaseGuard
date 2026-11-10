"""Chunking (#18). The statute texts copy the layouts of the Pakistan Code PDFs (the PPC, CrPC,
CPC and Contract Act as extracted by the collector): a table of contents, the enacting formula,
page headers, amendment footnotes, bracketed amendments, numbers alone on their line, Orders
whose rules restart at 1, and schedules that list other statutes' section numbers."""

from __future__ import annotations

import pytest

from caseguard_ai.ingest.chunker import (
    CHUNKER_VERSION,
    ChunkerSettings,
    chunk_document,
    chunk_judgment,
    chunk_statute,
    estimate_tokens,
    statute_sections,
)

STATUTE = """Page 1 of 120
THE PAKISTAN PENAL CODE
CONTENTS
1.
Title and extent of operation of the Code
2.
Punishment of offences committed within Pakistan
24A. Interpretation
Page 2 of 120
ACT NO. XLV OF 1860
[6th October, 1860]
WHEREAS it is expedient to provide a general Penal Code for Pakistan; It is hereby enacted as follows:__
1. Title and extent of operation of the Code. This Act shall be called the Pakistan Penal Code.
2. Punishment of offences committed within Pakistan. Every person shall be liable to punishment
under this Code and not otherwise for every act or omission contrary to the provisions thereof.
1Subs. by the Federal Laws (Revision and Declaration) Ordinance, 1981.
Page 3 of 120
3.
Punishment of offences committed beyond, but which by law may be tried within, Pakistan.
Any person liable, by any Pakistan Law, to be tried for an offence committed beyond Pakistan.
24. Dishonestly. Whoever does anything with the intention of causing wrongful gain.
124A. Interpretation. Words used in this Code have the meanings given in this section, and the
following apply:
1. a word in the singular includes the plural;
2. a word in the masculine includes the feminine.
1908. This line is a stray year and is not a heading.
25. Fraudulently. A person is said to do a thing fraudulently if he does that thing with intent.
5[26. Reason to believe. A person is said to have reason to believe a thing, if he has sufficient
cause to believe that thing:
(a) but not otherwise;
(b) and in no other case.]
27. Property in possession of wife, clerk or servant. When property is in the possession.
"""


def locators(chunks: list) -> list[str | None]:
    return [c.locator for c in chunks]


def test_sections_skip_the_contents_page_headers_and_footnotes() -> None:
    sections = statute_sections(STATUTE, "Pakistan Penal Code")
    assert [s.locator for s in sections] == [
        "s. 1",
        "s. 2",
        "s. 3",
        "s. 24",
        "s. 24A",  # "124A." is s. 24A carrying footnote mark 1
        "s. 25",
        "s. 26",  # "5[26." opens an amendment
        "s. 27",
    ]
    text = "\n".join(line for s in sections for line in s.lines)
    assert "Page 3 of 120" not in text
    assert "1Subs. by the Federal Laws" not in text
    assert "CONTENTS" not in text


def test_a_list_or_a_year_inside_a_section_is_not_a_heading() -> None:
    by_locator = {s.locator: s for s in statute_sections(STATUTE)}
    body = "\n".join(by_locator["s. 24A"].lines)
    assert "1. a word in the singular" in body
    assert "1908. This line is a stray year" in body


def test_a_bare_number_with_its_title_below_is_a_heading() -> None:
    sections = {s.locator: s for s in statute_sections(STATUTE)}
    assert "Punishment of offences committed beyond" in "\n".join(sections["s. 3"].lines)


def test_a_run_may_start_anywhere_and_keeps_the_number_as_written() -> None:
    text = "It is hereby enacted as follows:\n497. When bail may be taken.\n498. Bail.\n"
    assert [s.locator for s in statute_sections(text)] == ["s. 497", "s. 498"]


def test_chunks_never_cross_a_section() -> None:
    chunks = chunk_statute(STATUTE, "Pakistan Penal Code")
    assert {"1", "2", "3", "24", "24A", "25", "26", "27"} == {c.section_id for c in chunks}
    s26 = next(c for c in chunks if c.section_id == "26")
    assert "in no other case" in s26.text and "Property in possession" not in s26.text


def test_a_long_section_is_split_at_its_sub_sections() -> None:
    sub = "\n".join(f"({n}) " + "The Court may grant bail in such case. " * 30 for n in range(1, 4))
    text = f"It is hereby enacted as follows:\n497. When bail may be taken.\n{sub}\n498. Next."
    chunks = chunk_statute(text, settings=ChunkerSettings(target_tokens=250, max_tokens=300))
    assert locators(chunks)[:3] == ["s. 497", "s. 497(2)", "s. 497(3)"]
    assert all(c.token_count <= 300 for c in chunks)
    assert chunks[-1].locator == "s. 498"


def test_a_very_long_sentence_is_still_cut_to_size() -> None:
    text = "It is hereby enacted as follows:\n1. Title. " + "word " * 2000
    chunks = chunk_statute(text, settings=ChunkerSettings(target_tokens=200, max_tokens=250))
    assert len(chunks) > 5 and all(c.token_count <= 250 for c in chunks)
    assert {c.locator for c in chunks} == {"s. 1"}


CPC = """WHEREAS it is expedient; It is hereby enacted as follows:__
1. Short title. This Act may be cited as the Code of Civil Procedure.
2. Definitions. In this Act, unless there is anything repugnant in the subject.
THE FIRST SCHEDULE
ORDER I
PARTIES TO SUITS
1. Who may be joined as plaintiffs. All persons may be joined in one suit as plaintiffs.
2. Power of Court to order separate trial. Where it appears to the Court.
ORDER II
FRAME OF SUIT
1. Frame of suit. Every suit shall as far as practicable be framed.
Order XXI, rule 60 is referred to here in running text and is not a heading.
2. Suit to include the whole claim. Every suit shall include the whole of the claim.
1SCHEDULE–II
Offences under the Pakistan Penal Code
302. Punishment of qatl-i-amd. Court of Session.
"""


def test_cpc_orders_restart_their_rules() -> None:
    assert [s.locator for s in statute_sections(CPC)] == [
        "s. 1",
        "s. 2",
        "First Schedule",
        "O. I",
        "O. I r. 1",
        "O. I r. 2",
        "O. II",
        "O. II r. 1",
        "O. II r. 2",
        "Schedule II",
    ]


def test_a_schedule_listing_other_section_numbers_is_not_the_body() -> None:
    sections = {s.locator: s for s in statute_sections(CPC)}
    assert "s. 302" not in sections
    assert "Punishment of qatl-i-amd" in "\n".join(sections["Schedule II"].lines)


def test_without_an_enacting_formula_the_contents_table_is_skipped() -> None:
    text = "\n".join(
        ["CONTENTS", "1.", "Short title", "2.", "Definitions", "3.", "Extent", "4.", "Savings"]
        + ["1. Short title. This Ordinance may be called the Example Ordinance, 2001."]
        + ["2. Definitions. In this Ordinance the following words have these meanings."]
    )
    sections = statute_sections(text)
    assert [s.locator for s in sections] == ["s. 1", "s. 2"]
    assert "Example Ordinance" in sections[0].lines[0]


def test_the_constitution_is_cut_into_articles() -> None:
    text = "Now, therefore, we, the people of Pakistan, do hereby adopt, enact and give to ourselves, this Constitution.\n"
    text += "199. Jurisdiction of High Court. Subject to the Constitution, a High Court may.\n"
    text += "200. Transfer of High Court Judges. The President may transfer a Judge."
    chunks = chunk_statute(text, "Constitution of the Islamic Republic of Pakistan")
    assert locators(chunks)[-2:] == ["Art. 199", "Art. 200"]


JUDGMENT = "\n".join(
    [
        "IN THE HIGH COURT OF SINDH AT KARACHI",
        "Criminal Bail Application No. 123 of 2024",
        "",
        "1. The applicant seeks post-arrest bail in a case under section 302 PPC. " * 6,
        "",
        "2. Learned counsel for the applicant contends that the FIR was delayed. " * 6,
        "He further submits that there is no direct evidence.",
        "",
        "3. The learned DPG opposes the application. " * 6,
        "",
        "4. For the above reasons, the application is allowed. " * 6,
    ]
)


def test_judgments_are_windows_of_whole_paragraphs_with_their_numbers() -> None:
    chunks = chunk_judgment(JUDGMENT, ChunkerSettings(target_tokens=180, max_tokens=240))
    assert locators(chunks) == ["para 1", "paras 2-3", "para 4"]
    assert all(c.token_count <= 240 for c in chunks)
    joined = "\n".join(c.text for c in chunks)
    assert "He further submits" in joined  # an unnumbered line stays with its paragraph
    assert joined.count("The learned DPG opposes") == 6  # nothing lost, nothing repeated


def test_a_headnote_only_record_is_one_flagged_chunk() -> None:
    row = "A (Appellant) VS The State. Bail granted. Bench: Justice X."
    chunks = chunk_document(kind="judgment", title="A vs State", full_text=row, headnote_only=True)
    assert [(c.locator, c.text) for c in chunks] == [("head-note", row)]


def test_a_statute_without_headings_falls_back_to_paragraph_windows() -> None:
    text = (
        "SRO 123(I)/2020. In exercise of the powers conferred, the Federal Government is pleased."
    )
    chunks = chunk_document(kind="statute", title="SRO", full_text=text, headnote_only=False)
    assert len(chunks) == 1 and chunks[0].text.startswith("SRO 123")


@pytest.mark.parametrize("kind", ["statute", "judgment"])
def test_chunking_is_deterministic(kind: str) -> None:
    text = STATUTE if kind == "statute" else JUDGMENT
    first = chunk_document(kind=kind, title="t", full_text=text, headnote_only=False)
    assert first == chunk_document(kind=kind, title="t", full_text=text, headnote_only=False)
    assert [c.ordinal for c in first] == list(range(len(first)))


def test_settings_record_the_chunker_version() -> None:
    assert ChunkerSettings().as_dict()["version"] == CHUNKER_VERSION
    assert estimate_tokens("s. 302, PPC.") == 6

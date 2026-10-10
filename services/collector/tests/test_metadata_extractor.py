from extractors.metadata_extractor import (
    extract_case_number, extract_cited_laws, extract_citations, extract_document_number,
    extract_judges, guess_document_type, split_parties,
)
from utils.dates import extract_year, in_year_range, normalise_date


def test_document_number_roman_numerals():
    assert extract_document_number("XVIII of 1999") == "XVIII of 1999"
    assert extract_document_number("Act No. XL of 1976") == "XL of 1976"


def test_document_number_returns_none_when_absent():
    assert extract_document_number("National Archives Act") is None
    assert extract_document_number(None) is None


def test_citations_real_pakistani_formats():
    text = "Relied on 2019 SCMR 984 and PLD 2023 FSC 301 and 2021 PTD 484."
    found = extract_citations(text)
    assert "2019 SCMR 984" in found
    assert "2021 PTD 484" in found


def test_judges_from_a_bench_line():
    bench = ("Hon'ble Mr. Justice Muhammad Ali Mazhar(Author), "
             "Hon'ble Mr. Justice Agha Faisal")
    judges = extract_judges(bench)
    assert "Muhammad Ali Mazhar" in judges
    assert "Agha Faisal" in judges
    assert all("Author" not in j for j in judges)


def test_judges_empty_input():
    assert extract_judges(None) == []
    assert extract_judges("no bench information") == []


def test_split_parties_sindh_format():
    title = ("Mirza Shakir Baig (Plaintiff) V/S Miss. Iffat Chughtai "
             "& Others (Defendant)")
    parties = split_parties(title)
    assert parties[0]["name"] == "Mirza Shakir Baig"
    assert parties[0]["role"] == "plaintiff"
    assert parties[1]["role"] == "defendant"


def test_split_parties_returns_empty_when_no_separator():
    assert split_parties("In the matter of Letter of Administration") == []


def test_case_number_patterns():
    assert extract_case_number("C.P. 3451/2017 was dismissed") is not None
    assert extract_case_number("nothing here") is None


def test_document_type_guessing():
    assert guess_document_type("National Accountability Ordinance, 1999") == "ordinance"
    assert guess_document_type("Constitution of Pakistan") == "constitution"
    assert guess_document_type("Companies (Amendment) Act, 2020") == "amendment"
    assert guess_document_type("National Archives Act, 1993") == "act"
    assert guess_document_type("") == "unknown"


def test_cited_laws():
    text = "challenged under the Income Tax Ordinance, 2001 and the Customs Act"
    laws = extract_cited_laws(text)
    assert any("Income Tax Ordinance, 2001" in law for law in laws)


def test_date_normalisation_across_site_formats():
    assert normalise_date("September 24 1999") == "1999-09-24"
    assert normalise_date("22-MAR-16") == "2016-03-22"
    assert normalise_date("18.05.2026") == "2026-05-18"
    assert normalise_date("31-3-2026") == "2026-03-31"


def test_junk_dates_return_none_rather_than_a_guess():
    # pakistancode.gov.pk renders missing dates as "December ."
    for junk in ("December .", "", None, "N/A", "1973", "not a date"):
        assert normalise_date(junk) is None


def test_extract_year():
    assert extract_year("XVIII of 1999") == 1999
    assert extract_year("1973") == 1973
    assert extract_year("no year") is None


def test_year_range_keeps_undated_documents():
    assert in_year_range(None, 2020, 2026) is True       # unknown -> keep
    assert in_year_range(2019, 2020, 2026) is False
    assert in_year_range(2021, 2020, 2026) is True
    assert in_year_range("2024-01-01", 2020, None) is True


def test_split_parties_handles_every_versus_spelling():
    variants = [
        "A Ltd (Plaintiff) V/S B Ltd (Defendant)",
        "A Ltd (Plaintiff) VS B Ltd (Defendant)",
        "A Ltd (Plaintiff) Versus B Ltd (Defendant)",
        "A Ltd (Plaintiff) vs. B Ltd (Defendant)",
    ]
    for title in variants:
        parties = split_parties(title)
        assert len(parties) == 2, title
        assert parties[0]["name"] == "A Ltd", title
        assert parties[1]["role"] == "defendant", title


def test_split_parties_survives_s_o_in_a_name():
    parties = split_parties(
        "AYUB MASIH S/O AINAYAT MASIH (Applicant) VS THE STATE (Respondent)"
    )
    assert parties[0]["name"] == "AYUB MASIH S/O AINAYAT MASIH"
    assert parties[1]["name"] == "THE STATE"


def test_all_caps_judgment_header_is_folded_to_title_case():
    """FSC/SCP headers are ALL CAPS; SHC publishes mixed case. Without folding,
    the same judge would become two rows in the judges table."""
    header = ("PRESENT\n"
              "MR. JUSTICE DR. SYED MUHAMMAD ANWER\n"
              "MR. JUSTICE AMEER MUHAMMAD KHAN")
    assert extract_judges(header) == ["Syed Muhammad Anwer", "Ameer Muhammad Khan"]


def test_mixed_case_names_are_left_alone():
    assert extract_judges("Hon'ble Mr. Justice Agha Faisal") == ["Agha Faisal"]


def test_a_name_never_runs_into_the_next_line():
    header = "MR. JUSTICE ABC KHAN\nMR. JUSTICE XYZ SHAH"
    assert extract_judges(header) == ["Abc Khan", "Xyz Shah"]


def test_chief_justice_prefix_is_not_captured_as_a_name():
    bench = "Hon'ble Chief Justice Mr. Justice Ahmed Ali M. Shaikh(Author)"
    assert extract_judges(bench) == ["Ahmed Ali M. Shaikh"]

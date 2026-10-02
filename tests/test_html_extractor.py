from extractors.html_extractor import (
    clean_text, extract_links, extract_tables, extract_text, find_pdf_links,
)

HTML = """
<html><head><title>T</title><style>p{color:red}</style></head>
<body>
  <script>var x = 1;</script>
  <nav>menu junk</nav>
  <div id="main"><h1>National Archives Act, 1993</h1>
    <p>Section 1.<br>Short   title.</p></div>
  <a href="/english/UY2Fqa-sg-jjjj">A Law</a>
  <a href="/pdffiles/administratorabc.pdf">PDF</a>
  <a href="javascript:void(0)">js</a>
  <a href="https://other.example.com/x.pdf">external</a>
  <table><tr><th>Case</th><th>Date</th></tr>
         <tr><td>208/2015</td><td>22-MAR-16</td></tr></table>
</body></html>
"""


def test_boilerplate_is_removed():
    text = extract_text(HTML)
    assert "var x" not in text and "menu junk" not in text
    assert "National Archives Act, 1993" in text


def test_selector_scopes_extraction():
    text = extract_text(HTML, selector="#main")
    assert text.startswith("National Archives Act")
    assert "A Law" not in text


def test_br_becomes_a_newline():
    assert "Section 1.\nShort title." in extract_text(HTML, selector="#main")


def test_links_are_absolutised_and_filtered():
    links = extract_links(HTML, "https://pakistancode.gov.pk/english/index.php")
    urls = [l.url for l in links]
    assert "https://pakistancode.gov.pk/english/UY2Fqa-sg-jjjj" in urls
    assert not any("javascript" in u for u in urls)


def test_pattern_filter():
    links = extract_links(HTML, "https://pakistancode.gov.pk/", pattern=r"-sg-j+$")
    assert len(links) == 1 and links[0].text == "A Law"


def test_same_host_only():
    links = extract_links(HTML, "https://pakistancode.gov.pk/",
                          pattern=r"\.pdf$", same_host_only=True)
    assert all("pakistancode.gov.pk" in l.url for l in links)


def test_find_pdf_links():
    assert len(find_pdf_links(HTML, "https://pakistancode.gov.pk/")) == 2


def test_tables():
    tables = extract_tables(HTML)
    assert tables[0][0] == ["Case", "Date"]
    assert tables[0][1] == ["208/2015", "22-MAR-16"]


def test_clean_text_collapses_blank_lines():
    assert clean_text("a\n\n\n\n\nb") == "a\n\nb"

"""The statute→area classifier (#200, docs/engineering/case-taxonomy.md §5). Deterministic: the
same text always gets the same label, and every label keeps the evidence that produced it.

    pnpm ai:classify-areas [--limit N] [--dry-run]
    pnpm ai:classify-areas --sample 200 --out review.csv     # the §6 hand-labelling sample
    pnpm ai:classify-areas --score review.csv                # precision/recall per area

How a judgment is labelled:

1. **Statute evidence.** Section references to the PPC, CrPC, CPC and QSO ("ss. 302, 324, 34
   PPC", "u/s 497 Cr.P.C.") are mapped by the taxonomy file's ``statute_rules`` (PPC by section
   range). Every other statute in the rules is matched by name or a common short form ("CNS Act",
   "ATA", "SRPO"), in the text and in the collector's ``cited_laws``. Procedural law (CrPC, CPC,
   QSO, Limitation Act) is kept as evidence but never scores an area.
2. **Weighting** (where in the judgment the reference sits). Each distinct reference counts once,
   at the highest weight it appears with:

   - ``precedent`` (0.25): within ``WINDOW`` characters of a law-report citation or wording that
     introduces case law ("reported as", "in the case of", "relied upon"). This is how passing
     mentions in cited precedents are told apart from the judgment's own subject.
   - ``operative`` (2.0): in the opening (title, FIR offences, prayer) or the closing (the order
     itself), or next to wording about the offence or relief ("offence", "FIR", "punishable",
     "prayed", "relief sought"). The reference itself is left out of that check.
   - A head-note reference is always ``headnote``: the head-note is the court's own summary.
   - ``headnote`` (1.5) for the head-note, ``cited_laws`` (1.0) for the collector's list,
     ``body`` (1.0) for everything else.

   Each statute rule (a whole Act, or one PPC section range) then scores once, at its
   strongest reference: "ss. 302, 324, 147, 148, 149 PPC" is one homicide-and-hurt reference
   and one rioting reference, not two against three. An area's score is the sum over its rules.
   The leader wins if it has at least ``MIN_SCORE``, at least one reference that is not a
   precedent mention, and ``CLEAR_LEAD`` times the runner-up.
3. **Keywords** only break a tie between areas that already have statute evidence and are within
   ``CLEAR_LEAD`` of the leader (*khula*, *ejectment*, *pre-emption*...): ``KEYWORD_WEIGHT`` per
   distinct keyword. The tie is broken only if the new leader has keyword hits of its own and
   then meets ``CLEAR_LEAD``. Keywords never label a judgment on their own.
4. **Otherwise ``unclassified``**, with the evidence and the leader's confidence kept.

Head-note-only records are labelled from the head-note, or are ``unclassified`` without one.
No model is involved (doc §5: an LLM classifier is P2, compared on the same reviewed sample).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from caseguard_ai.graph.citations import CITATION, CODES
from caseguard_ai.taxonomy.rules import (
    PROCEDURE,
    UNCLASSIFIED,
    StatuteRule,
    Taxonomy,
    load_taxonomy,
    section_key,
)

CLASSIFIER_VERSION = "rules-1"  # bump when the rules below change, so labels can be re-run

# ── weights and thresholds (named so the review can tune them) ─────────────────────────────
OPERATIVE_WEIGHT = 2.0
BODY_WEIGHT = 1.0
HEADNOTE_WEIGHT = 1.5
CITED_LAWS_WEIGHT = 1.0
PRECEDENT_WEIGHT = 0.25
KEYWORD_WEIGHT = 0.5  # per distinct keyword, in a tie-break only
CLEAR_LEAD = 1.5  # the leader needs this many times the runner-up's score
MIN_SCORE = 1.0  # ...and at least one reference that is not a precedent mention
FULL_CONFIDENCE_SCORE = 2.0  # a leader at this score or more is not discounted for weak evidence
OPENING_CHARS = 1500
CLOSING_CHARS = 1500
WINDOW = 150  # characters either side of a reference, for the precedent and offence checks
MAX_EVIDENCE = 20

# ── statute references ─────────────────────────────────────────────────────────────────────

# The code a section reference names, as the taxonomy file spells the statute.
CODE_STATUTES = {"PPC": "PPC", "CrPC": "CrPC", "CPC": "CPC", "QSO": "Qanun-e-Shahadat Order 1984"}

_NUM = r"\d{1,4}(?:-?[A-Z](?![a-z]))?"
_PARENS = r"(?:\s*\(\s*\w{1,4}\s*\))*"
_CODE_ALIASES = "|".join(
    f"(?P<c{i}>{'|'.join(c.aliases)})"
    for i, c in enumerate(CODES)
    if c.abbreviation != "Constitution"
)
# Like graph.citations.SECTION, but a list of sections before one code ("sections 302, 324/34
# PPC"), which is how offences are usually charged.
SECTION_LIST = re.compile(
    r"\b(?:sections?|ss?\.|u/ss?\.?)\s*"
    rf"(?P<nums>{_NUM}{_PARENS}(?:\s*(?:,|/|&|\band\b)\s*{_NUM}{_PARENS})*)"
    r"\s*,?\s*(?:of\s+(?:the\s+)?)?"
    rf"(?:{_CODE_ALIASES})(?![A-Za-z])",
    re.I,
)
_ONE_NUM = re.compile(rf"({_NUM}){_PARENS}", re.I)
_CODE_GROUPS = [
    (f"c{i}", c.abbreviation) for i, c in enumerate(CODES) if c.abbreviation != "Constitution"
]

# Short forms and older names of the statutes in the rules, beside the name itself. Upper-case
# abbreviations match case-sensitively.
STATUTE_ALIASES: dict[str, tuple[str, ...]] = {
    "Control of Narcotic Substances Act 1997": (
        r"\b(?-i:C\.?N\.?S\.?A)\b",
        r"(?<![A-Za-z])(?-i:CNS)\s*Act\b",  # also "15CNS Act", as OCR joins it
        r"\bNarcotics?\s+Substances?\s+Act\b",  # also the Sindh 2024 Act
    ),
    "Anti-Terrorism Act 1997": (r"\b(?-i:A\.?T\.?A)\b", r"\bAnti[\s-]*Terrorism\s+Act\b"),
    "Sindh Arms Act 2013": (r"\bArms\s+Act\b", r"\bArms\s+Ordinance\b"),
    "National Accountability Ordinance 1999": (r"\b(?-i:N\.?A\.?O)\b", r"\bNAB\s+Ordinance\b"),
    "Financial Institutions (Recovery of Finances) Ordinance 2001": (
        r"\b(?-i:FIO)\b",
        r"\bFinancial\s+Institutions\s+\(?Recovery\b",
    ),
    "Muslim Family Laws Ordinance 1961": (r"\b(?-i:MFLO)\b",),
    "Guardians and Wards Act 1890": (
        r"\bGuardians?\s*(?:and|&)\s*Wards?\s+Act\b",
        r"\b(?-i:G\s*&\s*W)\s+Act\b",
    ),
    "Sindh Rented Premises Ordinance 1979": (
        r"\b(?-i:SRPO)\b",
        r"\bRented\s+Premises\s+Ordinance\b",
    ),
    "Sindh Civil Servants Act 1973": (r"\bCivil\s+Servants\s+Act\b",),
    "Companies Act 2017": (r"\bCompanies\s+Ordinance\b",),  # the 1984 Ordinance it replaced
}

# Finer PPC sub-categories inside a rule that names none (doc §3.1). Only used when the
# taxonomy rule itself gives no sub-category; the area always comes from the rule.
PPC_SUBCATEGORY_HINTS: tuple[tuple[str, str, str, str], ...] = (
    ("121", "130", "public_order_and_state", "offences_against_state"),
    ("141", "160", "public_order_and_state", "unlawful_assembly_rioting"),
    ("172", "190", "public_order_and_state", "offences_against_public_servants"),
    ("299", "331", "offences_against_person", "homicide"),
    ("332", "337-Z", "offences_against_person", "hurt"),
    ("378", "382-B", "offences_against_property", "theft"),
    ("383", "389", "offences_against_property", "extortion"),
    ("390", "402-C", "offences_against_property", "robbery_dacoity"),
    ("403", "409", "offences_against_property", "criminal_breach_of_trust"),
    ("415", "424", "offences_against_property", "cheating_fraud"),
    ("441", "462", "offences_against_property", "criminal_trespass"),
)

PRECEDENT_CUE = re.compile(
    r"\b(?:reported\s+(?:as|in)|in\s+the\s+cases?\s+of|relied\s+(?:up)?on|reliance\s+(?:is\s+|was\s+)?placed"
    r"|case\s+law|dictum|(?:it\s+was|has\s+been)\s+held)\b",
    re.I,
)
OFFENCE_CUE = re.compile(
    r"\b(?:offen[cs]es?|F\.?I\.?R|crime\s+no|charged?|punishable|booked|convicted|sentenced"
    r"|prayed|prayer|relief\s+(?:sought|claimed|prayed)|suit\s+for|petition\s+under"
    r"|appeal\s+under)\b",
    re.I,
)

# Keywords, a tie-breaker only (doc §5 step 3).
AREA_KEYWORDS: dict[str, tuple[str, ...]] = {
    "family": (
        r"khula",
        r"dissolution\s+of\s+marriage",
        r"dower",
        r"haq\s+mehr",
        r"custody\s+of",
        r"maintenance",
    ),
    "rent_and_tenancy": (r"ejectment", r"tenan(?:ts?|cy)", r"landlords?", r"fair\s+rent"),
    "property_and_land": (r"pre-?emption", r"shufa", r"partitions?", r"mutations?"),
    "service_and_employment": (r"regulari[sz]ation", r"promotions?", r"seniority", r"pensions?"),
    "contract_and_commercial": (
        r"specific\s+performance",
        r"agreement\s+to\s+sell",
        r"recovery\s+of\s+money",
        r"banking\s+court",
    ),
    "succession": (
        r"letters?\s+of\s+administration",
        r"succession\s+certificate",
        r"legal\s+heirs",
    ),
    "tax_customs_revenue": (r"income\s+tax", r"sales\s+tax", r"customs\s+duty", r"assessment"),
    "company_and_insolvency": (r"winding\s+up", r"liquidators?", r"insolven(?:t|cy)"),
    "public_and_administrative": (
        r"nomination\s+papers",
        r"elections?",
        r"local\s+government",
        r"building\s+control",
    ),
    "torts_and_damages": (r"malicious\s+prosecution", r"defamation", r"damages"),
    "narcotics": (r"charas", r"heroin", r"narcotics?", r"opium"),
    "terrorism": (r"terroris[mt]",),
    "arms_and_explosives": (r"pistols?", r"unlicen[cs]ed", r"kalashnikovs?", r"explosives?"),
    "corruption_and_accountability": (r"accountability\s+court", r"corruption"),
    "offences_against_person": (r"murder(?:s|ed)?", r"qatl", r"injur(?:y|ies)"),
    "offences_against_property": (
        r"thefts?",
        r"robber(?:y|ies)",
        r"dacoit(?:y|ies)",
        r"dishono(?:u)?red\s+cheque",
    ),
    "documents_and_forgery": (r"forg(?:ed|ery)", r"counterfeit"),
    "public_order_and_state": (r"rioting", r"unlawful\s+assembly"),
}

# Sub-category keywords inside the winning area, when no statute evidence names one.
SUBCATEGORY_KEYWORDS: dict[str, dict[str, tuple[str, ...]]] = {
    "family": {
        "dissolution_khula": (r"khula", r"dissolution\s+of\s+marriage"),
        "maintenance": (r"maintenance",),
        "custody_guardianship": (r"custody", r"guardian"),
        "dower": (r"dower", r"haq\s+mehr"),
    },
    "rent_and_tenancy": {"ejectment": (r"ejectment",), "fair_rent": (r"fair\s+rent",)},
    "property_and_land": {
        "pre_emption": (r"pre-?emption", r"shufa"),
        "partition": (r"partition",),
        "land_revenue": (r"mutation", r"revenue\s+record"),
    },
    "service_and_employment": {
        "regularisation": (r"regulari[sz]ation",),
        "promotion": (r"promotion", r"seniority"),
        "pension": (r"pension",),
        "appointment": (r"appointment",),
        "labour": (r"workm[ae]n", r"labour\s+court"),
    },
    "contract_and_commercial": {
        "specific_performance": (r"specific\s+performance",),
        "recovery_of_money": (r"recovery\s+of\s+(?:money|amount|rs)",),
        "injunctions": (r"injunction",),
        "banking_recovery": (r"banking\s+court",),
    },
    "succession": {
        "letters_of_administration": (r"letters?\s+of\s+administration",),
        "inheritance": (r"inheritance", r"legal\s+heirs"),
    },
    "company_and_insolvency": {
        "winding_up": (r"winding\s+up",),
        "insolvency": (r"insolven(?:t|cy)",),
        "admiralty": (r"admiralty",),
    },
    "public_and_administrative": {
        "elections": (r"election", r"nomination\s+papers"),
        "local_government": (r"local\s+government",),
        "planning_building": (r"building\s+control",),
        "education": (r"universit(?:y|ies)", r"education"),
        "utilities": (r"electricity", r"sui\s+gas"),
    },
    "torts_and_damages": {
        "malicious_prosecution": (r"malicious\s+prosecution",),
        "defamation": (r"defamation",),
        "damages": (r"damages",),
    },
}


def _compile(patterns: Iterable[str]) -> re.Pattern[str]:
    return re.compile("|".join(f"(?:{p})" for p in patterns), re.I)


def _name_pattern(statute: str) -> str:
    """ "Control of Narcotic Substances Act 1997" → its words, any punctuation between, no year."""
    stem = re.sub(r",?\s*(?:1[89]|20)\d{2}\s*$", "", statute)
    return r"\b" + r"[\W_]+".join(re.findall(r"[A-Za-z]+", stem)) + r"\b"


# ── result ─────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Evidence:
    ref: str  # "s.302 PPC", "Anti-Terrorism Act 1997"
    area: str  # an area id, or "procedure"
    subcategory: str | None
    where: str  # operative | body | precedent | headnote | cited_laws
    weight: float
    rule: str = ""  # the statute rule it matched: "PPC 299-338-H", "Anti-Terrorism Act 1997"

    def as_dict(self) -> dict[str, Any]:
        return {
            "ref": self.ref,
            "area": self.area,
            "subcategory": self.subcategory,
            "where": self.where,
            "weight": self.weight,
            "rule": self.rule,
        }


@dataclass(frozen=True)
class AreaLabel:
    area: str  # an area id, or "unclassified"
    subcategory: str | None
    confidence: float  # 0..1; for unclassified, the leader's (how close it came)
    reason: str  # why: "clear lead", "keyword tie-break", "no clear lead", ...
    leader: str | None = None  # the best-scoring area, also when unclassified
    scores: dict[str, float] = field(default_factory=dict)
    evidence: tuple[Evidence, ...] = ()
    keywords: tuple[str, ...] = ()

    def as_raw(self, version: str) -> dict[str, Any]:
        """The ``raw.area_label`` record kept with the document."""
        return {
            "taxonomy_version": version,
            "classifier": CLASSIFIER_VERSION,
            "area": self.area,
            "subcategory": self.subcategory,
            "confidence": self.confidence,
            "reason": self.reason,
            "leader": self.leader,
            "scores": self.scores,
            "evidence": [e.as_dict() for e in self.evidence],
            "keywords": list(self.keywords),
        }


# ── the classifier ─────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Hint:
    start: tuple[int, str]
    end: tuple[int, str]
    area: str
    subcategory: str


class Classifier:
    """Compiled rules for one taxonomy. Build once, call ``classify`` per judgment."""

    def __init__(self, taxonomy: Taxonomy) -> None:
        self.taxonomy = taxonomy
        named = [r for r in taxonomy.rules if r.statute not in CODE_STATUTES.values()]
        self._named: list[tuple[StatuteRule, re.Pattern[str]]] = [
            (r, _compile([_name_pattern(r.statute), *STATUTE_ALIASES.get(r.statute, ())]))
            for r in named
        ]
        self._hints = [
            _Hint(section_key(a), section_key(b), area, sub)
            for a, b, area, sub in PPC_SUBCATEGORY_HINTS
        ]
        for hint in self._hints:
            taxonomy.check_subcategory(hint.area, hint.subcategory)
        self._keywords = {
            area: [(p, re.compile(rf"\b{p}\b", re.I)) for p in ps]
            for area, ps in AREA_KEYWORDS.items()
        }
        self._sub_keywords = {
            area: {sub: _compile(rf"\b{p}\b" for p in ps) for sub, ps in subs.items()}
            for area, subs in SUBCATEGORY_KEYWORDS.items()
        }

    # ---- references in one piece of text ----

    def _where(self, text: str, start: int, end: int, base: str) -> str:
        # A head-note is the court's own summary: a statute in it is the case's subject even
        # beside a cited case.
        if base == "headnote":
            return "headnote"
        # The context around the reference, without the reference itself (so "Specific Relief
        # Act" is not its own relief cue).
        window = text[max(0, start - WINDOW) : start] + " " + text[end : end + WINDOW]
        if CITATION.search(window) or PRECEDENT_CUE.search(window):
            return "precedent"
        if start < OPENING_CHARS or end > len(text) - CLOSING_CHARS or OFFENCE_CUE.search(window):
            return "operative"
        return "body"

    def _section_evidence(self, number: str, abbreviation: str, where: str) -> Evidence | None:
        statute = CODE_STATUTES[abbreviation]
        rule = self.taxonomy.section_rule(statute, number)
        if rule is None:
            return None
        key = section_key(number)
        label = f"s.{key[0]}{'-' + key[1] if key[1] else ''} {abbreviation}"
        subcategory = rule.subcategory
        if subcategory is None and statute == "PPC":
            subcategory = next(
                (
                    h.subcategory
                    for h in self._hints
                    if h.area == rule.area and h.start <= key <= h.end
                ),
                None,
            )
        return Evidence(label, rule.area, subcategory, where, WEIGHTS[where], _rule_key(rule))

    def _scan(self, text: str, base: str) -> list[Evidence]:
        found: list[Evidence] = []
        for m in SECTION_LIST.finditer(text):
            abbreviation = next(a for g, a in _CODE_GROUPS if m.group(g))
            where = self._where(text, m.start(), m.end(), base)
            for num in _ONE_NUM.finditer(m.group("nums")):
                evidence = self._section_evidence(num.group(1), abbreviation, where)
                if evidence:
                    found.append(evidence)
        for rule, pattern in self._named:
            for m in pattern.finditer(text):
                where = self._where(text, m.start(), m.end(), base)
                found.append(
                    Evidence(
                        rule.statute,
                        rule.area,
                        rule.subcategory,
                        where,
                        WEIGHTS[where],
                        _rule_key(rule),
                    )
                )
        return found

    def _cited(self, cited_laws: Iterable[str]) -> list[Evidence]:
        found = []
        for law in cited_laws:
            for rule, pattern in self._named:
                if pattern.search(law):
                    found.append(
                        Evidence(
                            rule.statute,
                            rule.area,
                            rule.subcategory,
                            "cited_laws",
                            CITED_LAWS_WEIGHT,
                            _rule_key(rule),
                        )
                    )
        return found

    # ---- the label ----

    def classify(
        self,
        text: str | None,
        headnote: str | None = None,
        cited_laws: Sequence[str] = (),
        headnote_only: bool = False,
    ) -> AreaLabel:
        """Label one judgment. ``text`` is the judgment (``full_text``), ``headnote`` its head-note
        if it has one, ``cited_laws`` the collector's list of Acts. A head-note-only record is
        labelled from its head-note alone (its text is only the listing)."""
        if headnote_only:
            if not (headnote or "").strip():
                return AreaLabel(UNCLASSIFIED, None, 0.0, "head-note only, without a head-note")
            segments = [(headnote or "", "headnote")]
        else:
            segments = [(text or "", "body"), (headnote or "", "headnote")]
        found = [e for segment, base in segments if segment for e in self._scan(segment, base)]
        found += self._cited(cited_laws)

        best: dict[tuple[str, str], Evidence] = {}
        for e in found:
            key = (e.ref, e.area)
            if key not in best or e.weight > best[key].weight:
                best[key] = e
        evidence = tuple(sorted(best.values(), key=lambda e: (-e.weight, e.ref))[:MAX_EVIDENCE])
        # Each statute rule (a whole Act, or one PPC range) scores once, at its strongest
        # reference, so a charge list such as "ss. 147, 148, 149 PPC" counts as one rioting
        # reference, not three.
        per_rule: dict[str, Evidence] = {}
        for e in best.values():
            if e.area != PROCEDURE and (
                e.rule not in per_rule or e.weight > per_rule[e.rule].weight
            ):
                per_rule[e.rule] = e
        scores: dict[str, float] = {}
        for e in per_rule.values():
            scores[e.area] = scores.get(e.area, 0.0) + e.weight
        if not scores:
            reason = "procedural law only" if best else "no statute evidence"
            return AreaLabel(UNCLASSIFIED, None, 0.0, reason, evidence=evidence)

        haystack = "\n".join(s for s, _ in segments if s)
        ranked = _ranked(scores)
        leader, top = ranked[0]
        second = ranked[1][1] if len(ranked) > 1 else 0.0
        keywords: tuple[str, ...] = ()
        # Areas with at least one reference that is not a precedent mention.
        grounded = {e.area for e in per_rule.values() if e.where != "precedent"}
        if top < MIN_SCORE or leader not in grounded:
            return self._label(
                UNCLASSIFIED,
                "weak evidence (precedent mentions only)",
                leader,
                scores,
                evidence,
                haystack,
                keywords,
            )
        if top >= CLEAR_LEAD * second:
            return self._label(leader, "clear lead", leader, scores, evidence, haystack, keywords)

        # Tie-break: keywords for the areas close to the leader, and only for them.
        matched = {
            area: [p for p, rx in self._keywords.get(area, []) if rx.search(haystack)]
            for area, score in ranked
            if score * CLEAR_LEAD >= top
        }
        keywords = tuple(f"{area}:{p}" for area, ps in matched.items() for p in ps)
        winner, adjusted = tie_break(scores, {a: len(ps) for a, ps in matched.items()}, grounded)
        leader = _ranked(adjusted)[0][0]
        if winner is not None:
            return self._label(
                winner, "keyword tie-break", winner, adjusted, evidence, haystack, keywords
            )
        return self._label(
            UNCLASSIFIED, "no clear lead", leader, adjusted, evidence, haystack, keywords
        )

    def _label(
        self,
        area: str,
        reason: str,
        leader: str,
        scores: dict[str, float],
        evidence: tuple[Evidence, ...],
        haystack: str,
        keywords: tuple[str, ...],
    ) -> AreaLabel:
        top = scores[leader]
        confidence = round(top / sum(scores.values()) * min(1.0, top / FULL_CONFIDENCE_SCORE), 2)
        subcategory = self._subcategory(area, evidence, haystack) if area != UNCLASSIFIED else None
        return AreaLabel(
            area,
            subcategory,
            confidence,
            reason,
            leader=leader,
            scores={k: round(v, 2) for k, v in sorted(scores.items())},
            evidence=evidence,
            keywords=keywords,
        )

    def _subcategory(self, area: str, evidence: tuple[Evidence, ...], haystack: str) -> str | None:
        """The sub-category of the strongest reference in the area that has one, else the one
        sub-category whose keywords appear most (none on a tie)."""
        for e in evidence:  # sorted strongest first
            if e.area == area and e.subcategory:
                return e.subcategory
        counts = [
            (sum(1 for _ in rx.finditer(haystack)), sub)
            for sub, rx in self._sub_keywords.get(area, {}).items()
        ]
        counts = sorted((c for c in counts if c[0]), reverse=True)
        if counts and (len(counts) == 1 or counts[0][0] > counts[1][0]):
            return counts[0][1]
        return None


WEIGHTS = {
    "operative": OPERATIVE_WEIGHT,
    "body": BODY_WEIGHT,
    "headnote": HEADNOTE_WEIGHT,
    "cited_laws": CITED_LAWS_WEIGHT,
    "precedent": PRECEDENT_WEIGHT,
}


def tie_break(
    scores: dict[str, float], hits: dict[str, int], grounded: set[str]
) -> tuple[str | None, dict[str, float]]:
    """Add ``KEYWORD_WEIGHT`` per keyword hit (``hits``: distinct keywords per area, for the areas
    close to the leader). The new leader wins only if the hits are its own, it has a reference
    that is not a precedent mention, and it now has ``CLEAR_LEAD`` over the runner-up. A
    runner-up's hit never crowns the area that was leading anyway. Returns the winner (or None)
    and the adjusted scores."""
    adjusted = {area: score + KEYWORD_WEIGHT * hits.get(area, 0) for area, score in scores.items()}
    ranked = _ranked(adjusted)
    leader, top = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 0.0
    if hits.get(leader) and leader in grounded and top >= CLEAR_LEAD * second:
        return leader, adjusted
    return None, adjusted


def _rule_key(rule: StatuteRule) -> str:
    if rule.sections is None:
        return rule.statute

    def number(key: tuple[int, str]) -> str:
        return f"{key[0]}-{key[1]}" if key[1] else str(key[0])

    return f"{rule.statute} {number(rule.sections.start)}-{number(rule.sections.end)}"


def _ranked(scores: dict[str, float]) -> list[tuple[str, float]]:
    return sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))


def classify(
    text: str | None,
    headnote: str | None = None,
    cited_laws: Sequence[str] = (),
    headnote_only: bool = False,
    taxonomy: Taxonomy | None = None,
) -> AreaLabel:
    """Label one judgment with the v1 taxonomy (see the module docstring)."""
    return Classifier(taxonomy or load_taxonomy()).classify(
        text, headnote, cited_laws, headnote_only
    )


if __name__ == "__main__":
    from caseguard_ai.taxonomy.cli import main

    raise SystemExit(main())

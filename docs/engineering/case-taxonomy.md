# Case taxonomy: proposal

> **Status:** Proposal for supervisor review, 2026-11-10. **Owner:** team. Source of the request: handoff §3 ("the supervisor asked for sub-categories"). Related: #148 (enough civil judgments?), #153 (selection files), #22 (test set).

## In one paragraph

Every judgment and every user case gets **two labels**:
- its **area of law**, with a sub-category (what the case is *about*, e.g. *offences against the person → homicide*);
- its **proceeding type** (what is being *asked of the court*, e.g. *bail*, *suit*, *revision*).

Whether it is **civil or criminal** follows from those two labels, so it is never entered by hand.

The proceeding type comes **mechanically** from the case type the court publishes. The area of law comes from **the statutes and sections the judgment itself cites**, and a team-reviewed sample is used to measure how accurate that is.

A measurement made for this proposal also answers most of #148: **in SHC's full listings about 11% of judgments are civil by case type**. In the reported-only (AFR) listings measured before, it was 2% or less. A further 45% are constitutional petitions, which can be either civil or criminal.

---

## 1. Why we need it

The labels decide five things in the product and the report:

| Where | What the labels do |
|---|---|
| **Corpus selection** (#153) | Which judgments go into the `shc-criminal` and `shc-civil` partitions, and in what mix |
| **Test set** (#22, PRD §11) | "Half civil, half criminal", spread over areas and proceeding types, so results aren't one kind of case |
| **Research and precedent filters** | "Show me bail judgments on narcotics", "civil revisions on limitation" |
| **Drafting and linter** (FR-DRAFT-1, FR-LINT-1) | A case's proceeding type picks the template and rule set: *bail* → bail application (s.497/498 CrPC), *suit* → plaint (Order VII CPC) |
| **Cases** (FR-CASE-1) | A user's own case is labelled from the same list, so research, drafts and precedents line up with it |

## 2. What the data says (measured 2026-11-10)

A metadata-only pass over SHC's **full** listings (`PKLEGAL_SHC_SCOPE=all --no-pdfs`). It covered 6 sitting judges and 18,027 unique judgments from 2015–2026, across the Karachi, Hyderabad, Larkana and Sukkur benches.

| Finding | Number | What it means |
|---|---|---|
| Distinct case types (`matter_type`) | **57** | Too many to filter on directly. They group cleanly into 19 proceeding types (§4). Every one of the 57 maps. |
| Constitutional petitions (`Const. P`) | **45.4%** | The single biggest group. Its subject can be civil (service, land, tax) or criminal (FIR quashing, NAB bail), so it needs an area label to be useful. |
| Criminal by case type | **43.6%** | Bail alone is **25.1%** of everything. Then appeals 8.0%, miscellaneous (incl. quashing) 4.9%, revisions 2.0%. |
| Civil by case type | **11.0%** | Intra-court appeals 2.4%, suits 2.1%, succession 1.7%, first appeals 1.6%, civil revisions 1.4%. |
| …varies by judge | **1% to 38%** | Civil work sits with particular judges and benches. A civil selection must sample across the whole court, not a few judges. |
| Records with a head-note | **4.8%** | The listing rarely says what a case is about. **The area of law has to come from the judgment text**, not the metadata. |
| Records that cite statutes in the listing | **~0.2%** | Same conclusion. |

**For #148:** SHC has about 70,000 judgments in total. At 11% that's roughly **7,700 civil judgments by case type**, before counting the civil share of constitutional petitions. So the PRD's 3–5k civil target looks reachable from SHC alone. The full `shc-meta` pass (#153) will give the exact number. *The 6 judges are not a random sample, so treat 11% as indicative.*

## 3. The proposal: three labels, two of them stored

| Label | Stored in | How it's assigned | Example |
|---|---|---|---|
| **Proceeding type** (+ subtype) | `corpus.documents.proceeding_type` | **Mechanical**, from the court's case type (§4). 100% coverage. | `bail` (subtype: special court) |
| **Area of law** + sub-category | `corpus.documents.area`, `subcategory` | **From the judgment text**: the statutes and sections it cites (§5), with an accuracy check on a reviewed sample (§6). Falls back to `unclassified`. | `offences_against_person` / `homicide` |
| **Branch**: civil or criminal | *not stored* | **Derived.** The proceeding type decides it, except for constitutional petitions, where the area decides it. | `criminal` |

The columns already exist in the database (#15). The vocabulary will live in one versioned file shared by the collector, services/ai, the api and the web (§8), so every part of the system uses the same words.

### 3.1 Areas of law

Each area belongs to exactly one branch. "Seed" means the area is covered by the PRD §15.3 seed statutes, which matters for the test set (§7).

**Criminal**

| Area | Sub-categories | Anchor law | Seed |
|---|---|---|---|
| `offences_against_person` | homicide (qatl), hurt, kidnapping & abduction, sexual offences | PPC ss.299–338-H, 359–374, 375–377-B | ✅ |
| `offences_against_property` | theft, robbery & dacoity, extortion, criminal breach of trust, cheating & fraud, dishonoured cheque (s.489-F), criminal trespass, illegal dispossession | PPC ss.378–462, 489-F; Illegal Dispossession Act 2005 | ✅ (PPC) |
| `documents_and_forgery` | forgery, counterfeiting | PPC ss.463–477-A, 489-A–E | ✅ |
| `public_order_and_state` | unlawful assembly & rioting, offences against public servants, offences against the state | PPC ss.121–229 | ✅ |
| `narcotics` | possession, trafficking | Control of Narcotic Substances Act 1997 (and Sindh 2024 Act) | — |
| `terrorism` | — | Anti-Terrorism Act 1997 | — |
| `arms_and_explosives` | — | Sindh Arms Act 2013, Explosive Substances Act 1908 | — |
| `corruption_and_accountability` | — | National Accountability Ordinance 1999, Prevention of Corruption Act 1947 | — |
| `other_criminal` | — | other special laws | — |

**Civil**

| Area | Sub-categories | Anchor law | Seed |
|---|---|---|---|
| `contract_and_commercial` | specific performance, recovery of money, injunctions, banking recovery | Contract Act 1872, Specific Relief Act 1877, Financial Institutions (Recovery) Ordinance 2001 | ✅ |
| `property_and_land` | title & possession, partition, pre-emption, land revenue | Transfer of Property Act 1882, Specific Relief Act, Sindh land laws | ✅ (partly) |
| `family` | dissolution & khula, maintenance, custody & guardianship, dower | Muslim Family Laws Ordinance 1961, Family Courts Act 1964, Guardians and Wards Act 1890 | — |
| `succession` | letters of administration, inheritance | Succession Act 1925 | — |
| `rent_and_tenancy` | ejectment, fair rent | Sindh Rented Premises Ordinance 1979 | — |
| `service_and_employment` | appointment, promotion, pension, regularisation, labour | Sindh Civil Servants Act 1973, service rules | — |
| `tax_customs_revenue` | income tax, sales tax, customs | Income Tax Ordinance 2001, Sales Tax Act 1990, Customs Act 1969 | — |
| `company_and_insolvency` | winding up, insolvency, admiralty | Companies Act 2017, Insolvency Acts | — |
| `public_and_administrative` | elections, local government, planning & building, education, utilities | Elections Act 2017, local laws | — |
| `torts_and_damages` | damages, malicious prosecution, defamation | general law | — |
| `other_civil` | — | — | — |

**Cross-cutting**: `unclassified` (no confident area yet). It is never forced into a wrong area.

Two kinds of question are about **procedure**, not subject: limitation (Limitation Act 1908) and procedure (CPC, CrPC, Qanun-e-Shahadat). Each is answered with a **proceeding type** and the statute section, so neither needs an area of its own.

### 3.2 Proceeding types

| Proceeding type | Branch | Subtypes seen | Share of sample |
|---|---|---|---|
| `constitutional_petition` (Art. 199) | **either** (from area) | — | 45.39% |
| `bail` (s.497/498 CrPC) | criminal | pre-arrest / post-arrest (from text), special court | 25.10% |
| `criminal_appeal` | criminal | jail appeal, anti-terrorism, accountability, special court | 8.04% |
| `criminal_misc` (incl. quashing, s.561-A / 22-A CrPC) | criminal | original side, special court | 4.89% |
| `criminal_revision` | criminal | — | 2.05% |
| `transfer` | criminal / civil | — | 1.75% / 0.38% |
| `acquittal_appeal` (s.417 CrPC) | criminal | anti-terrorism, accountability | 1.56% |
| `confirmation_reference` (death sentence, s.374 CrPC) | criminal | anti-terrorism | 0.19% |
| `intra_court_appeal` (High Court Appeal) | civil | — | 2.37% |
| `suit` (original side, Order VII CPC) | civil | banking, admiralty | 2.12% |
| `succession_petition` | civil | — | 1.70% |
| `first_appeal` | civil | against order, admiralty | 1.61% |
| `civil_revision` (s.115 CPC) | civil | — | 1.44% |
| `second_appeal` | civil | — | 0.43% |
| `statutory_appeal` (under a special law) | civil | rent, election, family, succession, wealth tax | 0.37% |
| `civil_misc` | civil | — | 0.27% |
| `tax_reference` | civil | income tax, sales tax, customs | 0.21% |
| `execution` | civil | — | 0.09% |
| `company_insolvency` | civil | companies, insolvency | 0.04% |

## 4. SHC case type → proceeding type (all 57 codes)

The mapping is deterministic, and it will be committed as a CSV (`services/collector/selections/matter_type_map.csv`, #153). Codes marked *(confirm)* are our reading of the abbreviation and should be checked against SHC's own case-type list.

| Proceeding type | SHC codes (count in sample) |
|---|---|
| `constitutional_petition` | Const. P (8,183) |
| `bail` | Cr.Bail (4,466), Spl.Cr.Bail (59) |
| `criminal_appeal` | Criminal Appeal (771), Cr.Appeal (104), Spl. Cr. A (21), Spl.Cr.A.T.A (7), Spl.Anti.Ter.A (98), Cr.Acctt.A (62), Cr.J.A (317), Spl.Cr.J.A (16), Spl.Anti.Ter.J.A (54) |
| `acquittal_appeal` | Cr.Acq.A (262), Spl.Anti.T.Acq.A (11), Cr.Acctt..Acq. A (8) |
| `criminal_revision` | Cr.Rev (369) |
| `criminal_misc` | Criminal Miscelleneous (773), Cr.Misc (106), Cr.Org.Misc (1), Spl.Cr.Misc (1) |
| `transfer` | Cr.Tran (316), Civil Tran (69) |
| `confirmation_reference` | Conf.Case (26), Conf.Case (A.T.A) (2), Cr.Ref (7) |
| `suit` | Suit (357), Suit.B (12, banking), Adm. Suit (13, admiralty) |
| `first_appeal` | I. A (276) *(confirm: "First Appeal")*, Civil Appeal (7), First Appeal Against Order (2), Adm.A (5) |
| `second_appeal` | II.A (78) |
| `civil_revision` | R.A (Civil Revision) (193), Civil Revision (66) |
| `intra_court_appeal` | H.C.A (403), Spl.H.C.A (23), Intra Court Appeal (1) |
| `statutory_appeal` | F.R.A (24, rent), Election Appeal (37), Family Appeal (1), Succession Appeal (3), W.T.A (1, wealth tax) |
| `succession_petition` | S.M.A (307) *(confirm: "Succession Miscellaneous Application")* |
| `execution` | Execution (9), E.P (3), Execution First Appeal (4) |
| `tax_reference` | I.T.R.A (8), I.T.R (3), I.T.C (2), Spl. Cus. Ref. A (14), Spl:Sales Tax Ref: A (9), Civil Ref (2) |
| `company_insolvency` | Judicial Companies Misc (5), Insolvency (2) |
| `civil_misc` | M.A (36) *(confirm)*, J.M (12) *(confirm: "Judicial Miscellaneous")* |

A code that isn't in the map is reported by the collector as `unmapped`, never guessed.

## 5. How the area of law is assigned

The listing almost never says what a case is about (§2), so the area comes from the **judgment text** once its PDF is collected. The rules are deterministic, so the same text always gives the same label (this matters for a reproducible report):

1. **Cited statutes and sections** (strongest signal). The collector already extracts citations to laws. Each statute, and for the PPC each section range, maps to an area and sub-category: s.302 PPC → `offences_against_person/homicide`, s.9 CNSA → `narcotics`, s.12(2) CPC → procedure, and so on.
2. **Weighting.** Sections in the operative part and in the offence or relief claimed count more than passing mentions of precedent. The area with the clearest lead wins.
3. **Keywords**, only as a tie-breaker: *khula*, *ejectment*, *pre-emption*, *regularisation*…
4. **Otherwise `unclassified`**, never a guess. The record keeps the evidence: which sections matched, and a confidence score.

Head-note-only records (no judgment file) are classified from the head-note if they have one, and are otherwise `unclassified`.

**Statutes themselves** get an area per Act, and per chapter for the PPC:
- PPC: by chapter, as in §3.1;
- CrPC: criminal procedure;
- Qanun-e-Shahadat: evidence (both branches);
- CPC: civil procedure;
- Contract Act and Specific Relief Act: `contract_and_commercial`;
- Limitation Act: civil procedure.

An LLM classifier is **not** proposed for M1. It would be harder to reproduce and to defend. It can be compared against the rules later (P2) on the same reviewed sample.

## 6. How we know the labels are right

- **Proceeding type:** exact by construction. The test is that every code in the full `shc-meta` pass is mapped.
- **Area of law:** the team hand-labels a **stratified sample of about 200 judgments** (spread over proceeding types and benches). We report precision and recall per area, and the `unclassified` rate, as a table in the final report.
  - **Proposed bar:** at least 85% correct on the sample before area filters are switched on in the product. Below that, the filter stays hidden and the label is used only for corpus statistics.
- **Taxonomy version:** labels carry the taxonomy version (`v1`). Changing the lists means a new version and re-labelling, never a silent edit.

## 7. What it changes

| Work | Change |
|---|---|
| **#153 selection files** | `shc-criminal` = criminal proceeding types; `shc-civil` = civil proceeding types, **sampled across all judges and benches** (civil share ranges 1–38% by judge). Constitutional petitions join a branch once their area is known. |
| **#148** | Answered in principle: about 11% civil by case type in the full listings. The exact count comes from the full `shc-meta` pass. |
| **#22 test set** | Half civil, half criminal. Within each branch, spread across seed areas and proceeding types. Civil questions lean on the seed civil statutes (CPC, Contract, Specific Relief, Limitation) because civil judgments are fewer. Proposed criminal mix: bail, appeals, quashing/revision, plus the PPC/CrPC/QSO statute questions. |
| **#16 loader** | Fills `proceeding_type` from the map. `area` / `subcategory` start as `unclassified` until the classifier lands. |
| **Filters, cases, drafting, linter** | One shared vocabulary file in `packages/contracts` (§8), so the web filters, the case form and the template choice all use the same values. |

## 8. Where the vocabulary lives

- One versioned file, **`packages/contracts/taxonomy/case-taxonomy.v1.yaml`**. It lists the areas (with branch and sub-categories), the proceeding types (with branch) and the statute→area rules.
- `packages/contracts` already holds the API contracts every part of the system reads, so a change is reviewed by every stream (CONTRIBUTING rule 4).
- The SHC code map (§4) is source-specific, so it stays with the collector.

## 9. Decisions for the supervisor

| # | Question | Our recommendation |
|---|---|---|
| 1 | Is **area of law + sub-category** plus **proceeding type**, with civil/criminal derived, the right shape? | Yes. It separates what a case is about from what is being asked, and that is what the filters, test set and linter need. |
| 2 | Do **constitutional petitions** (45% of judgments) count? | Yes, **labelled by their subject**: a writ on FIR quashing is criminal, one on service or land is civil. Leaving them out would drop almost half the court's output. |
| 3 | What about **civil areas outside the seed statutes** (family, rent, service, tax, company)? | Keep and label them in the corpus, but leave them **out of the M1 civil target and the test set**, which focus on contract, property and procedure. |
| 4 | Do **special criminal laws** (narcotics, anti-terrorism, arms, NAB) count as criminal? | Yes. They are a large part of bail practice (bail is 25% of all judgments). |
| 5 | Is the **granularity** right: 9 criminal and 11 civil areas, 19 proceeding types? | Yes for v1. Sub-categories can grow inside an area without changing the shape. |
| 6 | Is **85% accuracy** on a 200-judgment reviewed sample the bar for showing area filters? | Yes, and the team does the review. |
| 7 | Can the supervisor (or SHC's case-type list) confirm the codes marked *(confirm)* in §4? | — |

## 10. Next steps once agreed

1. Commit `case-taxonomy.v1.yaml` (contracts) and `matter_type_map.csv` (collector).
2. Run the full `shc-meta` pass (#153) and publish the exact civil, criminal and constitutional counts.
3. Build the statute→area classifier and run the 200-judgment review.
4. Rebalance the test set (#22) and the selection files against the agreed labels.

---

*How the numbers were produced:* the fixed collector (#147), run as `PKLEGAL_SHC_SCOPE=all python main.py --source shc_caselaw --no-pdfs --max-pages 6` on 2026-11-10. That fetched 19,166 rows from 6 judges' full listings: 18,027 unique judgments after de-duplication. The 57 codes were mapped with the table in §4, and nothing was left unmapped.

-- Five new shared sample knowledge bases for the new industry swarm templates.
-- Pattern matches the existing Q3 Marketing Memo seed (user_id NULL, is_sample = true).

------------------------------------------------------------------------
-- 1. Insurance — Auto Policy & Coverage Manual
------------------------------------------------------------------------
INSERT INTO public.knowledge_bases (id, user_id, name, description, is_sample)
VALUES (
  'b1c10000-0000-4000-8000-000000000001',
  NULL,
  'Sample · Auto Policy & Coverage Manual',
  'Personal auto policy wording, exclusions, deductibles, and SIU fraud red-flag SOP. Used by the Insurance — Auto-Claims FNOL Triage swarm template.',
  true
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, description = EXCLUDED.description, is_sample = true, user_id = NULL;

INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata)
VALUES (
  'b1c10000-0000-4000-8000-0000000000d1',
  'b1c10000-0000-4000-8000-000000000001',
  NULL,
  'Personal_Auto_Policy_AP-2026.md',
  $doc$# Northwind Mutual — Personal Auto Policy AP-2026
## Coverage Summary
- **Collision (Part A):** Pays for damage to the insured vehicle from impact with another vehicle or object. Standard deductible: $500. Optional $250 / $1,000 deductibles available.
- **Comprehensive (Part B):** Covers theft, vandalism, hail, flood, fire, falling objects, and animal strikes. Standard deductible: $250.
- **Liability (Part C):** Bodily injury and property damage to third parties. Statutory minimums apply by state.
- **Uninsured/Underinsured Motorist (Part D):** Optional in most states; mandatory in NY, IL, VA.
- **Rental Reimbursement (Part E):** Up to $40/day, max $1,200 per loss event. Only triggers if the loss is a covered peril under Part A or B.

## Exclusions (apply to all coverages)
1. Intentional damage by the insured or a household member.
2. Use of the vehicle for ride-share or commercial delivery unless **Endorsement RS-22** is on file.
3. Racing or speed contests.
4. War, nuclear hazard, government seizure.
5. Damage occurring while the driver was operating under the influence (BAC > legal limit) — coverage may be denied subject to state law.
6. Mechanical breakdown, wear and tear, freezing.
7. Damage to custom equipment exceeding $1,500 unless scheduled.

## Claim Settlement Rules
- **Total loss threshold:** Repair cost > 75% of ACV → vehicle declared total loss; settle at ACV minus deductible and salvage value.
- **Photo requirement:** A minimum of **4 photos** of the damaged area, **1 wide shot**, and **1 photo of the VIN plate** are required for any collision or comprehensive claim > $1,500.
- **Police report:** Required for theft, hit-and-run, or any collision with bodily injury, OR any claim > $5,000.
- **Prompt notice:** Insured must notify Northwind within 30 days of loss; otherwise claim may be denied for prejudice.

## SIU (Special Investigations Unit) — Fraud Red Flags
Refer the claim to SIU when **two or more** of the following are present:
- **Late reporting** — loss reported > 14 days after incident with no reasonable explanation.
- **Recent policy change** — coverage upgraded or VIN added within 30 days of loss.
- **Prior claims pattern** — 4 or more claims in the trailing 24 months on the same policy or insured.
- **Inconsistent narrative** — driver statement contradicts police report or photo evidence.
- **No independent witness** for a single-vehicle loss > $10,000.
- **Salvage history** — vehicle previously branded salvage, flood, or rebuilt.
- **Repair shop on Northwind watchlist.**
- **Loss occurs out of state immediately after policy issuance.**
- **Photos show pre-existing damage** (rust at impact point, mismatched paint).

## Auto-Approval Authority Matrix
| Adjuster Level | Max Settlement Authority | Requires Manager Sign-off |
|----------------|--------------------------|---------------------------|
| Level 1        | $2,500                   | Yes if SIU red flag       |
| Level 2        | $10,000                  | Yes if SIU red flag       |
| Level 3 / Sup. | $25,000                  | Always for total loss     |
| Manager        | $75,000                  | Director sign-off > $50k  |

Any settlement **> $25,000**, **any SIU referral**, or **any total loss** must be reviewed by a human manager before payout — no exceptions.
$doc$,
  true,
  jsonb_build_object('source','sample','doc_type','policy_manual')
)
ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, name = EXCLUDED.name, is_sample = true, user_id = NULL, metadata = EXCLUDED.metadata;

------------------------------------------------------------------------
-- 2. Manufacturing — Quality SOPs & Engineering Specs
------------------------------------------------------------------------
INSERT INTO public.knowledge_bases (id, user_id, name, description, is_sample)
VALUES (
  'b1c10000-0000-4000-8000-000000000002',
  NULL,
  'Sample · Manufacturing Quality SOPs & Engineering Specs',
  'EV assembly-line quality SOPs, torque specs, weld acceptance criteria, and CAPA procedure. Used by the Manufacturing — Quality Non-Conformance RCA swarm template.',
  true
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, description = EXCLUDED.description, is_sample = true, user_id = NULL;

INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata)
VALUES (
  'b1c10000-0000-4000-8000-0000000000d2',
  'b1c10000-0000-4000-8000-000000000002',
  NULL,
  'Plant_QMS_Manual_Rev7.md',
  $doc$# Plant QMS Manual — Rev 7 (Plant 04, MX Vehicle Family)

## 1. Weld Acceptance Criteria (Body-in-White)
- **Spot welds:** Nugget diameter ≥ 4√t mm, minimum 5.0 mm for 1.2 mm steel.
- **Visible porosity:** Disqualifying if any pore > 0.5 mm OR cumulative pore area > 5% of weld length.
- **Defect code WELD-PORE** is triggered when any of the above is detected by the inline X-ray station (QC-Final).
- **Common root cause (Top 3 historically):** (1) Robot tip wear at >40,000 cycles, (2) shielding-gas flow drift, (3) operator failed to dress electrode after tip change.

## 2. Torque Specs — Battery Pack Module Bolts
- Spec: **48 N·m ± 4 N·m**, four-step tightening pattern.
- **Defect code TORQUE-LOW** is logged when the smart-torque-gun audit reads < 44 N·m on any of the 16 module bolts.
- Mandatory containment: hold the **entire shift's** battery packs until torque audit on the failing tool is re-validated.

## 3. Paint Booth — Defect PAINT-RUN
- Acceptable paint film build: 90–110 µm.
- PAINT-RUN: visible vertical sag > 25 mm length OR film build > 130 µm.
- Top correlated factors: humidity > 65% RH, nozzle clog at gun #3, paint viscosity drift > 5%.

## 4. Stamping Die — Defect GAP-OOS (out of spec)
- Specification: panel gap ≤ 3.5 mm at A-pillar.
- Die wear program: dies inspected every **80,000 strokes**; replace at 120,000 or earlier on visible chipping.
- Most common cause: die wear past replacement interval.

## 5. CAPA (Corrective and Preventive Action) Procedure
A CAPA is mandatory whenever:
- Defect PPM **> 1,500** for the same defect_code in any 7-day window, OR
- Severity = **Critical** (any single occurrence), OR
- Defect repeats on the same line + station within 14 days.

CAPA workflow:
1. **Containment** (within 24h) — quarantine affected serials.
2. **Root-cause analysis** using 5-Why + Fishbone — owner: Plant Quality Engineer.
3. **Corrective action** — implement, validate over 1 production week.
4. **Effectiveness check** at +30 days and +90 days.
5. **Plant-Manager sign-off required to close.**

## 6. Plant-Manager Approval Gate
Plant Manager must approve any CAPA whose corrective action involves:
- Line shutdown > 2 hours
- Re-work > 50 vehicles
- Supplier change
- Spend > $25,000
$doc$,
  true,
  jsonb_build_object('source','sample','doc_type','sop_manual')
)
ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, name = EXCLUDED.name, is_sample = true, user_id = NULL, metadata = EXCLUDED.metadata;

------------------------------------------------------------------------
-- 3. Cybersecurity — SOC Runbooks & MITRE ATT&CK Playbooks
------------------------------------------------------------------------
INSERT INTO public.knowledge_bases (id, user_id, name, description, is_sample)
VALUES (
  'b1c10000-0000-4000-8000-000000000003',
  NULL,
  'Sample · SOC Runbooks & MITRE ATT&CK Playbooks',
  'Tier-1/2 SOC playbooks mapped to MITRE ATT&CK techniques covering phishing, brute force, ransomware, lateral movement, and credential access. Used by the Cybersecurity — SOC Alert Triage swarm template.',
  true
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, description = EXCLUDED.description, is_sample = true, user_id = NULL;

INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata)
VALUES (
  'b1c10000-0000-4000-8000-0000000000d3',
  'b1c10000-0000-4000-8000-000000000003',
  NULL,
  'SOC_Playbooks_v3.md',
  $doc$# Northwind SecOps — SOC Playbooks v3 (MITRE ATT&CK aligned)

## Severity Matrix
| MITRE Technique | Default Severity | Auto-Escalate If… |
|-----------------|------------------|-------------------|
| T1110 Brute Force | P3 | > 100 failed logins from one src OR success after burst |
| T1078 Valid Accounts | P2 | Login geo-impossible OR new ASN for privileged user |
| T1059.001 PowerShell | P2 | Encoded command (-enc) OR DownloadString |
| T1190 Exploit Public App | P1 | CVSS ≥ 9.0 OR egress to known C2 |
| T1486 Data Encrypted (Ransomware) | P1 | ALWAYS — page IR on-call immediately |
| T1566.001 Spearphish Attachment | P2 | Clicked link OR macro executed |
| T1041 Exfil over C2 | P1 | > 50 MB egress to non-corp ASN |
| T1003 OS Credential Dumping | P1 | LSASS access by unsigned process |
| T1027 Obfuscated Files | P2 | Entropy > 7.5 in PE section |
| T1021.001 RDP | P2 | Inbound from public IP OR new src for the user |

Asset criticality multiplier: **CRITICAL** assets bump severity by one level (P3→P2, P2→P1).

## Playbook — T1110 Brute Force
1. Pull last 24h auth events for `src_ip` from SIEM.
2. If success-after-failures: disable account, force password reset, expire all sessions.
3. Block src_ip at perimeter for 24h.
4. Open ServiceNow ticket with template `IR-BRUTE-V2`.

## Playbook — T1486 Ransomware
1. **Isolate host** within 5 minutes via EDR network containment.
2. Page IR on-call (PagerDuty service `secops-ir`).
3. Snapshot affected volumes; do NOT power off.
4. Pull DNS + EDR telemetry for last 7 days.
5. Notify Legal + Comms within 1 hour (regulatory clock starts).

## Playbook — T1566 Spearphishing
1. Sweep mailbox for the same sender/subject/hash; quarantine all matches.
2. Block sender domain at email gateway.
3. If link clicked: pull EDR child-process tree from clicker's host.
4. If credential entered on phishing site: force password reset + revoke MFA tokens + sessions.

## Auto-Close Conditions (Benign)
Close as **BENIGN** without analyst review only if ALL of:
- severity ≤ P3
- asset_criticality ≤ MED
- known false-positive signature in suppression list
- no historical incident on src_ip in 90 days

## Analyst Approval Gate
Any **P1**, any **CRITICAL** asset, or any action that **disables a user account** or **isolates a host** requires SOC Lead approval before execution.
$doc$,
  true,
  jsonb_build_object('source','sample','doc_type','soc_runbook')
)
ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, name = EXCLUDED.name, is_sample = true, user_id = NULL, metadata = EXCLUDED.metadata;

------------------------------------------------------------------------
-- 4. Education — K-12 Math Curriculum & Common Misconceptions
------------------------------------------------------------------------
INSERT INTO public.knowledge_bases (id, user_id, name, description, is_sample)
VALUES (
  'b1c10000-0000-4000-8000-000000000004',
  NULL,
  'Sample · K-12 Math Curriculum & Common Misconceptions',
  'Common-Core-aligned middle-school algebra standards, worked examples, and a catalog of common student misconceptions. Used by the Education — Adaptive Socratic Tutor swarm template.',
  true
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, description = EXCLUDED.description, is_sample = true, user_id = NULL;

INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata)
VALUES (
  'b1c10000-0000-4000-8000-0000000000d4',
  'b1c10000-0000-4000-8000-000000000004',
  NULL,
  'Middle_School_Algebra_Curriculum.md',
  $doc$# Middle-School Algebra — Curriculum & Misconception Atlas (Grades 6–8)

## Standard 6.EE.B.7 — Solve One-Step Linear Equations
**Worked example:** Solve `x + 7 = 12`. Subtract 7 from both sides → `x = 5`.

**Common misconceptions:**
- *Performing the same operation as the sign:* student writes `x = 12 + 7 = 19`. Hint: ask "what operation undoes addition?"
- *Forgets to apply to both sides:* `x + 7 = 12` → `x = 12`. Hint: invoke the balance-scale metaphor.

## Standard 7.EE.B.4 — Two-Step Equations
**Worked example:** Solve `3x − 4 = 11`. Add 4 → `3x = 15`. Divide by 3 → `x = 5`.

**Common misconceptions:**
- *Order of inverse operations reversed:* student divides first: `3x − 4 = 11` → `x − 4/3 = 11/3`. Almost always leads to fractions and frustration. Hint: "undo addition/subtraction before multiplication/division."
- *Sign error on negative coefficient:* `−2x + 6 = 10` → `−2x = 16` → `x = 8`. Hint: probe with "what does dividing by a negative do to the sign?"

## Standard 8.EE.C.7 — Linear Equations w/ Variables on Both Sides
**Worked example:** Solve `5x + 3 = 2x + 18`. Subtract `2x` → `3x + 3 = 18`. Subtract 3 → `3x = 15`. Divide → `x = 5`.

**Common misconceptions:**
- *Combining unlike terms:* student writes `5x + 3 + 2x + 18 = 0`. Hint: "are the variable terms on the same side yet?"
- *Distributive-property errors:* `2(x + 5) = 2x + 5`. Always probe with "did you multiply BOTH terms inside?"

## Standard 8.F.A.3 — Slope-Intercept Form
**Worked example:** Identify slope and y-intercept of `y = 4x − 7`. Slope = 4. y-intercept = −7.

**Common misconceptions:**
- *Confusing slope and y-intercept:* student answers slope = −7. Hint: "which letter sits beside x in `y = mx + b`?"
- *Sign-of-intercept errors* on `y = 3x + (−2)` vs `y = 3x − 2`.

## Socratic Tutoring Rules (NEVER violate)
1. **Never reveal the final numeric answer** before the student attempts at least one inverse operation.
2. **Always reflect the misconception** back as a question, not a correction.
3. **Use the misconception atlas** above to choose the right hint for the diagnosed error.
4. **End every turn with a single concrete next step** the student can take.
5. **Praise effort and reasoning, not correctness.**

## Auto-Grader Rubric (out of 4)
- 4 = correct answer + correct work shown
- 3 = correct answer, missing/incorrect work
- 2 = wrong answer, work demonstrates correct method
- 1 = wrong answer + procedural error
- 0 = blank or off-topic
$doc$,
  true,
  jsonb_build_object('source','sample','doc_type','curriculum')
)
ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, name = EXCLUDED.name, is_sample = true, user_id = NULL, metadata = EXCLUDED.metadata;

------------------------------------------------------------------------
-- 5. Retail — Returns Policy & Reverse-Logistics Playbook
------------------------------------------------------------------------
INSERT INTO public.knowledge_bases (id, user_id, name, description, is_sample)
VALUES (
  'b1c10000-0000-4000-8000-000000000005',
  NULL,
  'Sample · Retail Returns Policy & Reverse-Logistics Playbook',
  'E-commerce returns eligibility window, condition grading, refund vs replace vs resell vs recycle disposition rules, and abuse-detection thresholds. Used by the Retail — Returns & Reverse-Logistics swarm template.',
  true
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, description = EXCLUDED.description, is_sample = true, user_id = NULL;

INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata)
VALUES (
  'b1c10000-0000-4000-8000-0000000000d5',
  'b1c10000-0000-4000-8000-000000000005',
  NULL,
  'Returns_Policy_2026.md',
  $doc$# Acme Marketplace — Returns Policy & Reverse-Logistics Playbook (2026)

## Eligibility Window
- **Standard items:** 30 days from delivery.
- **Apparel & footwear:** 60 days, must be unworn with tags.
- **Electronics:** 30 days, must include all packaging and accessories.
- **Final sale / clearance:** non-returnable.
- **Hazmat / batteries (SKU-BTY-*):** must use prepaid hazmat label, refund only after warehouse inspection.

## Condition Grading
- **New-Sealed:** unopened original packaging → resell as new.
- **Open-Box:** opened, complete, no functional defects → resell as Open-Box at 85% MSRP.
- **Used-Like-New:** light handling, complete → resell as refurbished at 65% MSRP.
- **Used-Worn:** visible wear, functional → recycle/donate (no resell).
- **Damaged:** non-functional → recycle and file supplier defect claim if applicable.

## Disposition Decision Matrix
| Reason | Condition | Decision |
|--------|-----------|----------|
| Wrong size / Changed mind | New-Sealed or Open-Box | **Refund-Full** + Resell |
| Defective / Wrong item shipped | any | **Replace** (priority ship) + Resell-or-Recycle by condition |
| Damaged in transit | any | **Refund-Full** + claim against carrier |
| Late delivery | any | **Refund-Partial** (15% goodwill credit) |
| Better price elsewhere | New-Sealed | **Refund-Full** if within 14 days of order |
| Not as described | any | **Refund-Full** + flag listing for review |

## Return-Abuse Thresholds (Trust & Safety)
- More than **8 returns in trailing 12 months** → require manager approval before refund.
- Return rate (returned $ / ordered $) > **40%** in trailing 12 months → flag account for review; deny serial-returner refunds for "Changed mind" reason.
- Customer LTV < $100 AND return value > $250 → manager approval required.
- Same SKU returned more than 2 times by same customer → automatic deny + customer service follow-up.

## Manager Approval Gate
A human manager must approve any return where:
- Item price > **$500**, OR
- Customer LTV > **$5,000** (white-glove handling, never auto-deny), OR
- The return-abuse thresholds above are tripped, OR
- Disposition is **Deny**.
$doc$,
  true,
  jsonb_build_object('source','sample','doc_type','returns_policy')
)
ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, name = EXCLUDED.name, is_sample = true, user_id = NULL, metadata = EXCLUDED.metadata;

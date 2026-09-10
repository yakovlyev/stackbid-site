# Product Marketing Context — StackBid

*Last updated: 2026-09-09 (auto-drafted by Claude from known project facts — needs Igor's review/correction per sections marked TBD)*

## Product Overview
**One-liner:** AI construction materials + labor cost estimator for US homeowners.
**What it does:** Homeowners describe a renovation/construction project (text, photo, or PDF); StackBid returns three price columns (Home Depot retail / wholesale / local supplier by ZIP) plus an honest labor-cost range (BLS wage data × StackBid's own hours estimate) and a total project cost — before they ever talk to a contractor.
**Product category:** Home-improvement cost estimation / construction-tech SaaS.
**Product type:** SaaS, two-sided (homeowners + contractors).
**Business model:** Free first estimate with email capture, then $9.99/mo Homeowner Pro. Separate contractor tiers: Handyman $29/mo, Contractor Pro $49/mo — lead-matching, one lead per contractor at a flat fee (never shared/sold to multiple contractors).

## Target Audience
**Homeowner side:**
- People actively planning a renovation/repair project, before they've called any contractor
- Primary use case: "know roughly what this should cost before someone quotes me a number I can't sanity-check"
- Jobs to be done: avoid being overcharged; decide DIY vs. hire-a-pro; budget-plan a project

**Contractor side:**
- Independent contractors and handymen seeking qualified local leads without paying for shared/resold leads
- Primary use case: get leads that no competitor is also bidding on

**Personas:** TBD — not yet formally captured (no verbatim customer interviews on file).

## Problems & Pain Points
**Core problem (homeowner):** No easy way to sanity-check a contractor's quote before agreeing to it — asymmetric information favors whoever's selling the work.
**Why alternatives fall short:** General contractor-marketplace sites (Angi/HomeAdvisor-style) sell the SAME lead to multiple contractors, so homeowners get bombarded with competing calls and contractors overpay for lead quality that isn't exclusive.
**Emotional tension:** Fear of being overcharged; distrust of quotes with no independent reference point.

## Competitive Landscape
**Direct:** Angi, HomeAdvisor, Thumbtack — TBD depth (not yet formally compared feature-by-feature in this file).
**How they fall short:** Sell the same lead to multiple contractors; don't provide an independent cost estimate before contact.

## Differentiation
**Key differentiators:**
- Three-column honest price comparison (not one falsely-precise number)
- Labor-cost transparency: explicitly separates real BLS wage data from StackBid's own hours estimate (never claims a federal number for the whole labor figure)
- One lead → one contractor, flat fee — never resold/shared
- Bilingual EN/ES throughout (site, Nika chat, WhatsApp bot)
- AI chat (Nika) + WhatsApp bot with real conversation memory, not just a form

## Objections & Anti-Personas
TBD — not yet collected from real sales conversations (StackBid has zero real paying contractors as of 08.09 per the live DB audit — too early for this section to be meaningful yet).

## Switching Dynamics (JTBD Four Forces)
TBD — needs real customer conversations to fill in accurately; drafting this from assumption would risk the same fabrication problem already flagged and fixed once before on this project (17.07 testimonial incident) — better left blank than invented.

## Customer Language
TBD — no verbatim customer quotes on file yet. Fill in from real signups/support conversations once volume exists.

## Brand Voice
**Tone:** Direct, honest, non-hyped — explicitly avoids inflated claims (standing rule: no "lowest price guaranteed," no fabricated stats/testimonials).
**Style:** Plain language over industry jargon where possible; Nika/WhatsApp bot tone is helpful and matter-of-fact, not salesy.

## Proof Points
TBD — no real customer metrics/testimonials exist yet (confirmed 08.09: zero paying contractors, essentially pre-launch traction-wise).

## Goals
**Primary business goal:** Get to a first cohort of real paying contractors + Homeowner Pro subscribers.
**Key conversion action:** Free estimate → email capture → Homeowner Pro upgrade (homeowner side); contractor signup → completed Stripe checkout (contractor side).
**Current metrics:** Essentially pre-launch — 129 contractor rows in the DB are an imported/scraped directory for homeowner-matching, not real signups; zero real subscriptions confirmed live 08.09.

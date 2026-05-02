# Marketing target import

The marketing agent must not create fake playlist, curator, or influencer records.

`MARKETING_RESEARCH_SOURCE_PATH` must point to a real JSON file created by OpenClaw, Firecrawl, manual research, or another verified research step.

## Accepted shape

The file can be either:

```json
[
  {
    "name": "Required target name",
    "type": "playlist | influencer | blog | radio | community",
    "source_url": "Required URL proving where this target came from",
    "platform": "Optional platform name",
    "submission_url": "Optional submission or contact URL",
    "contact_method": "Optional contact method",
    "audience": "Optional audience summary",
    "fit_score": 1,
    "ai_policy": "allowed | disclosure_required | individual_curator_choice | unclear | likely_hostile | banned",
    "ai_risk_score": 1,
    "recommendation": "submit | submit_with_disclosure | manual_review | avoid",
    "research_summary": "Optional sourced rationale",
    "notes": "Optional notes"
  }
]
```

or:

```json
{
  "targets": []
}
```

## Required fields

- `name`
- `type`
- `source_url`

Rows missing any of these fields are skipped and logged.

## Guardrails

- No unsourced targets
- No guaranteed-stream vendors
- No guaranteed paid playlist-placement vendors
- No AI-hostile targets
- No outreach before Ken approval
- Gmail/OpenClaw must run dry-run before auto-send

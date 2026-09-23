import { CatalogUiPolicy } from '@servicenow/sdk/core'

// Managed by NowForge. Generated from the policy builder — edit it there.
// nowforge-policy: cuip-8b3ae7fe-require-justification-when-duration-is-permanent
CatalogUiPolicy({
    $id: Now.ID["cuip_8b3ae7fe_require_justification_when_duration_is_permanent"],
    shortDescription: "Require justification when duration is Permanent",
    catalogItem: "8b3ae7fedc1be1004ece5c08239e522b",
    appliesTo: 'item',
    catalogCondition: "IO:397db91983facf10b939cc65eeaad389=permanent^EQ",
    active: true,
    onLoad: true,
    reverseIfFalse: true,
    // 'all' is ui_type 10 — the SDK's own default, and unambiguous across every
    // rendering surface. Not a workaround: a policy at ui_type 0 was measured
    // working on the Service Portal too (see the note at the top of this file).
    runScriptsInUiType: 'all',
    order: 100,
    actions: [
        {
            variableName: "ae7df91983facf10b939cc65eeaad338",
            variable: "justification",
            mandatory: true,
            order: 100,
        },
    ],
})

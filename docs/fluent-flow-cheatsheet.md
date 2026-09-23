# Fluent Flow Cheatsheet

Dense syntax reference for authoring ServiceNow Flow Designer flows as TypeScript with the
Fluent SDK (`@servicenow/sdk` v4.x). **This file is embedded verbatim into NowHelpAssist's codegen
prompt** — it is written to be read by a model with no ability to fetch docs.

Every example here compiles under `now-sdk build` (SDK 4.10.1).

---

## 0. Non-negotiable rules

1. Output **one file**, valid TypeScript, ending in `.now.ts`, placed in `src/fluent/flows/`.
2. Every `$id` is `Now.ID['snake_case_key']`. **Never invent a sys_id.** Every key must be
   **unique across the whole project and freshly minted** — see the HARD RULE below.
3. **Never assign a data pill to a variable.** `wfa.dataPill(...)` is written inline inside an
   action parameter. Capturing an *action's return value* in a `const` is required and correct:
   `const g = wfa.action(...)` ✅ / `const p = wfa.dataPill(...)` ❌
4. `TemplateValue`, `Time`, `Duration`, `Now.ID` are **globals**. Importing them is an error.
5. Conditions are **encoded queries in template literals**:
   `` condition: `${wfa.dataPill(x, 'string')}=1` ``. No JavaScript, no `==`, no `&&`.
6. Template literals interpolate in **`ah_subject` and `log_message` only**. Never in
   `ah_body`, SMS `message`, or inside `TemplateValue({...})` — use a bare data pill there.
7. Exactly **one trigger per flow**; subflows have **no trigger**.
8. Prefer resolving records by name in an encoded query (`assignment_group.name=Network`) or
   via `lookUpRecord` over hardcoding sys_ids.
9. **`noUnusedParameters` is enforced** (`TS6133`). If the body never reads `params` — which is
   always the case for scheduled triggers — declare the callback as `() => {`, not
   `(params) => {`, or the build fails.

### HARD RULE — `$id` keys are a project-wide namespace ⚠️

`keys.ts` is a **flat map for the entire application**, not a per-file one:

```typescript
add_work_note: { table: 'sys_hub_action_instance_v2', id: '10c0ec9dcf0c486ab1e40f73c0edbe8d' }
```

One key = **one live record**. A second flow that writes `Now.ID['add_work_note']` does not get
a new action — it resolves to *that same sys_id*, and the build aborts:

```
Record sys_hub_action_instance_v2.10c0ec9dcf0c486ab1e40f73c0edbe8d is defined 2 times in the project
```

So:

- **Every element `$id` must be unique and freshly minted for the flow you are writing.**
- **Never reuse a key** from the examples in this file, from another flow's source, or from any
  source you were shown as context. Every key in every example below is a **live key already
  taken** by a deployed record.
- **Mint format** — prefix every key in a flow with a short slug of that flow's own name, then a
  descriptive suffix:

  ```typescript
  // Flow "Vendor Hold Problem"  → prefix vhp_
  $id: Now.ID['vhp_trigger']            // the trigger
  $id: Now.ID['vhp_create_problem']     // an action
  $id: Now.ID['vhp_if_critical']        // a flow-logic block
  $id: Now.ID['vhp_else_standard']
  ```

  The prefix is what makes the key unique; the suffix is what makes it readable. Bare keys like
  `log`, `note`, `set`, `add_work_note` or `if_priority_critical` are the ones that collide.

- **Do not use randomness or timestamps to force uniqueness.** `Now.ID` stability is the whole
  idempotency mechanism: the same spec redeployed must resolve to the same sys_ids and update
  its records in place. A key that changes per run creates duplicates on every deploy.
- If you are given a source containing `Now.ID['__ID_1__']` placeholders, those are **existing
  records' identities**. Keep each one exactly where it is. Never invent a new `__ID_n__`; a
  genuinely new element gets a freshly minted descriptive key instead.

---

## 1. Imports

```typescript
import { Flow, Subflow, wfa, action, trigger } from '@servicenow/sdk/automation'
import { StringColumn, BooleanColumn, IntegerColumn, ReferenceColumn } from '@servicenow/sdk/core'
```

Import a subflow to call it: `import { notifyManager } from './notify-manager.now'`
(no file extension beyond `.now`).

---

## 2. Flow skeleton

```typescript
Flow(
  config,      // metadata
  trigger,     // exactly one wfa.trigger(...)
  (params) => { /* body */ }
)
```

### Config properties

| Property | Type | Notes |
|---|---|---|
| `$id` | `Now.ID[...]` | required |
| `name` | string | required, display name |
| `description` | string | optional |
| `runAs` | `'system' \| 'user'` | default `'user'`; use `'system'` for automation |
| `runWithRoles` | `(string \| Role)[]` | least-privilege alternative to `runAs: 'system'` |
| `flowPriority` | `'LOW' \| 'MEDIUM' \| 'HIGH'` | default `MEDIUM` |
| `flowVariables` | `Record<string, Column>` | used with `setFlowVariables` |
| `internalName` | string | only when a rename diverged from the display name |

---

## 3. Triggers

```typescript
wfa.trigger(triggerType, { $id: Now.ID['t'] }, { /* type-specific params */ })
```

### Record triggers — `trigger.record.created | updated | createdOrUpdated`

| Param | Values |
|---|---|
| `table` | **required**, e.g. `'incident'` |
| `condition` | encoded query, e.g. `'priority=1^assignment_group.name=Network'` |
| `run_flow_in` | `'any' \| 'background' \| 'foreground'` — **use `'background'`** |
| `run_on_extended` | `'true' \| 'false'` — run on child tables |
| `trigger_strategy` | *(updated / createdOrUpdated only)* `'once' \| 'unique_changes' \| 'every' \| 'always'` — **always set it explicitly**, see below |

#### ⚠️ `trigger_strategy` defaults to `'once'`, and `'once'` means once EVER

Omitting `trigger_strategy` is **not** neutral. The platform default is `'once'`, and this was
measured on a live flow: an incident was driven into the trigger condition (fired), moved out of
it, then moved back in — and the flow **did not run again**. One execution, one record created,
for the whole lifetime of that incident.

| value | label | fires |
|---|---|---|
| `'once'` | Once | **once ever per record** — never again, even after leaving and re-entering the condition |
| `'unique_changes'` | For each unique change | once per distinct transition into the condition |
| `'always'` | Only if not currently running | on any matching update, unless an execution is in flight |
| `'every'` | For every update | on every matching update — creates duplicates if the flow creates records |

A spec phrased *"when a record is **updated to** X"* means a **transition**, so it wants
`'unique_changes'`. `'once'` silently narrows that to "the first time this record ever hit X",
and `'every'` widens it to "every save while X is true" — which for a flow that creates a record
means a new record on every save. Choose deliberately and write it down; do not let the default
choose for you.

Outputs: `params.trigger.current`, `params.trigger.changed_fields` (updates only),
`params.trigger.table_name`, `params.trigger.run_start_date_time`.

```typescript
wfa.trigger(
  trigger.record.created,
  { $id: Now.ID['inc_created'] },
  { table: 'incident', condition: 'priority=1', run_flow_in: 'background' }
)
```

### Scheduled triggers — `trigger.scheduled.*`

`Time` and `Duration` are globals.

```typescript
// daily at 07:00 India time
wfa.trigger(trigger.scheduled.daily, { $id: Now.ID['t'] },
  { time: Time({ hours: 7, minutes: 0, seconds: 0 }, 'Asia/Kolkata') })

// weekly — day_of_week: 1=Mon … 7=Sun
wfa.trigger(trigger.scheduled.weekly, { $id: Now.ID['t'] },
  { day_of_week: 1, time: Time({ hours: 9, minutes: 0, seconds: 0 }, 'UTC') })

// monthly — day_of_month 1..31 (clamps to last day of short months)
wfa.trigger(trigger.scheduled.monthly, { $id: Now.ID['t'] },
  { day_of_month: 1, time: Time({ hours: 0, minutes: 0, seconds: 0 }, 'UTC') })

// every 15 minutes (first run fires immediately on activation)
wfa.trigger(trigger.scheduled.repeat, { $id: Now.ID['t'] },
  { repeat: Duration({ minutes: 15 }) })

// once, then the flow deactivates itself
wfa.trigger(trigger.scheduled.runOnce, { $id: Now.ID['t'] },
  { run_in: '2026-09-01 14:30:00' })
```

Scheduled triggers expose **no `current` record** — only `run_start_date_time`. Query for the
records you need with `lookUpRecords`.

### Application triggers

`trigger.application.serviceCatalog` → `params.trigger.request_item` ·
`trigger.application.inboundEmail` → `params.trigger.subject` / `.body_text`
(type `'string_full_utf8'`, and use `LIKE`, not `CONTAINS`) ·
`trigger.application.slaTask` · `.knowledgeManagement` · `.remoteTableQuery`.

---

## 4. Data pills

```typescript
wfa.dataPill(expression, type)
```

| Source | Example |
|---|---|
| trigger record | `wfa.dataPill(params.trigger.current, 'reference')` |
| trigger field | `wfa.dataPill(params.trigger.current.priority, 'string')` |
| dot-walk (multi-level ok) | `wfa.dataPill(params.trigger.current.assignment_group.manager.email, 'string')` |
| action output | `wfa.dataPill(lookup.Record, 'reference')` |
| subflow output | `wfa.dataPill(result.isValid, 'boolean')` |
| subflow/action input | `wfa.dataPill(params.inputs.message, 'string')` |

**Common types:** `'string'`, `'integer'`, `'boolean'`, `'reference'`, `'choice'`,
`'records'` (record sets for `forEach`), `'glide_date_time'`, `'journal_input'`,
`'string_full_utf8'` (email subject/body), `'document_id'`, `'table_name'`.

Pass `params.trigger.current` as `'reference'` for the whole record; use
`params.trigger.current.sys_id` only when a parameter genuinely wants the id string.

---

## 5. Actions

```typescript
const result = wfa.action(action.core.<name>, { $id: Now.ID['step'], annotation: '...' }, { /* params */ })
```

### ⚠️ Output casing — the most common mistake

| Action | Output fields |
|---|---|
| `lookUpRecord` | **`Record`**, **`Table`**, `status`, `error_message` |
| `lookUpRecords` | **`Records`**, **`Count`**, **`Table`** |
| `createRecord` / `updateRecord` | `record` (lowercase), `table_name` |
| `createTask` | **`Record`**, **`Table`** |
| `askForApproval` | `approval_state` |
| `sendEmail` | `email` |

### ⚠️ Parameter naming differs per action

| Action | Table param | Values param |
|---|---|---|
| `createRecord` | `table_name` | `values: TemplateValue({...})` |
| `updateRecord` | `table_name` + `record` | `values: TemplateValue({...})` |
| `updateMultipleRecords` | `table_name` + `conditions` | `field_values: TemplateValue({...})` |
| `createOrUpdateRecord` | `table_name` | `fields: TemplateValue({...})` |
| `createTask` | `task_table` | `field_values: TemplateValue({...})` |
| `lookUpRecord` / `lookUpRecords` | **`table`** | `conditions` (encoded query string) |

### Frequently used actions

```typescript
// Look up ONE record
const g = wfa.action(action.core.lookUpRecord, { $id: Now.ID['find_group'] }, {
  table: 'sys_user_group',
  conditions: `sys_id=${wfa.dataPill(params.trigger.current.assignment_group, 'string')}`,
})

// Look up MANY
const list = wfa.action(action.core.lookUpRecords, { $id: Now.ID['find_p1'] }, {
  table: 'incident',
  conditions: 'active=true^priority=1^assigned_toISEMPTY',
  max_results: 50,
  sort_column: 'sys_created_on',
  sort_type: 'sort_desc',
})

// Update a record
wfa.action(action.core.updateRecord, { $id: Now.ID['note'] }, {
  table_name: 'incident',
  record: wfa.dataPill(params.trigger.current, 'reference'),
  values: TemplateValue({ work_notes: 'Escalated automatically.' }),  // no template literals here
})

// Create a record
wfa.action(action.core.createRecord, { $id: Now.ID['make'] }, {
  table_name: 'incident',
  values: TemplateValue({ short_description: 'Auto-created', priority: '1' }),
})

// Email — ah_subject takes data pills, ah_body does NOT
wfa.action(action.core.sendEmail, { $id: Now.ID['mail'] }, {
  ah_to: `${wfa.dataPill(g.Record.manager.email, 'string')}`,
  ah_subject: `P1 escalation - ${wfa.dataPill(params.trigger.current.number, 'string')}`,
  ah_body: 'A P1 incident requires your attention. Open the linked record for details.',
  record: wfa.dataPill(params.trigger.current, 'reference'),
  table_name: 'incident',
})

// Notification record (sysevent_email_action)
wfa.action(action.core.sendNotification, { $id: Now.ID['notify'] }, {
  notification: '<notification sys_id or name>',
  record: wfa.dataPill(params.trigger.current, 'reference'),
  table_name: 'incident',
})

// Log (max 255 chars)
wfa.action(action.core.log, { $id: Now.ID['log'] }, {
  log_level: 'info',
  log_message: `Handled ${wfa.dataPill(params.trigger.current.number, 'string')}`,
})
```

Full catalogue: `createRecord`, `updateRecord`, `deleteRecord`, `lookUpRecord`,
`lookUpRecords`, `updateMultipleRecords`, `createOrUpdateRecord`, `sendEmail`,
`sendNotification`, `sendSms`, `log`, `fireEvent`, `waitForCondition`, `askForApproval`,
`createTask`, `createCatalogTask`, `getCatalogVariables`, `submitCatalogItemRequest`,
attachment actions. **There is no `deleteMultipleRecords`** — use `lookUpRecords` + `forEach`
+ `deleteRecord`.

---

## 6. Flow logic

`if` / `elseIf` / `else` are **sibling top-level calls**, not nested. `else` follows `if`.

```typescript
wfa.flowLogic.if(
  { $id: Now.ID['is_p1'], label: 'Priority is 1',
    condition: `${wfa.dataPill(params.trigger.current.priority, 'string')}=1` },
  () => { /* ... */ }
)
wfa.flowLogic.elseIf(
  { $id: Now.ID['is_p2'],
    condition: `${wfa.dataPill(params.trigger.current.priority, 'string')}=2` },
  () => { /* ... */ }
)
wfa.flowLogic.else({ $id: Now.ID['otherwise'] }, () => { /* ... */ })
```

```typescript
// Loop over a record set
wfa.flowLogic.forEach(
  wfa.dataPill(list.Records, 'records'),
  { $id: Now.ID['each'] },
  (item) => {
    wfa.flowLogic.skipIteration({ $id: Now.ID['skip'] })   // continue
    wfa.flowLogic.exitLoop({ $id: Now.ID['stop'] })        // break
  }
)

wfa.flowLogic.endFlow({ $id: Now.ID['done'] })

wfa.flowLogic.tryCatch({ $id: Now.ID['guard'] }, {
  try: () => { /* ... */ },
  catch: () => { /* ... */ },
})

wfa.flowLogic.doInParallel({ $id: Now.ID['par'] },
  () => { /* branch A */ },
  () => { /* branch B */ },
)

wfa.flowLogic.setFlowVariables({ $id: Now.ID['set'] }, params.flowVariables, { counter: 1 })
```

⚠️ Data pills captured **inside** `tryCatch` or `doInParallel` are not visible outside the
block — persist them to a flow variable first. `doInParallel` cannot nest.

### Encoded-query operators

`=` `!=` `<` `<=` `>` `>=` · `ISEMPTY` `ISNOTEMPTY` · `IN` `NOT IN` ·
`STARTSWITH` `ENDSWITH` `LIKE` · `^` (AND) `^OR` `^NQ`

```
priority=1^assignment_group.name=Network
active=true^assigned_toISEMPTY
stateIN1,2,3
```

---

## 7. Subflows

```typescript
export const mySubflow = Subflow(config, (params) => { /* body */ })
```

- Declare `inputs` / `outputs` with column types.
- **`assignSubflowOutputs` is the only way to return values**, and must be called on
  *every reachable path*; always pass `params.outputs` as the 2nd argument.
- Always `export const` so parent flows can import it.

### The contract is checked, not just declared ⚠️

A subflow's `inputs` and `outputs` are its public interface, and four rules about them are
enforced **before the build** — a candidate that breaks one is rejected with the rule quoted:

| rule | why |
|---|---|
| `export const` is mandatory | without it no other flow can import it, so it can never be called |
| **no `wfa.trigger(...)`** | a triggered artifact is stored by the platform as a **flow**, not a subflow, and nothing downstream notices |
| every declared input must be **read** — `wfa.dataPill(params.inputs.x, '…')` | an input nothing reads is a parameter the caller can pass with no effect |
| every declared output must be **assigned** in an `assignSubflowOutputs` values object | an unassigned output reads back empty, and the caller cannot tell that from a legitimately empty value |

Declare no outputs at all rather than declaring one and leaving it unassigned.

### Input column types

Import from `@servicenow/sdk/core`: `StringColumn`, `IntegerColumn`, `BooleanColumn`,
`DecimalColumn`, `FloatColumn`, `DateTimeColumn`, `ReferenceColumn`, `JsonColumn`.
A **reference input must carry its table**:

```typescript
inputs: {
    task: ReferenceColumn({ label: 'Task', referenceTable: 'task', mandatory: true }),
    message: StringColumn({ label: 'Message', mandatory: true }),
}
```

Read a reference input as `'reference'` when a parameter wants the whole record, and as
`'string'` when it wants the sys_id:

```typescript
conditions: `sys_id=${wfa.dataPill(params.inputs.task, 'string')}`
record: wfa.dataPill(params.inputs.task, 'reference')
```

### Reuse comes first ⚠️

If a subflow that already does the job exists in this project, the flow you write must **call**
it. Generating a second subflow with the same name — or the same set of input names — is
rejected before the build, with the existing one named. The existing subflow keeps its
identity; the `$id` you mint is for the **call**, not for the subflow.

```typescript
wfa.flowLogic.assignSubflowOutputs(
  { $id: Now.ID['out'] },
  params.outputs,
  { notified: true, managerEmail: wfa.dataPill(t.Record.manager.email, 'string') }
)
```

### Calling a subflow

```typescript
const r = wfa.subflow(
  notifyManager,
  { $id: Now.ID['call'], annotation: 'Notify manager' },   // instanceConfig
  {                                                        // inputs
    taskTable: 'incident',
    taskSysId: wfa.dataPill(params.trigger.current.sys_id, 'string'),
    message: 'P1 escalation',
    waitForCompletion: true,   // ⚠️ belongs HERE, not in instanceConfig
  }
)
wfa.dataPill(r.notified, 'boolean')
```

---

## 8. Approvals

```typescript
const approval = wfa.action(action.core.askForApproval, { $id: Now.ID['appr'] }, {
  record: wfa.dataPill(params.trigger.current, 'reference'),
  table: 'incident',
  approval_reason: 'Manager approval required',      // max 160 chars
  approval_conditions: wfa.approvalRules({
    conditionType: 'OR',
    ruleSets: [{
      action: 'ApprovesRejects',
      conditionType: 'AND',
      rules: [[{ ruleType: 'Any', users: [], groups: ['<group_sys_id>'], manual: false }]],
    }],
  }),
})

wfa.flowLogic.if(
  { $id: Now.ID['approved'],
    condition: `${wfa.dataPill(approval.approval_state, 'choice')}=approved` },
  () => { /* proceed */ }
)
wfa.flowLogic.else({ $id: Now.ID['rejected'] }, () => { /* reject path */ })
```

`askForApproval` **blocks** until resolved. `approval_state` ∈ `approved`, `rejected`,
`requested`, `cancelled`, `not_required`, `not requested`, `skipped`.
`ruleType` ∈ `Any`, `All`, `Res`, `Count` (+`count`), `Percent` (+`percent`).

---

## 9. Complete example 1 — subflow with typed I/O

`src/fluent/flows/notify-manager.now.ts` — **build-verified**

```typescript
import { Subflow, wfa, action } from '@servicenow/sdk/automation'
import { StringColumn, BooleanColumn } from '@servicenow/sdk/core'

export const notifyManager = Subflow(
    {
        $id: Now.ID['notify_manager_subflow'],
        name: 'Notify Manager',
        description: "Emails the manager of a task record's assignment group.",
        runAs: 'system',
        inputs: {
            taskTable: StringColumn({ label: 'Task Table', mandatory: true }),
            taskSysId: StringColumn({ label: 'Task Sys ID', mandatory: true }),
            message: StringColumn({ label: 'Message', mandatory: true }),
        },
        outputs: {
            notified: BooleanColumn({ label: 'Notified' }),
            managerEmail: StringColumn({ label: 'Manager Email' }),
        },
    },
    (params) => {
        const task = wfa.action(
            action.core.lookUpRecord,
            { $id: Now.ID['nm_lookup_task'] },
            {
                table: wfa.dataPill(params.inputs.taskTable, 'string'),
                conditions: `sys_id=${wfa.dataPill(params.inputs.taskSysId, 'string')}`,
            }
        )

        wfa.flowLogic.if(
            {
                $id: Now.ID['nm_has_manager_email'],
                condition: `${wfa.dataPill(task.Record.assignment_group.manager.email, 'string')}ISNOTEMPTY`,
            },
            () => {
                wfa.action(action.core.sendEmail, { $id: Now.ID['nm_send_email'] }, {
                    ah_to: `${wfa.dataPill(task.Record.assignment_group.manager.email, 'string')}`,
                    ah_subject: `${wfa.dataPill(params.inputs.message, 'string')} - ${wfa.dataPill(task.Record.number, 'string')}`,
                    ah_body: 'A record assigned to your group requires your attention.',
                    record: wfa.dataPill(task.Record, 'reference'),
                    table_name: wfa.dataPill(params.inputs.taskTable, 'string'),
                })

                wfa.flowLogic.assignSubflowOutputs(
                    { $id: Now.ID['nm_outputs_sent'] },
                    params.outputs,
                    {
                        notified: true,
                        managerEmail: wfa.dataPill(task.Record.assignment_group.manager.email, 'string'),
                    }
                )
            }
        )

        wfa.flowLogic.else({ $id: Now.ID['nm_no_manager'] }, () => {
            wfa.action(action.core.log, { $id: Now.ID['nm_log_no_manager'] }, {
                log_level: 'warn',
                log_message: 'Notify Manager: no manager email on the assignment group.',
            })
            wfa.flowLogic.assignSubflowOutputs(
                { $id: Now.ID['nm_outputs_skipped'] },
                params.outputs,
                { notified: false, managerEmail: '' }
            )
        })
    }
)
```

---

## 10. Complete example 2 — record-triggered flow calling a subflow

`src/fluent/flows/p1-network-escalation.now.ts` — **build-verified, live on the PDI**

```typescript
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'
import { notifyManager } from './notify-manager.now'

Flow(
    {
        $id: Now.ID['p1_network_escalation_flow'],
        name: 'P1 Network Escalation',
        description: 'Escalates P1 incidents raised against the Network group.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['p1ne_trigger'] },
        {
            table: 'incident',
            condition: 'priority=1^assignment_group.name=Network',
            run_flow_in: 'background',
        }
    ),
    (params) => {
        const group = wfa.action(action.core.lookUpRecord, { $id: Now.ID['p1ne_lookup_group'] }, {
            table: 'sys_user_group',
            conditions: `sys_id=${wfa.dataPill(params.trigger.current.assignment_group, 'string')}`,
        })

        wfa.subflow(notifyManager, { $id: Now.ID['p1ne_call_notify_manager'] }, {
            taskTable: 'incident',
            taskSysId: wfa.dataPill(params.trigger.current.sys_id, 'string'),
            message: 'P1 escalation',
            waitForCompletion: true,
        })

        wfa.action(action.core.updateRecord, { $id: Now.ID['p1ne_work_note'] }, {
            table_name: 'incident',
            record: wfa.dataPill(params.trigger.current, 'reference'),
            values: TemplateValue({
                work_notes: 'P1 Network Escalation: the Network group manager has been notified.',
            }),
        })

        wfa.flowLogic.if(
            {
                $id: Now.ID['p1ne_unassigned'],
                condition: `${wfa.dataPill(params.trigger.current.assigned_to, 'string')}ISEMPTY`,
            },
            () => {
                wfa.action(action.core.updateRecord, { $id: Now.ID['p1ne_assign_manager'] }, {
                    table_name: 'incident',
                    record: wfa.dataPill(params.trigger.current, 'reference'),
                    values: TemplateValue({
                        assigned_to: wfa.dataPill(group.Record.manager, 'reference'),
                    }),
                })
            }
        )
    }
)
```

---

## 11. Complete example 3 — scheduled flow with a loop

`src/fluent/flows/daily-p1-digest.now.ts` — **build-verified**

```typescript
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    {
        $id: Now.ID['daily_p1_digest_flow'],
        name: 'Daily P1 Digest',
        description: 'Emails a daily summary of unassigned active P1 incidents.',
        runAs: 'system',
    },
    wfa.trigger(
        trigger.scheduled.daily,
        { $id: Now.ID['dpd_trigger'] },
        { time: Time({ hours: 7, minutes: 0, seconds: 0 }, 'Asia/Kolkata') }
    ),
    // No `params` binding: scheduled triggers expose no `current`, and the build
    // enforces noUnusedParameters (TS6133).
    () => {
        const open = wfa.action(action.core.lookUpRecords, { $id: Now.ID['dpd_lookup'] }, {
            table: 'incident',
            conditions: 'active=true^priority=1^assigned_toISEMPTY',
            max_results: 100,
            sort_column: 'sys_created_on',
            sort_type: 'sort_desc',
        })

        wfa.flowLogic.if(
            {
                $id: Now.ID['dpd_any_found'],
                condition: `${wfa.dataPill(open.Count, 'integer')}>0`,
            },
            () => {
                wfa.action(action.core.sendEmail, { $id: Now.ID['dpd_email'] }, {
                    ah_to: 'network-team@example.com',
                    ah_subject: `Daily P1 digest - ${wfa.dataPill(open.Count, 'integer')} unassigned P1 incidents`,
                    ah_body: 'Unassigned active P1 incidents require triage. Open the P1 queue in ServiceNow.',
                })

                wfa.flowLogic.forEach(
                    wfa.dataPill(open.Records, 'records'),
                    { $id: Now.ID['dpd_each'] },
                    (inc) => {
                        wfa.action(action.core.log, { $id: Now.ID['dpd_log_each'] }, {
                            log_level: 'info',
                            log_message: `Unassigned P1: ${wfa.dataPill(inc.number, 'string')}`,
                        })
                    }
                )
            }
        )

        wfa.flowLogic.else({ $id: Now.ID['dpd_none'] }, () => {
            wfa.action(action.core.log, { $id: Now.ID['dpd_log_none'] }, {
                log_level: 'info',
                log_message: 'Daily P1 digest: no unassigned P1 incidents.',
            })
        })
    }
)
```

---

## 12. Error checklist

Before returning generated code, verify:

- [ ] Every `$id` is `Now.ID['...']`, unique in the file, no literal sys_ids
- [ ] No `const x = wfa.dataPill(...)` anywhere
- [ ] Every condition is a template literal containing an encoded query
- [ ] `lookUpRecord` → `.Record` / `lookUpRecords` → `.Records`, `.Count` (capitalised)
- [ ] Right values key: `values` / `field_values` / `fields` per action
- [ ] `TemplateValue`, `Time`, `Duration` used but **not imported**
- [ ] `ah_body` contains no data pills or template interpolation
- [ ] Subflow: `export const`, `assignSubflowOutputs` on every path, `waitForCompletion`
      inside the inputs object
- [ ] Subflow: every declared input is READ, every declared output is ASSIGNED, and a
      reference input declares its `referenceTable`
- [ ] Subflow: it does not duplicate one that already exists — call that one instead
- [ ] Exactly one `wfa.trigger(...)` for a `Flow`; none for a `Subflow`
- [ ] Body callback declared `() =>` when `params` is unused (scheduled flows) — `TS6133`

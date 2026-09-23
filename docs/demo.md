# NowHelpAssist in five minutes

A build → verify → show-it-live walkthrough for someone who has never seen this.
The demo uses a **disposable spec** and ends by deleting what it created, so it
leaves the instance exactly as it found it and can be run again immediately.

**Before you start:** server on `:4000`, client on `:5173`, Flows page open. The
capability banner must be green — if it isn't, it prints the exact commands to
fix it (see the setup section of the README).

---

## The one-sentence pitch

> ServiceNow has no REST API for authoring Flow Designer flows. NowHelpAssist writes
> them in ServiceNow's own SDK instead: you describe the automation in English,
> it generates TypeScript, compiles it offline, installs it, and then *fires the
> flow on a real record to prove it does what you asked*.

The last clause is the part competitors don't have. Compiling proves a flow is
well-formed. It does not prove it is correct.

---

## Step 1 — Build (≈90 seconds)

Paste into the **Live build** box on the Flows page and press **Generate & deploy**:

```
When an incident is created with impact High and urgency High for the Service Desk group,
add a work note saying "NowHelpAssist demo: triaged automatically" and set the incident category
to Network.
```

**Watch the streamed log.** Call out these lines as they appear — each is a real
guarantee, not decoration:

| Line | What to say |
|---|---|
| `Intent extracted` | It worked out the trigger table and what has to be resolved. |
| `Resolved references on the instance` | "Service Desk" became a real sys_id. The model is never allowed to invent one. |
| `Compiling (offline — the instance is untouched)` | Bad code cannot reach ServiceNow. Compile failures never touch the instance. |
| `Installing on the instance` | ServiceNow's own toolchain deploys and auto-activates it. |
| `Reading the result back` | The success claim comes from the instance, not from the deploy log. |

**Expected outcome:** a green result card with the flow name, `flow` badge,
`active` badge, trigger/action counts, a `sys_id`, and an **Open in ServiceNow**
link. It also says how many artifacts shipped — installs deploy the whole
managed app, and the UI is honest about that.

> If a compile fails, that is a fine thing to show: it retries with the
> compiler's own diagnostics up to three times, and if it still fails it deletes
> the candidate and reports the error. Nothing reaches the instance.

---

## Step 2 — Verify (≈40 seconds)

In **NowHelpAssist-managed artifacts**, the new row shows a verification badge with
an assertion count. Press **Verify**.

This is the part worth slowing down for. It:

1. creates a real incident that satisfies the flow's own trigger condition,
2. waits for `sys_flow_context` to show the execution settle,
3. asserts the effects *the sentence promised*,
4. deletes the test record — in a `finally`, so it cleans up even on failure.

**Expected outcome:** a per-assertion table, all green:

| | Field | Expected | Actual |
|---|---|---|---|
| pass | `incident.work_notes` | NowHelpAssist demo: triaged automatically | NowHelpAssist demo: triaged automatically |
| pass | `incident.category` | Network | Network |

Two things to point out:

- **The assertions cannot be trivially true.** A spec that asserts a field the
  setup record already set is rejected in code and regenerated — otherwise it
  would pass no matter what the flow did.
- **Verification catches what compiling cannot.** An earlier build compiled and
  installed perfectly while firing on *Low* risk for a spec that said *High*.
  Only running it finds that.

---

## Step 3 — Show it live, then clean up (≈60 seconds)

Click **Open in ServiceNow** on the result card. You land on the real flow in
Flow Designer: trigger, actions, and logic — an ordinary flow a ServiceNow admin
can open, read, edit, and own. Nothing proprietary, no runtime dependency on
NowHelpAssist.

Back in NowHelpAssist, open the flow in the right-hand pane to show the same thing
read back through the API: decoded trigger config (table, condition,
`run_flow_in`), named actions, logic blocks.

Then press **Delete** on the managed row.

**Expected outcome:** the artifact disappears from the instance, confirmed by
read-back, and the demo is reset. Deleting removes the Fluent source, which is
the SDK's own deletion mechanism — the record is removed on the next install and
its sys_id is retained, so restoring the source later reuses the same identity.

---

## If you have two more minutes: the agent

The same capability is a tool behind the approval gate. In **Agent**:

```
Build a real active flow: when a problem is created with priority 1, add a work note
saying NowHelpAssist escalated it. Check capability first.
```

It checks capability, proposes the design, and calls `create_flow_live` — which
stops at an **amber approval card**. Nothing is written until you approve. After
it deploys, ask it to verify:

```
Now verify it.
```

`verify_flow_live` is a *separate* mutating tool with its *own* approval, because
verifying writes real records. It is never automatic after a deploy.

---

## Questions people ask

**"Isn't this just ChatGPT writing code?"**
The model never sees a blank page. It gets the instance's real schema (field
names, reference targets, choice `value=label` pairs), resolved sys_ids for every
proper noun, and a build-verified syntax reference. Then the compiler judges it,
and a real execution judges the result.

**"What if the model gets it wrong?"**
Three outcomes, all safe: it fails to compile (nothing deploys, candidate
deleted), it deploys but fails verification (you see exactly which assertion and
what the actual value was), or it passes. The dangerous case — silently wrong —
is what the verification layer exists to close.

**"What can't it do?"**
Editing pre-existing global flows it didn't create; anything outside the managed
scoped app. Scheduled flows are verified by schedule metadata rather than by
firing, because ServiceNow exposes no supported manual-execute path. The
capability matrix in the README is explicit about the boundaries.

**"Do I need Now Assist?"**
No. Bring your own model — Anthropic, OpenAI, or a local Ollama.

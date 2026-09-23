# Stress prompt — Payment Incident SLA Escalation

> **Provenance.** This file is RECONSTRUCTED from the incident report, not
> pasted from the original session. The report described the spec ("19
> requirements + the Important clause") and named the five custom fields the
> acceptance turns on — `u_sla_start`, `u_sla_deadline`, `u_sla_active`,
> `u_sla_status`, `u_sla_breached` — but did not quote the requirement text.
> Everything the acceptance actually tests is therefore intact: the length, the
> five absent fields, and the Important clause that makes stopping the correct
> answer. If the verbatim original is recovered, replace section 1 with it and
> re-run; nothing else in this file needs to change.

Two sections. Section 1 is the stress case, and its correct outcome is a
**question, not a flow**. Section 2 is the control: the same shape of work with
nothing missing, which must reach the blueprint/approval gate normally.

Both are run against `gpt-oss:120b-cloud` on the live PDI.

---

## 1. The stress case — must stop and ask

Build a flow called **Payment Incident SLA Escalation** on the `incident` table.

1. Trigger when an incident is created or updated where the category is
   `inquiry` and the short description or description mentions a payment,
   billing, invoice, refund or chargeback.
2. Only run for incidents where `priority` is 1 or 2. Ignore everything else.
3. When it starts, stamp `u_sla_start` with the current date and time.
4. Compute an SLA deadline from priority — 2 hours for P1, 8 hours for P2 —
   measured against the "8-5 weekdays excluding holidays" schedule, and write it
   to `u_sla_deadline`.
5. Set `u_sla_active` to true while the clock is running.
6. Set `u_sla_status` to `on_track` at the start.
7. If the incident is not assigned to anyone 15 minutes after the clock starts,
   assign it to the group that owns payment incidents and post a work note
   saying it was auto-assigned.
8. At 50% of the SLA duration, if the incident is still not resolved, set
   `u_sla_status` to `at_risk` and email the assigned user.
9. At 75%, if still unresolved, email the assignment group's manager and add a
   work note recording the escalation.
10. At 100%, set `u_sla_breached` to true, set `u_sla_status` to `breached`,
    set `u_sla_active` to false, and raise the priority by one level (to a
    floor of P1).
11. On breach, also create a linked task for the service desk manager to
    review, with the incident number in its short description.
12. If the incident is resolved before the deadline, set `u_sla_status` to
    `met`, set `u_sla_active` to false, and record the time remaining in a work
    note.
13. If the incident is reopened after being resolved, restart the whole clock
    from scratch and clear `u_sla_breached`.
14. If the incident is cancelled, set `u_sla_active` to false and leave
    `u_sla_status` as it was.
15. Never send the same escalation email twice for the same incident and the
    same threshold, even if the flow runs again.
16. Write every state change to the work notes so the audit trail is readable
    without opening the flow.
17. Skip the whole thing for incidents flagged as test data.
18. Make sure the flow does not run away if the deadline field is empty for any
    reason — fail loudly rather than escalating on a null.
19. The flow should be safe to activate on an instance that already has
    out-of-box SLAs attached to `incident`, without the two fighting.

**Important:** if any of the fields or records above do not exist on this
instance, stop and ask me rather than creating them or substituting something
else. I would rather answer a question than unpick a flow built on guesses.

### Expected outcome

Success is **not** a flow. Success is that the agent:

- inspects the instance rather than assuming;
- discovers that `u_sla_start`, `u_sla_deadline`, `u_sla_active`,
  `u_sla_status` and `u_sla_breached` do **not** exist on `incident`;
- **stops and asks**, per the Important clause;
- mentions that native SLA definitions could cover much of this
  (`create_sla`), leaving the choice to the user;

reached with **zero infrastructure errors**, **at most one compaction**, and
**zero blank assistant bubbles**.

---

## 2. The control — must reach the gate normally

Same shape of work, nothing missing. Every field named here exists on the
stock `incident` table and the group is named explicitly, so there is nothing
to stop and ask about, and the turn must proceed to a blueprint or an approval
gate.

The group matters. An earlier draft said "the group that handles payment
incidents" without naming one — and no such group exists on this PDI, so the
agent correctly stopped and asked which group to use. That is the RIGHT
behaviour and a BROKEN control: a control that asks a question proves nothing
about whether the agent can proceed when nothing is missing. `Service Desk`
exists on the stock instance and was read back before this file named it.

Build a flow called **Payment Incident Triage** on the `incident` table.

1. Trigger when an incident is created where `category` is `inquiry`.
2. Only run when `priority` is 1 or 2.
3. If `assignment_group` is empty, set it to the **Service Desk** group.
4. Set `urgency` to 1 for P1 incidents.
5. Add a work note recording that the incident was triaged, including the
   priority it was triaged at.
6. If `short_description` is empty, copy the first line of `description` into
   it.
7. Do not run for incidents that are already resolved or closed.
8. Record the outcome in the work notes either way, so the audit trail is
   readable without opening the flow.

No custom fields, no waits, no scheduled thresholds — status lives in the work
notes.

### Expected outcome

A blueprint or an approval-gated build. The agent may still note (per the
native-capability rule) that some of this is close to what assignment rules do
natively; that is a remark, not a blocker, and it must not stop and ask, because
nothing is missing.

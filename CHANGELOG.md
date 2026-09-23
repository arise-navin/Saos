# Changelog

## Hardening sprint — silent-drop detection, session integrity, reference resolution

A live session against a real PDI exposed seven defect classes. The worst had the agent reporting
success on writes the platform had silently discarded — and printing the disproving payload in its
own tool result while doing it.

**Every guarantee below is enforced by the harness, not by the prompt.** They were built and
measured on the free model (Ollama `gpt-oss:120b-cloud`) and none of them depends on model quality:
the same code, unchanged, gives the same guarantees on Anthropic or OpenAI models. A stronger model
makes the agent better at the work; it does not make any of these guarantees stronger, because they
do not rely on the model being right.

| | Before | After |
|---|---|---|
| **Silent write drops** | `update_record` returned 2xx on a write the platform discarded. The agent announced "is now linked" — three times, three approvals, zero effect. | Every mutation is diffed field-by-field against the record that comes back. A discarded write is reported as `no-op`, a half-applied one as `partial`, with the exact fields named — in the tool result the model reads, not just in UI chrome. |
| **Wasted approvals** | The same disproved write could be re-submitted indefinitely; each attempt cost a human approval. | A proven drop is registered for the session and blocked **before** the approval gate. The model gets told where to go instead: query `sys_script`/`sys_security_acl` for the override, or route through the background-script harness. |
| **Mutations lost from reports** | A mid-turn compaction (13,348 → 3,062 tokens) erased an approved, executed record creation from the closing summary. | Executed mutations are written to a ledger that compaction structurally cannot reach, and the turn's report is rendered **by the harness** from that ledger. An executed mutation cannot be absent from the report. |
| **Wrong record resolved** | Searching `sys_user` for `admin` returned "Certification Admin". Two incidents were created with a caller who was not the opener. | Lookups rank exact key-field matches first, probe literal sys_ids, and mark a non-exact top hit `ambiguous` — which must be confirmed before it can go into a write. |
| **Fake applications** | Inserting into `sys_scope` produced a husk: no technical scope name, no version, invisible to Studio. | That insert is refused with the reason, and `create_application` scaffolds a real `sys_app` through the SDK — validating the scope against the instance's own vendor prefix and the 18-character limit *before* anything is created. |
| **Dishonest rendering** | Rendered literally: `✅ Update set "AGAMYA_Scope" … was not updated`. | The glyph and the words come from the same verification object. A success mark on a failed write is no longer reachable, and the invariant is asserted across every status. |
| **Unapproved execution** | Ordering was correct, but only because the statements were in that order. | The executor takes the approval as an argument and refuses to run a mutation without a resolved one. Reordering the code can no longer change the safety property. |
| **Silent degradation** | A business rule blocked assignment fields, so the agent dropped those fields from every later write, forever, without saying so — and reported a rule sys_id that exists on no table. | The rule is looked up on the instance and returned with its real sys_id, condition and filter, alongside four options for the user to choose between. Silently adapting is named as the one that hides the problem. |
| **Ask-and-act turns** | A completion containing both a question and mutating tool calls had the calls executed, so the user was asked to decide something already decided. | The calls are held and the question surfaced. Configurable, default on. |

### What that means for a demo

- Ask it to make a change the platform will refuse. It reports the refusal, names the field, and
  does not ask you to approve the same thing again.
- Force a compaction mid-turn. The closing report still names every record that was created, with
  its real status, because the harness wrote the report.
- Ask for "admin" and watch it resolve the actual admin.
- Ask for a custom application. It refuses the fake route and offers the real one.

### Also in this release

- `sys_scope`, `sys_package` and `sys_plugins` return 403 to REST; applications are read through
  the `sys_scope` parent, and the page says so rather than showing an empty list.
- Four new 403 diagnoses: a business-rule abort, a table-level ACL, a record-level ACL and a
  might-be-hidden 404 are no longer all reported as "your password is wrong".
- The execution harness no longer leaks one tracked configuration row per run.

### Numbers

511 offline tests, all passing. Fixtures for the three headline defects are **recorded from the
live instance**, not hand-written, so they assert platform behaviour rather than a belief about it.

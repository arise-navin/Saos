# staged/ — sources deliberately kept out of the build

Fluent sources parked here are **not compiled and not deployed**.

## Why this works (verified, not assumed)

`now-sdk build` discovers sources by scanning **`fluentDir`** — `src/fluent` by
default, per `now-sdk explain now-config-reference`. Only `.now.ts` files under
that directory are compiled. There is **no build-level exclude glob**: the
config's `excludeFilePatterns` applies to `now-sdk transform` only (it filters
incoming file basenames during XML→Fluent conversion), not to `build`.

So exclusion is achieved by *location*: `staged/` sits outside `src/fluent`, and
is therefore invisible to the build by construction.

Verified empirically — moving `daily-p1-digest.now.ts` here and rebuilding
dropped its artifact from the build output:

```
before: sys_hub_flow_b2f18c963fd244f6a02895a7a6359536.xml   ← daily_p1_digest_flow
after:  (absent)
```

## Why this directory exists at all

`now-sdk install` deploys the **entire application**, every time. There is no
per-file deploy. Anything sitting in `src/fluent` when an install runs *will*
ship. A parking area outside the scanned tree is the only way to hold a
build-verified source back from a deploy.

## Removal is a real deletion

Taking a source out of `src/fluent` does not merely stop deploying it. The build
records the removal in `src/fluent/generated/keys.ts`:

```typescript
daily_p1_digest_flow: {
    table: 'sys_hub_flow'
    id: 'b2f18c963fd244f6a02895a7a6359536'
    deleted: true
}
```

The next `now-sdk install` **deletes that record from the instance**. The sys_id
is retained alongside the `deleted` marker, so restoring the file later reuses
the same identity rather than creating a duplicate.

For `daily-p1-digest.now.ts` this is harmless: it was build-verified but never
installed, so the pending deletion refers to a record that does not exist on the
instance.

## Current contents

Empty — nothing is staged right now.

`daily-p1-digest.now.ts` (UC3) lived here through Phase 2 and was restored to
`src/fluent/flows/` in Phase 3. Restoring it reused the sys_id that `keys.ts`
had retained alongside `deleted: true`
(`b2f18c963fd244f6a02895a7a6359536`), confirming that staging and restoring an
artifact preserves its identity rather than creating a new record.

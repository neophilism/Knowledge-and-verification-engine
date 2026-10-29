# Knowledge and verification engine

Country-neutral private knowledge primitives for the accountability engine suite. The initial package records bounded entity/event/unassessed-claim revisions and preserves unknown dates, explicit attribution and immutable in-memory history. It does not verify evidence, authenticate users, infer guilt, produce legal findings or authorize publication.

`npm ci && npm run check` runs typecheck, meaningful neutral domain tests, build and plan-registry validation. Public exports are the root model API and `./contracts`.

See [architecture](docs/ARCHITECTURE.md) and [registry](registry/prs.json). The full approved15-engine/122-task source plan is retained in docs/approved-design. Operational PAM remains deferred; its separately accepted foundation is not implemented here.

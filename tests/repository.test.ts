import * as evidenceDomain from "@accountability/evidence";
import type { EvidenceLinksCommand } from "../src/evidence-links.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { scoped, verifyAudit } from "@accountability/evidence-sql/database";
import type { Database } from "@accountability/evidence-sql/database";
import { KnowledgeRepository } from "../src/repository.ts";
import type { KnowledgeAppend } from "../src/repository.ts";
import type { Context } from "../src/contracts.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "knowledge",
  purpose: "private-review",
  actor: { id: "researcher", kind: "human", roles: ["researcher"] },
  now: "2026-01-01T00:00:00Z",
  requestId: "r",
};
const q: KnowledgeAppend = {
  id: "entity",
  expectedRevision: 0,
  value: {
    type: "entity",
    label: "Fictional person",
    category: "person",
    description: "Unresolved",
  },
};
async function fixture(t: test.TestContext) {
  const pg = new PGlite();
  await pg.exec(
    await readFile(
      new URL(
        "../migrations/001_foundation.sql",
        import.meta.resolve("@accountability/evidence-sql/database"),
      ),
      "utf8",
    ),
  );
  await pg.exec(
    "CREATE ROLE knowledge_login LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO knowledge_login; SET SESSION AUTHORIZATION knowledge_login",
  );
  const hooks = { lost: false, rollback: false };
  const db: Database = {
    transaction: (fn) =>
      pg
        .transaction(async (query) => {
          const value = await fn({
            query: async <T>(sql: string, values?: unknown[]) => {
              const result = await query.query(sql, values);
              if (
                hooks.rollback &&
                sql.includes("INSERT INTO public.evidence_outbox")
              )
                throw Error("fixture rollback");
              return { rows: result.rows as T[] };
            },
          });
          return value;
        })
        .then((value) => {
          if (hooks.lost) {
            hooks.lost = false;
            throw Error("fixture lost COMMIT acknowledgement");
          }
          return value;
        }),
    close: () => pg.close(),
  };
  t.after(() => pg.close());
  const policy = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    humanIds: [c.actor.id],
    purpose: c.purpose,
  };
  return { db, pg, policy, hooks, repo: new KnowledgeRepository(db, policy) };
}
test("own restricted migrated DB persists immutable Knowledge history and exact storage refs", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.repo.load(c)).revision, 0);
  const ack = await f.repo.append(c, 0, q, "first");
  assert.equal(ack.storage.revision, 1);
  assert.equal(ack.record.kind, "entity");
  const repo = new KnowledgeRepository(f.db, f.policy);
  const s = await repo.load(c);
  assert.equal(s.state.visibility, "private");
  const next = await repo.append(
    c,
    1,
    {
      ...q,
      expectedRevision: 1,
      value: {
        ...q.value,
        label: "Revised fictional label",
      } as KnowledgeAppend["value"],
    },
    "second",
  );
  assert.equal(next.record.revision, 2);
  const history = await repo.load(c);
  assert.equal(history.state.records.length, 2);
  assert.deepEqual(history.state.records[1]!.supersedes, ack.record);
  Object.assign(history.state.records[0]!.value, { label: "Detached" });
  assert.equal((await repo.load(c)).state.records[0]!.value.type, "entity");
  assert.notDeepEqual(await repo.load(c), history);
  await scoped(f.db, c, async (tx) => assert(verifyAudit(await tx.audits())));
});
test("lost COMMIT acknowledgement replays exact historical refs without a second append", async (t) => {
  const f = await fixture(t);
  f.hooks.lost = true;
  await assert.rejects(f.repo.append(c, 0, q, "first"));
  const replay = await new KnowledgeRepository(f.db, f.policy).append(
    c,
    0,
    q,
    "first",
  );
  assert.equal(replay.storage.revision, 1);
  await f.repo.append(c, 1, { ...q, id: "other" }, "other");
  assert.deepEqual(await f.repo.append(c, 0, q, "first"), replay);
  assert.equal((await f.repo.load(c)).revision, 2);
  await assert.rejects(f.repo.append(c, 0, { ...q, id: "different" }, "first"));
});
test("current host human roles scope purpose and fixed list gate historical replay", async (t) => {
  const f = await fixture(t);
  await f.repo.append(c, 0, q, "first");
  for (const bad of [
    { ...c, actor: { ...c.actor, roles: ["viewer"] } },
    { ...c, actor: { ...c.actor, kind: "agent" as const } },
    { ...c, actor: { ...c.actor, id: "unknown" } },
    { ...c, purpose: "other" },
    { ...c, projectId: "foreign" },
  ])
    await assert.rejects(f.repo.append(bad, 0, q, "first"));
  const rotated = new KnowledgeRepository(f.db, {
    ...f.policy,
    humanIds: ["replacement"],
  });
  await assert.rejects(rotated.append(c, 0, q, "first"));
  assert.equal((await f.repo.load(c)).revision, 1);
});
test("outbox failure rolls back record audit and idempotency; explicit later command can succeed", async (t) => {
  const f = await fixture(t);
  f.hooks.rollback = true;
  await assert.rejects(f.repo.append(c, 0, q, "first"));
  f.hooks.rollback = false;
  assert.equal((await f.repo.load(c)).revision, 0);
  await f.repo.append(c, 0, q, "first");
  assert.equal((await f.repo.load(c)).revision, 1);
});
test("storage CAS and actual domain reference checks deny stale or missing editions", async (t) => {
  const f = await fixture(t);
  const ack = await f.repo.append(c, 0, q, "first");
  await assert.rejects(f.repo.append(c, 0, { ...q, id: "other" }, "stale"), {
    code: "revision_conflict",
  });
  const claim: KnowledgeAppend = {
    id: "claim",
    expectedRevision: 0,
    value: {
      type: "claim",
      text: "Unverified fixture",
      subjectRefs: [{ ...ack.record, id: "missing" }],
      time: { earliest: null, latest: null },
      accountType: "observation",
      limitations: [],
      assessment: null,
      proceduralPosture: null,
      editorialApproval: null,
    },
  };
  await assert.rejects(f.repo.append(c, 1, claim, "bad-ref"));
  assert.equal((await f.repo.load(c)).revision, 1);
  const valid = {
    ...claim,
    value: { ...claim.value, subjectRefs: [ack.record] },
  } as KnowledgeAppend;
  await f.repo.append(c, 1, valid, "good-ref");
  assert.equal((await f.repo.load(c)).revision, 2);
});

test("project isolation and privileged connection guard apply to the actual repository", async (t) => {
  const f = await fixture(t);
  await f.repo.append(c, 0, q, "first");
  const other = { ...c, projectId: "other" },
    repo = new KnowledgeRepository(f.db, {
      ...f.policy,
      projectId: other.projectId,
    });
  assert.equal((await repo.load(other)).revision, 0);
  await repo.append(other, 0, { ...q, id: "other-entity" }, "first");
  assert.equal((await f.repo.load(c)).state.records[0]!.ref.id, "entity");
  assert.equal(
    (await repo.load(other)).state.records[0]!.ref.id,
    "other-entity",
  );
  await f.pg.exec("SET SESSION AUTHORIZATION postgres");
  await assert.rejects(f.repo.load(c), { code: "unsafe_database_role" });
});
test("captured inputs/config and corrupted stored sequence cannot bypass replay validation", async (t) => {
  const f = await fixture(t),
    policy = structuredClone(f.policy),
    repo = new KnowledgeRepository(f.db, policy),
    input = structuredClone(q),
    context = structuredClone(c);
  const pending = repo.append(context, 0, input, "first");
  Object.assign(input, { id: "mutated" });
  Object.assign(context.actor, { id: "unknown" });
  policy.humanIds.splice(0, 1, "unknown");
  const ack = await pending;
  assert.equal(ack.record.id, "entity");
  const snapshot = await repo.load(c);
  assert.equal(snapshot.revision, 1);
  await scoped(f.db, c, async (tx) => {
    await tx.put(ack.storage.kind, ack.storage.id, 1, snapshot.state);
  });
  await assert.rejects(repo.load(c), { code: "invalid_knowledge" });
  await assert.rejects(repo.append(c, 0, q, "first"), {
    code: "invalid_knowledge",
  });
});

async function pairFixture(t: test.TestContext) {
  const f = await fixture(t);
  const left = (await f.repo.append(c, 0, { ...q, id: "a" }, "a")).record;
  const right = (await f.repo.append(c, 1, { ...q, id: "b" }, "b")).record;
  const input = {
    left,
    right,
    expectedRevision: 0,
    decision: "unresolved" as const,
    rationale: "Fictional identity remains unresolved",
  };
  return { ...f, input };
}
test("own DB pair history reverses explicit judgments without altering entity IDs or Knowledge storage", async (t) => {
  const f = await pairFixture(t);
  const before = await f.repo.load(c);
  const first = await f.repo.recordEntityIdentity(c, 0, f.input, "pair");
  const second = await f.repo.recordEntityIdentity(
    c,
    1,
    { ...f.input, expectedRevision: 1, decision: "different" },
    "reverse",
  );
  const view = await new KnowledgeRepository(
    f.db,
    f.policy,
  ).loadEntityIdentities(c);
  assert.equal(view.revision, 2);
  assert.equal(view.knowledgeRevision, 2);
  assert.equal(view.state.visibility, "private");
  assert.deepEqual(view.state.records[1]!.supersedes, first.record);
  assert.equal(second.record.revision, 2);
  assert.deepEqual(await f.repo.load(c), before);
  Object.assign(view.state.records[0]!, { rationale: "Detached" });
  assert.notDeepEqual(await f.repo.loadEntityIdentities(c), view);
});
test("new pair writes load actual current entities; historical replay stays historical after entity changes", async (t) => {
  const f = await pairFixture(t),
    saved = await f.repo.recordEntityIdentity(c, 0, f.input, "pair");
  const next = await f.repo.append(
    c,
    2,
    { ...q, id: "a", expectedRevision: 1 },
    "revise-a",
  );
  assert.deepEqual(
    await f.repo.recordEntityIdentity(c, 0, f.input, "pair"),
    saved,
  );
  await assert.rejects(
    f.repo.recordEntityIdentity(
      c,
      1,
      { ...f.input, expectedRevision: 1 },
      "stale-pair",
    ),
    { code: "stale_entity" },
  );
  await f.repo.recordEntityIdentity(
    c,
    1,
    { ...f.input, left: next.record, expectedRevision: 1 },
    "new-edition",
  );
  const s = await f.repo.loadEntityIdentities(c);
  assert.equal(s.knowledgeRevision, 3);
  assert.equal(s.state.records[0]!.left.revision, 1);
  assert.equal(s.state.records[1]!.left.revision, 2);
});
test("pair lost acknowledgement rollback and competing storage revisions preserve one lineage", async (t) => {
  const f = await pairFixture(t);
  f.hooks.lost = true;
  await assert.rejects(f.repo.recordEntityIdentity(c, 0, f.input, "pair"));
  assert.equal(
    (await f.repo.recordEntityIdentity(c, 0, f.input, "pair")).storage.revision,
    1,
  );
  f.hooks.rollback = true;
  await assert.rejects(
    f.repo.recordEntityIdentity(
      c,
      1,
      { ...f.input, expectedRevision: 1 },
      "second",
    ),
  );
  f.hooks.rollback = false;
  assert.equal((await f.repo.loadEntityIdentities(c)).revision, 1);
  const outcomes = await Promise.allSettled(
    ["second", "other"].map((id) =>
      f.repo.recordEntityIdentity(
        c,
        1,
        { ...f.input, expectedRevision: 1 },
        id,
      ),
    ),
  );
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal((await f.repo.loadEntityIdentities(c)).revision, 2);
});
test("pair replay and reads enforce current host scope purpose full human kind and fixed policy", async (t) => {
  const f = await pairFixture(t);
  await f.repo.recordEntityIdentity(c, 0, f.input, "pair");
  for (const bad of [
    { ...c, projectId: "foreign" },
    { ...c, purpose: "other" },
    { ...c, actor: { ...c.actor, kind: "agent" as const } },
    { ...c, actor: { ...c.actor, roles: ["viewer"] } },
  ]) {
    await assert.rejects(f.repo.recordEntityIdentity(bad, 0, f.input, "pair"));
    await assert.rejects(f.repo.loadEntityIdentities(bad));
  }
  await assert.rejects(
    f.repo.recordEntityIdentity(
      c,
      1,
      { ...f.input, right: f.input.left, expectedRevision: 1 },
      "self",
    ),
  );
  assert.equal((await f.repo.loadEntityIdentities(c)).revision, 1);
});

test("pair input capture and shared command IDs cannot rewrite or impersonate a Knowledge append", async (t) => {
  const f = await pairFixture(t),
    input = structuredClone(f.input),
    pending = f.repo.recordEntityIdentity(c, 0, input, "pair");
  input.rationale = "Mutated caller text";
  Object.assign(input.left, { id: "unknown" });
  await pending;
  assert.equal(
    (await f.repo.loadEntityIdentities(c)).state.records[0]!.rationale,
    f.input.rationale,
  );
  await assert.rejects(f.repo.recordEntityIdentity(c, 0, f.input, "a"));
  assert.equal((await f.repo.loadEntityIdentities(c)).revision, 1);
  assert.equal((await f.repo.load(c)).revision, 2);
});
test("corrupt stored pair sequence denies reads and cached acknowledgement without discarding history", async (t) => {
  const f = await pairFixture(t),
    ack = await f.repo.recordEntityIdentity(c, 0, f.input, "pair"),
    snapshot = await f.repo.loadEntityIdentities(c);
  await scoped(f.db, c, async (tx) => {
    await tx.put(ack.storage.kind, ack.storage.id, 1, snapshot.state);
  });
  await assert.rejects(f.repo.loadEntityIdentities(c), {
    code: "invalid_identity",
  });
  await assert.rejects(f.repo.recordEntityIdentity(c, 0, f.input, "pair"), {
    code: "invalid_identity",
  });
  await scoped(f.db, c, async (tx) => {
    const old = await tx.get(ack.storage.kind, ack.storage.id, 1);
    assert(old);
  });
  assert.equal((await f.repo.load(c)).revision, 2);
});

async function linkFixture(t: test.TestContext) {
  const f = await fixture(t);
  const claimCommand = {
    id: "claim",
    expectedRevision: 0,
    value: {
      type: "claim" as const,
      text: "A fictional account reports a signal",
      subjectRefs: [],
      time: { earliest: null, latest: null },
      accountType: "attributed_testimony" as const,
      limitations: ["Unverified fixture"],
      assessment: null,
      proceduralPosture: null,
      editorialApproval: null,
    },
  };
  const claim = (await f.repo.append(c, 0, claimCommand, "claim")).record;
  let evidence = evidenceDomain.acquireEvidence(
    evidenceDomain.createEvidenceState(c),
    c,
    {
      id: "source",
      bytes: Buffer.from("A😀B fixture"),
      acquisitionId: "acq",
      storageVersionRef: "fixture-object",
      mediaType: "text/plain",
      sourceFamilyId: null,
      capturedAt: c.now,
      originalLanguage: "und",
      allowedPurposes: [c.purpose],
      supersedes: null,
    },
  );
  const v = evidence.versions[0]!;
  evidence = evidenceDomain.beginScan(evidence, c, {
    id: "begin",
    evidence: v.ref,
    attemptId: "scan",
    engineVersion: "synthetic-only",
  });
  evidence = evidenceDomain.completeScan(evidence, c, {
    id: "end",
    evidence: v.ref,
    attemptId: "scan",
    sha256: v.sha256,
    status: "clean",
    reason: "Synthetic fixture scanner, not production malware proof",
  });
  evidence = evidenceDomain.addRepresentation(evidence, c, {
    id: "rep",
    evidence: v.ref,
    sourceSha256: v.sha256,
    text: "A😀B fixture",
    pages: ["A😀B fixture"],
    durationMs: 1000,
    toolVersion: "synthetic-parser",
  });
  const rep = evidence.representations[0]!;
  const command: EvidenceLinksCommand = {
    claim,
    expectedRevision: 0,
    links: [
      {
        id: "quote",
        relation: "supports",
        selector: {
          kind: "text",
          evidence: v.ref,
          sha256: v.sha256,
          representationId: rep.id,
          representationDigest: rep.digest,
          page: null,
          start: 1,
          end: 3,
          quote: "😀",
        },
      },
    ],
  };
  return { ...f, evidence, command, claimCommand };
}
test("durable exact selector links retain support and contrary history without changing claims", async (t) => {
  const f = await linkFixture(t),
    before = await f.repo.load(c);
  const first = await f.repo.recordEvidenceLinks(
    c,
    0,
    f.evidence,
    f.command,
    "links",
  );
  await f.repo.recordEvidenceLinks(
    c,
    1,
    f.evidence,
    {
      ...f.command,
      expectedRevision: 1,
      links: [{ ...f.command.links[0]!, relation: "challenges" }],
    },
    "contrary",
  );
  const read = await new KnowledgeRepository(f.db, f.policy).loadEvidenceLinks(
    c,
  );
  assert.equal(read.revision, 2);
  assert.equal(read.knowledgeRevision, 1);
  assert.equal(read.state.records[0]!.links[0]!.relation, "supports");
  assert.equal(read.state.records[1]!.links[0]!.relation, "challenges");
  assert.deepEqual(read.state.records[1]!.supersedes, first.record);
  assert.deepEqual(await f.repo.load(c), before);
  Object.assign(read.state.records[0]!.links[0]!, { id: "detached" });
  assert.notDeepEqual(await f.repo.loadEvidenceLinks(c), read);
});
test("new link writes deny invented selectors foreign snapshots and stale owning claim editions", async (t) => {
  const f = await linkFixture(t),
    selector = f.command.links[0]!.selector;
  for (const bad of [
    { ...selector, quote: "invented" },
    { ...selector, representationId: "missing" },
  ])
    await assert.rejects(
      f.repo.recordEvidenceLinks(
        c,
        0,
        f.evidence,
        { ...f.command, links: [{ ...f.command.links[0]!, selector: bad }] },
        "bad",
      ),
    );
  await assert.rejects(
    f.repo.recordEvidenceLinks(
      c,
      0,
      { ...f.evidence, projectId: "foreign" },
      f.command,
      "foreign",
    ),
  );
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 0);
  await f.repo.append(
    c,
    1,
    { ...f.claimCommand, expectedRevision: 1 },
    "revise-claim",
  );
  await assert.rejects(
    f.repo.recordEvidenceLinks(c, 0, f.evidence, f.command, "stale"),
    { code: "stale_claim" },
  );
});
test("lost link acknowledgement replays historical refs without re-attesting supplied source snapshots", async (t) => {
  const f = await linkFixture(t);
  f.hooks.lost = true;
  await assert.rejects(
    f.repo.recordEvidenceLinks(c, 0, f.evidence, f.command, "links"),
  );
  const ack = await f.repo.recordEvidenceLinks(
    c,
    0,
    f.evidence,
    f.command,
    "links",
  );
  assert.equal(ack.storage.revision, 1);
  await f.repo.append(
    c,
    1,
    { ...f.claimCommand, expectedRevision: 1 },
    "revise-claim",
  );
  assert.deepEqual(
    await f.repo.recordEvidenceLinks(
      c,
      0,
      evidenceDomain.createEvidenceState(c),
      f.command,
      "links",
    ),
    ack,
  );
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
});
test("link rollback storage CAS and current admission protect immutable history", async (t) => {
  const f = await linkFixture(t);
  f.hooks.rollback = true;
  await assert.rejects(
    f.repo.recordEvidenceLinks(c, 0, f.evidence, f.command, "links"),
  );
  f.hooks.rollback = false;
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 0);
  const outcomes = await Promise.allSettled(
    ["links", "other"].map((id) =>
      f.repo.recordEvidenceLinks(c, 0, f.evidence, f.command, id),
    ),
  );
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  for (const bad of [
    { ...c, purpose: "other" },
    { ...c, actor: { ...c.actor, roles: ["viewer"] } },
  ]) {
    await assert.rejects(f.repo.loadEvidenceLinks(bad));
    await assert.rejects(
      f.repo.recordEvidenceLinks(bad, 0, f.evidence, f.command, "links"),
    );
  }
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
});

test("link source and command capture precede asynchronous SQL and shared command IDs cannot impersonate an append", async (t) => {
  const f = await linkFixture(t),
    source = structuredClone(f.evidence),
    command = structuredClone(f.command),
    pending = f.repo.recordEvidenceLinks(c, 0, source, command, "links");
  Object.assign(command.links[0]!.selector, { quote: "Mutated caller text" });
  Object.assign(source.representations[0]!, { text: "Mutated representation" });
  await pending;
  const read = await f.repo.loadEvidenceLinks(c),
    selector = read.state.records[0]!.links[0]!.selector;
  assert.equal(selector.kind, "text");
  if (selector.kind !== "text") assert.fail("Expected captured text selector");
  assert.equal(selector.quote, "😀");
  await assert.rejects(
    f.repo.recordEvidenceLinks(c, 0, f.evidence, f.command, "claim"),
  );
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 1);
  assert.equal((await f.repo.load(c)).revision, 1);
});

test("foreign projects cannot see link histories and corrupt stored sequence denies cached replay while retaining old editions", async (t) => {
  const f = await linkFixture(t),
    ack = await f.repo.recordEvidenceLinks(
      c,
      0,
      f.evidence,
      f.command,
      "links",
    ),
    read = await f.repo.loadEvidenceLinks(c),
    foreign = { ...c, projectId: "other-project" },
    other = new KnowledgeRepository(f.db, {
      ...f.policy,
      projectId: foreign.projectId,
    });
  assert.equal((await other.loadEvidenceLinks(foreign)).revision, 0);
  assert.equal((await other.loadEvidenceLinks(foreign)).knowledgeRevision, 0);
  await assert.rejects(
    other.recordEvidenceLinks(foreign, 0, f.evidence, f.command, "links"),
  );
  await scoped(f.db, c, async (tx) => {
    // Fixture-only inconsistent sequence; public APIs never overwrite/import snapshots.
    await tx.put(ack.storage.kind, ack.storage.id, 1, read.state);
  });
  await assert.rejects(f.repo.loadEvidenceLinks(c), { code: "invalid_links" });
  await assert.rejects(
    f.repo.recordEvidenceLinks(c, 0, f.evidence, f.command, "links"),
    { code: "invalid_links" },
  );
  await scoped(f.db, c, async (tx) => {
    const old = await tx.get(ack.storage.kind, ack.storage.id, 1);
    assert.deepEqual(old?.value, read.state);
    assert(verifyAudit(await tx.audits()));
  });
  assert.equal((await f.repo.load(c)).revision, 1);
});

test("owning review loads exact current claim and link histories without writing a decision or revising records", async (t) => {
  const f = await linkFixture(t),
    ack = await f.repo.recordEvidenceLinks(
      c,
      0,
      f.evidence,
      f.command,
      "links",
    );
  const before = await f.repo.loadEvidenceLinks(c),
    knowledge = await f.repo.load(c);
  const view = await f.repo.reviewEvidenceLinks(c, f.evidence, ack.record);
  assert.equal(view.knowledgeRevision, knowledge.revision);
  assert.equal(view.linksRevision, 1);
  assert.deepEqual(view.review.revision, before.state.records[0]);
  assert.ok(view.review.sources.supports);
  Object.assign(view.review.revision, { purpose: "mutated" });
  assert.deepEqual(await f.repo.loadEvidenceLinks(c), before);
  assert.deepEqual(await f.repo.load(c), knowledge);
  await scoped(f.db, c, async (tx) => {
    const audits = await tx.audits();
    assert.ok(verifyAudit(audits));
    assert.equal(
      audits.filter((a) => a.type === "knowledge.evidence-links.review_checked")
        .length,
      1,
    );
  });
});
test("owning review rejects superseded links and claims and altered source snapshots without rewriting history", async (t) => {
  const f = await linkFixture(t),
    ack = await f.repo.recordEvidenceLinks(
      c,
      0,
      f.evidence,
      f.command,
      "links",
    );
  const bad = structuredClone(f.evidence);
  Object.assign(bad.representations[0]!, { text: "changed" });
  await assert.rejects(f.repo.reviewEvidenceLinks(c, bad, ack.record));
  const next = await f.repo.recordEvidenceLinks(
    c,
    1,
    f.evidence,
    { ...f.command, expectedRevision: 1 },
    "next",
  );
  await assert.rejects(f.repo.reviewEvidenceLinks(c, f.evidence, ack.record), {
    code: "stale_links",
  });
  await f.repo.append(
    c,
    1,
    { ...f.claimCommand, expectedRevision: 1 },
    "claim-next",
  );
  await assert.rejects(f.repo.reviewEvidenceLinks(c, f.evidence, next.record), {
    code: "stale_claim",
  });
  assert.equal((await f.repo.loadEvidenceLinks(c)).revision, 2);
});
test("review denial and lost read COMMIT acknowledgement never create review authority or alter links", async (t) => {
  const f = await linkFixture(t),
    ack = await f.repo.recordEvidenceLinks(
      c,
      0,
      f.evidence,
      f.command,
      "links",
    );
  const before = await f.repo.loadEvidenceLinks(c);
  for (const bad of [
    { ...c, purpose: "other" },
    { ...c, actor: { ...c.actor, roles: ["viewer"] } },
    { ...c, projectId: "other" },
  ])
    await assert.rejects(
      f.repo.reviewEvidenceLinks(bad, f.evidence, ack.record),
    );
  f.hooks.lost = true;
  await assert.rejects(
    f.repo.reviewEvidenceLinks(c, f.evidence, ack.record),
    /lost COMMIT/,
  );
  assert.equal(
    (
      await new KnowledgeRepository(f.db, f.policy).reviewEvidenceLinks(
        c,
        f.evidence,
        ack.record,
      )
    ).linksRevision,
    1,
  );
  assert.deepEqual(await f.repo.loadEvidenceLinks(c), before);
});

test("owning review captures source/context/selection before waiting and acquires its checked lock before history reads", async (t) => {
  const f = await linkFixture(t),
    ack = await f.repo.recordEvidenceLinks(
      c,
      0,
      f.evidence,
      f.command,
      "links",
    );
  let release!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    trace: string[] = [];
  const db: Database = {
    close: async () => {},
    transaction: async (fn) => {
      await gate;
      return f.db.transaction((q) =>
        fn({
          query: async <T>(sql: string, values?: unknown[]) => {
            trace.push(sql);
            return q.query<T>(sql, values);
          },
        }),
      );
    },
  };
  const store = new KnowledgeRepository(db, f.policy),
    source = structuredClone(f.evidence),
    context = structuredClone(c),
    selected = structuredClone(ack.record);
  const pending = store.reviewEvidenceLinks(context, source, selected);
  Object.assign(context, { purpose: "other" });
  Object.assign(source.representations[0]!, { text: "changed" });
  Object.assign(selected, { revision: 99 });
  release();
  const view = await pending;
  assert.equal(view.review.revision.ref.revision, 1);
  const firstRead = trace.findIndex((s) =>
    s.includes("FROM public.evidence_record"),
  );
  const checkedAudit = trace.findIndex((s) =>
    s.includes("INSERT INTO public.evidence_audit"),
  );
  assert.ok(
    checkedAudit >= 0 && firstRead > checkedAudit,
    "Owning checked audit/lock must precede both history reads",
  );
});

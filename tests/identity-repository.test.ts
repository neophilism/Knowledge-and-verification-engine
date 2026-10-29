import { createEvidenceState } from "@accountability/evidence";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { scoped } from "@accountability/evidence-sql/database";
import type { Database } from "@accountability/evidence-sql/database";
import { MembershipRegistry } from "@accountability/identity-policy/membership";
import {
  KnowledgeRepository,
  KNOWLEDGE_KIND,
  KNOWLEDGE_KEY,
} from "../src/repository.ts";
import {
  IdentityKnowledgeRepository,
  KNOWLEDGE_RESOURCE_ID,
} from "../src/identity-repository.ts";
import type { Context } from "../src/contracts.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "knowledge",
  actor: { id: "owner", kind: "human", roles: ["owner"] },
  purpose: "review",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
const q = {
  id: "entity",
  expectedRevision: 0,
  value: {
    type: "entity" as const,
    label: "Fictional person",
    category: "person" as const,
    description: "Unresolved",
  },
};
async function fixture(t: test.TestContext) {
  const hooks: { identity: (() => void) | null } = { identity: null };
  async function database(name: string): Promise<Database> {
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
      `CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO ${name}; SET SESSION AUTHORIZATION ${name}`,
    );
    t.after(() => pg.close());
    return {
      transaction: (fn) =>
        pg
          .transaction((query) =>
            fn({
              query: async <T>(s: string, v?: unknown[]) => ({
                rows: (await query.query(s, v)).rows as T[],
              }),
            }),
          )
          .then((x) => {
            if (name === "identity_login") hooks.identity?.();
            return x;
          }),
      close: () => pg.close(),
    };
  }
  const identity = await database("identity_login"),
    knowledge = await database("knowledge_login");
  const membership = new MembershipRegistry(
    identity,
    {
      tenantId: c.tenantId,
      projectId: c.projectId,
      bootstrapOwnerIds: ["owner"],
    },
    () => c.now,
  );
  await membership.initialize(c, "init");
  const policy = {
    resourceId: KNOWLEDGE_RESOURCE_ID,
    memberIds: ["owner"],
    purposes: [c.purpose],
    actions: ["investigate" as const],
  };
  const repo = new KnowledgeRepository(knowledge, {
    tenantId: c.tenantId,
    projectId: c.projectId,
    humanIds: ["owner"],
    purpose: c.purpose,
  });
  const fixed = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    purpose: c.purpose,
  };
  return {
    identity,
    knowledge,
    membership,
    policy,
    repo,
    hooks,
    facade: new IdentityKnowledgeRepository(repo, membership, fixed),
    fixed,
  };
}
test("separate owning DBs and current default-deny resource policy gate all Knowledge access", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.facade.append(c, 0, q, "first"), {
    code: "identity_unavailable",
  });
  assert.equal((await f.repo.load(c)).revision, 0);
  await f.membership.setResourcePolicy(c, 0, f.policy, "allow");
  const ack = await f.facade.append(
    { ...c, actor: { ...c.actor, roles: [] } },
    0,
    q,
    "first",
  );
  assert.equal(ack.record.id, "entity");
  assert.equal((await f.facade.load(c)).revision, 1);
  await scoped(f.identity, c, async (tx) =>
    assert.equal(await tx.get(KNOWLEDGE_KIND, KNOWLEDGE_KEY), null),
  );
  await scoped(f.knowledge, c, async (tx) =>
    assert.equal((await tx.list("identity-membership")).length, 0),
  );
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, memberIds: [] },
    "revoke",
  );
  await assert.rejects(f.facade.append(c, 0, q, "first"), {
    code: "identity_unavailable",
  });
  assert.equal((await f.repo.load(c)).revision, 1);
});
test("stored demotion denies forged host roles even before historical replay", async (t) => {
  const f = await fixture(t);
  await f.membership.setResourcePolicy(c, 0, f.policy, "allow");
  await f.facade.append(c, 0, q, "first");
  await f.membership.apply(
    c,
    1,
    { type: "set-member", id: "second", kind: "human", roles: ["owner"] },
    "second",
  );
  await f.membership.apply(
    { ...c, actor: { ...c.actor, id: "second" } },
    2,
    { type: "set-member", id: "owner", kind: "human", roles: ["viewer"] },
    "demote",
  );
  await assert.rejects(f.facade.append(c, 0, q, "first"), {
    code: "identity_unavailable",
  });
  assert.equal((await f.repo.load(c)).revision, 1);
});
test("late cancelled or lost Identity SQL acknowledgements cannot start Knowledge writes", async (t) => {
  const f = await fixture(t);
  await f.membership.setResourcePolicy(c, 0, f.policy, "allow");
  const controller = new AbortController();
  f.hooks.identity = () => controller.abort();
  await assert.rejects(f.facade.append(c, 0, q, "cancel", controller.signal), {
    code: "identity_unavailable",
  });
  f.hooks.identity = () => {
    throw Error("private Identity driver detail");
  };
  await assert.rejects(f.facade.append(c, 0, q, "lost"), {
    code: "identity_unavailable",
    message: "Current Identity observation unavailable",
  });
  f.hooks.identity = () => {
    const until = performance.now() + 30;
    while (performance.now() < until) {}
  };
  const bounded = new IdentityKnowledgeRepository(
    f.repo,
    f.membership,
    f.fixed,
    10,
  );
  await assert.rejects(bounded.append(c, 0, q, "late"), {
    code: "identity_unavailable",
  });
  assert.equal((await f.repo.load(c)).revision, 0);
});
test("caller mutations and malformed host profiles cannot change captured command or fixed bindings", async (t) => {
  const f = await fixture(t);
  await f.membership.setResourcePolicy(c, 0, f.policy, "allow");
  const command = structuredClone(q),
    context = structuredClone(c);
  const pending = f.facade.append(context, 0, command, "first");
  command.id = "mutated";
  Object.assign(context.actor, { id: "second" });
  assert.equal((await pending).record.id, "entity");
  for (const bad of [
    { ...c, purpose: "other" },
    { ...c, projectId: "foreign" },
    { ...c, actor: { ...c.actor, kind: "agent" as const } },
  ])
    await assert.rejects(f.facade.load(bad));
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(f.facade.load(c, stop.signal), {
    code: "identity_unavailable",
  });
  assert.equal((await f.repo.load(c)).revision, 1);
});

test("pair methods use current Identity policy on every invocation including cached replay", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.facade.loadEntityIdentities(c), {
    code: "identity_unavailable",
  });
  await f.membership.setResourcePolicy(c, 0, f.policy, "allow");
  const left = (await f.facade.append(c, 0, { ...q, id: "a" }, "a")).record,
    right = (await f.facade.append(c, 1, { ...q, id: "b" }, "b")).record;
  const input = {
    left,
    right,
    expectedRevision: 0,
    decision: "same" as const,
    rationale: "Explicit unverified fixture judgment",
  };
  const ack = await f.facade.recordEntityIdentity(c, 0, input, "pair");
  assert.equal(ack.record.revision, 1);
  assert.equal((await f.facade.loadEntityIdentities(c)).revision, 1);
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, actions: [] },
    "deny",
  );
  await assert.rejects(f.facade.recordEntityIdentity(c, 0, input, "pair"), {
    code: "identity_unavailable",
  });
  await assert.rejects(f.facade.loadEntityIdentities(c), {
    code: "identity_unavailable",
  });
  assert.equal((await f.repo.loadEntityIdentities(c)).revision, 1);
});

test("link methods require fresh Identity policy including replay; empty set never supplies evidence", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.facade.loadEvidenceLinks(c), {
    code: "identity_unavailable",
  });
  await f.membership.setResourcePolicy(c, 0, f.policy, "allow");
  const claim = (
    await f.facade.append(
      c,
      0,
      {
        id: "claim",
        expectedRevision: 0,
        value: {
          type: "claim",
          text: "Unverified fixture",
          subjectRefs: [],
          time: { earliest: null, latest: null },
          accountType: "observation",
          limitations: [],
          assessment: null,
          proceduralPosture: null,
          editorialApproval: null,
        },
      },
      "claim",
    )
  ).record;
  const command = { claim, expectedRevision: 0, links: [] };
  await f.facade.recordEvidenceLinks(
    c,
    0,
    createEvidenceState(c),
    command,
    "links",
  );
  const view = await f.facade.loadEvidenceLinks(c);
  assert.equal(view.revision, 1);
  assert.equal(view.state.records[0]!.links.length, 0);
  const reviewed = await f.facade.reviewEvidenceLinks(
    c,
    createEvidenceState(c),
    view.state.records[0]!.ref,
  );
  assert.equal(reviewed.linksRevision, 1);
  assert.equal(reviewed.review.revision.links.length, 0);
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, actions: [] },
    "deny",
  );
  await assert.rejects(
    f.facade.recordEvidenceLinks(
      c,
      0,
      createEvidenceState(c),
      command,
      "links",
    ),
    { code: "identity_unavailable" },
  );
  await assert.rejects(f.facade.loadEvidenceLinks(c), {
    code: "identity_unavailable",
  });
  await assert.rejects(
    f.facade.reviewEvidenceLinks(
      c,
      createEvidenceState(c),
      view.state.records[0]!.ref,
    ),
    { code: "identity_unavailable" },
  );
});

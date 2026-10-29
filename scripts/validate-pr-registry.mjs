import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const v = JSON.parse(readFileSync("registry/prs.json", "utf8"));
const plan = JSON.parse(
  readFileSync("docs/approved-design/development_backlog.json", "utf8"),
);
const catalog = JSON.parse(
  readFileSync("docs/approved-design/engine_catalog.json", "utf8"),
);
assert.equal(v.repository, "neophilism/Knowledge-and-verification-engine");
assert.equal(v.planVerified, true);
assert.equal(plan.tasks.length, 122);
assert.equal(catalog.engines.length, 15);
const expected = plan.tasks
  .filter((t) => t.engines.includes("E07"))
  .map((t) => t.id);
assert.deepEqual(
  v.units.map((u) => u.id),
  expected,
);
assert.equal(v.plannedPrCount, v.units.length);
for (const u of v.units) {
  const original = plan.tasks.find((t) => t.id === u.id);
  assert.deepEqual(u.dependsOn, original.dependencies);
  assert(u.implementationStatus);
}
console.log(
  "Valid Knowledge registry:15 engines/122 original tasks; owning E07 task IDs/dependencies preserved; implementation partial",
);

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const evidencePin = "c9aafd0cc7d655e4dc3f8b5b8b833ef102d4cf2b";
assert.equal(
  pkg.dependencies["@accountability/evidence"],
  "git+https://github.com/neophilism/Evidence-Storage-and-Provenance-Engine.git#" +
    evidencePin,
);
assert(
  lock.packages["node_modules/@accountability/evidence"].resolved.endsWith(
    "#" + evidencePin,
  ),
);
console.log(
  "Evidence domain SDK pinned; persistence remains separate and unimplemented",
);

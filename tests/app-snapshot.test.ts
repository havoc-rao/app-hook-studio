import { test, TestContext } from "node:test";
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256 } from "../src/core/hash";
import {
  beginSnapshot,
  checkSnapshotInstall,
  finishSnapshot,
  restoreSnapshot,
  snapshotDirectory,
  withSnapshotLock,
} from "../src/application/app-snapshot";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp("/private/tmp/ahs-snapshot-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, "Fixture.app"),
    resource = path.join(root, "resource.js"),
    keys = path.join(root, "keys.json");
  await fs.writeFile(resource, "exact original\r\n");
  return {
    app,
    resource,
    keys,
    targets: [
      { target: resource, title: "resource", after: sha256("patched") },
      { target: keys, title: "keys", after: sha256("[]") },
    ],
  };
}

test("snapshot restores exact bytes and absence; repeated install requires restore and baseline survives reinstall", async (t) => {
  const f = await fixture(t);
  await withSnapshotLock(f.app, () => beginSnapshot(f.app, f.targets));
  await fs.writeFile(f.resource, "patched");
  await fs.writeFile(f.keys, "[]");
  await finishSnapshot(f.app);
  await assert.rejects(checkSnapshotInstall(f.app), /Restore/);
  await withSnapshotLock(f.app, () => restoreSnapshot(f.app, () => {}));
  assert.equal(await fs.readFile(f.resource, "utf8"), "exact original\r\n");
  await assert.rejects(fs.stat(f.keys), { code: "ENOENT" });
  await checkSnapshotInstall(f.app);
  const before = await fs.readFile(path.join(snapshotDirectory(f.app), "0.before"));
  await withSnapshotLock(f.app, () => beginSnapshot(f.app, f.targets));
  assert.deepEqual(await fs.readFile(path.join(snapshotDirectory(f.app), "0.before")), before);
  await withSnapshotLock(f.app, () => restoreSnapshot(f.app, () => {}));
});

test("all destinations and backups are validated before recovery; interruption can resume", async (t) => {
  const f = await fixture(t);
  await withSnapshotLock(f.app, () => beginSnapshot(f.app, f.targets));
  await fs.writeFile(f.resource, "patched");
  await fs.writeFile(f.keys, "user change");
  await assert.rejects(
    restoreSnapshot(f.app, () => {}),
    /修改/,
  );
  assert.equal(await fs.readFile(f.resource, "utf8"), "patched");
  await fs.writeFile(f.keys, "[]");
  await fs.writeFile(path.join(snapshotDirectory(f.app), "0.before"), "corrupt");
  await assert.rejects(
    restoreSnapshot(f.app, () => {}),
    /备份/,
  );
  await fs.writeFile(path.join(snapshotDirectory(f.app), "0.before"), "exact original\r\n");
  await assert.rejects(
    restoreSnapshot(f.app, () => {
      throw new Error("interrupt");
    }),
    /interrupt/,
  );
  assert.equal(await fs.readFile(f.resource, "utf8"), "exact original\r\n");
  await restoreSnapshot(f.app, () => {});
  await assert.rejects(fs.stat(f.keys), { code: "ENOENT" });
});

test("parallel install and restore cannot share a snapshot lock", async (t) => {
  const f = await fixture(t);
  await withSnapshotLock(f.app, async () => {
    await assert.rejects(
      withSnapshotLock(f.app, async () => {}),
      /锁/,
    );
  });
});

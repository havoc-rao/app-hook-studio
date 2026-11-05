import { promises as fs } from "node:fs";
import path from "node:path";
import { appBackupRoot } from "../core/engine";
import { sha256 } from "../core/hash";
import { isMissing, writeAtomic } from "../core/storage";

export type SnapshotTarget = { target: string; title: string; after: string | null };
type Entry = SnapshotTarget & { before: string | null; mode: number; backup: string };
type Snapshot = {
  schema: 1;
  appPath: string;
  phase: "installing" | "installed" | "restoring" | "restored";
  entries: Entry[];
};
export const snapshotDirectory = (appPath: string) => path.join(appBackupRoot(appPath), "whole-app");
async function bytes(file: string) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`目标不是普通文件，拒绝处理：${file}`);
    return await fs.readFile(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
const digest = (value: Buffer | null) => (value === null ? null : sha256(value));
export async function fileDigest(file: string) {
  return digest(await bytes(file));
}
async function read(appPath: string): Promise<Snapshot | undefined> {
  const raw = await bytes(path.join(snapshotDirectory(appPath), "state.json"));
  if (!raw) return;
  const value = JSON.parse(raw.toString()) as Snapshot;
  if (
    value.schema !== 1 ||
    value.appPath !== appPath ||
    !Array.isArray(value.entries) ||
    !["installing", "installed", "restoring", "restored"].includes(value.phase) ||
    value.entries.some(
      (entry, index) =>
        !path.isAbsolute(entry.target) ||
        entry.backup !== `${index}.before` ||
        !Number.isInteger(entry.mode) ||
        entry.mode < 0 ||
        entry.mode > 0o777 ||
        ![entry.before, entry.after].every((hash) => hash === null || /^[a-f0-9]{64}$/.test(hash)),
    )
  )
    throw new Error("完整恢复记录无效，保留现场与备份。");
  if (new Set(value.entries.map((entry) => entry.target)).size !== value.entries.length)
    throw new Error("完整恢复记录包含重复目标。");
  return value;
}
async function save(value: Snapshot) {
  await writeAtomic(
    path.join(snapshotDirectory(value.appPath), "state.json"),
    JSON.stringify(value, null, 2) + "\n",
  );
}
async function validate(value: Snapshot, restoredOnly = false) {
  for (const entry of value.entries) {
    const backup = await bytes(path.join(snapshotDirectory(value.appPath), entry.backup));
    if (digest(backup) !== entry.before) throw new Error(`${entry.title}：首次备份校验失败，未恢复。`);
    const current = await fileDigest(entry.target);
    if (current !== entry.before && (restoredOnly || current !== entry.after))
      throw new Error(`${entry.title}：文件在安装后被修改，拒绝覆盖；保留现场与备份。`);
  }
}
export async function checkSnapshotInstall(appPath: string) {
  const value = await read(appPath);
  if (!value) return;
  await validate(value, value.phase === "restored");
  if (value.phase !== "restored") throw new Error("已有未恢复的安装记录，请先 Restore，再 Install。");
}
/** Exclusive lock covers both the snapshot and every target mutation. Never steal an existing lock. */
export async function withSnapshotLock<T>(appPath: string, work: () => Promise<T>): Promise<T> {
  const directory = snapshotDirectory(appPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, "operation.lock");
  let handle;
  try {
    handle = await fs.open(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("安装／恢复锁已存在；请等待操作完成。异常退出时请先检查记录，不自动接管。");
    throw error;
  }
  try {
    return await work();
  } finally {
    await handle.close();
    await fs.unlink(lock);
  }
}
/** Must run after all preflight checks, before the first target write. */
export async function beginSnapshot(appPath: string, targets: SnapshotTarget[]) {
  await checkSnapshotInstall(appPath);
  const previous = await read(appPath);
  if (
    previous &&
    (previous.entries.length !== targets.length ||
      previous.entries.some((e, i) => e.target !== targets[i].target))
  )
    throw new Error("目标文件集合已变化，不能复用首次备份；请检查原恢复记录。");
  const entries: Entry[] = [];
  for (const [index, target] of targets.entries()) {
    const data = await bytes(target.target);
    const before = digest(data),
      backup = `${index}.before`;
    const mode = data === null ? 0o600 : (await fs.stat(target.target)).mode & 0o777;
    if (!previous && data !== null) {
      const destination = path.join(snapshotDirectory(appPath), backup);
      try {
        await fs.writeFile(destination, data, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || (await fileDigest(destination)) !== before)
          throw error;
      }
    }
    entries.push({ ...target, before, mode: previous?.entries[index].mode ?? mode, backup });
  }
  const value: Snapshot = { schema: 1, appPath, phase: "installing", entries };
  await save(value);
  await validate(value);
}
export async function finishSnapshot(appPath: string) {
  const value = (await read(appPath))!;
  for (const entry of value.entries)
    if ((await fileDigest(entry.target)) !== entry.after)
      throw new Error(`${entry.title}：安装后摘要与计划不符，保留恢复记录。`);
  value.phase = "installed";
  await save(value);
}
export async function inspectSnapshotRestore(appPath: string) {
  const value = await read(appPath);
  if (!value)
    throw new Error(
      "没有完整安装快照。旧版资源备份不能证明快捷键的完整原状，不能声称完全恢复；请保留旧备份并检查迁移。",
    );
  await validate(value);
  return value;
}
export async function restoreSnapshot(appPath: string, onStep: (title: string) => void) {
  const value = await inspectSnapshotRestore(appPath);
  value.phase = "restoring";
  await save(value);
  for (const entry of value.entries) {
    // Revalidate the entire remaining state before each write, including backups.
    await validate(value);
    if ((await fileDigest(entry.target)) !== entry.before) {
      if (entry.before === null) await fs.unlink(entry.target);
      else {
        const original = await fs.readFile(path.join(snapshotDirectory(appPath), entry.backup));
        await writeAtomic(entry.target, original.toString("utf8"), entry.mode);
      }
    }
    if ((await fileDigest(entry.target)) !== entry.before)
      throw new Error(`${entry.title}：恢复后校验失败。`);
    onStep(entry.title);
  }
  value.phase = "restored";
  await save(value);
}

export type LegacySnapshotTarget = SnapshotTarget & { original: string | null; before: string | null };
export async function hasSnapshot(appPath: string) {
  return !!(await read(appPath));
}
export async function importLegacySnapshot(appPath: string, targets: LegacySnapshotTarget[]) {
  if (await read(appPath)) throw new Error("完整快照已存在，请重新检查。");
  for (const item of targets) {
    if (
      (await fileDigest(item.target)) !== item.after ||
      (item.original && (await fileDigest(item.original)) !== item.before)
    )
      throw new Error(`${item.title}：迁移前文件已变化，未恢复。`);
  }
  const entries: Entry[] = [];
  for (const [index, item] of targets.entries()) {
    const backup = `${index}.before`;
    if (item.original) {
      const data = await fs.readFile(item.original);
      if (sha256(data) !== item.before) throw new Error("旧备份发生变化。");
      const destination = path.join(snapshotDirectory(appPath), backup);
      try {
        await fs.writeFile(destination, data, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          (await fileDigest(destination)) !== item.before
        )
          throw error;
      }
    }
    entries.push({
      target: item.target,
      title: item.title,
      after: item.after,
      before: item.before,
      backup,
      mode: item.after === null ? 0o600 : (await fs.stat(item.target)).mode & 0o777,
    });
  }
  const value: Snapshot = { schema: 1, appPath, phase: "installed", entries };
  await validate(value);
  await save(value);
}

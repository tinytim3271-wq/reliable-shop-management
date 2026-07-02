import * as fs from "node:fs/promises";
import * as path from "node:path";

const baseDir = path.resolve(process.cwd(), ".local", "feature-data");

async function ensureBaseDir(): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true });
}

function filePath(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(baseDir, safeName);
}

export async function readJsonFile<T>(name: string, fallback: T): Promise<T> {
  await ensureBaseDir();
  const fullPath = filePath(name);
  try {
    const raw = await fs.readFile(fullPath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    const asNodeErr = err as NodeJS.ErrnoException;
    if (asNodeErr.code === "ENOENT") return fallback;
    throw err;
  }
}

export async function writeJsonFile<T>(name: string, value: T): Promise<void> {
  await ensureBaseDir();
  const fullPath = filePath(name);
  const tmpPath = `${fullPath}.tmp`;
  const raw = JSON.stringify(value, null, 2);
  await fs.writeFile(tmpPath, raw, "utf8");
  await fs.rename(tmpPath, fullPath);
}

export async function updateJsonFile<T>(
  name: string,
  fallback: T,
  updater: (current: T) => T,
): Promise<T> {
  const current = await readJsonFile(name, fallback);
  const next = updater(current);
  await writeJsonFile(name, next);
  return next;
}

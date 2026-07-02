import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readdir, rm } from "node:fs/promises";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(artifactDir, "../..");

async function findVirtualStorePackageDir(packageName) {
  const virtualStoreDir = path.join(rootDir, "node_modules", ".pnpm");
  const entries = await readdir(virtualStoreDir, { withFileTypes: true });
  const prefix = `${packageName}@`;
  const match = entries.find((entry) => entry.isDirectory() && entry.name.startsWith(prefix));

  if (!match) {
    throw new Error(`No virtual store entry found for ${packageName}`);
  }

  return path.join(virtualStoreDir, match.name, "node_modules", packageName);
}

async function resolveEsbuild() {
  // Resolve esbuild: try multiple locations
  // 1. Artifact node_modules (full workspace)
  // 2. Root node_modules (dev dependencies)  
  // 3. pnpm virtual store (production builds)
  let esbuildModule;
  let esbuildPluginPino;
  let globalRequire;

  // Try artifact first
  try {
    globalRequire = createRequire(path.join(artifactDir, "package.json"));
    esbuildModule = globalRequire("esbuild");
    esbuildPluginPino = globalRequire("esbuild-plugin-pino");
    return { esbuild: esbuildModule.build || esbuildModule, esbuildPluginPino, globalRequire };
  } catch (e1) {
    // Try root
    try {
      globalRequire = createRequire(path.join(rootDir, "package.json"));
      esbuildModule = globalRequire("esbuild");
      esbuildPluginPino = globalRequire("esbuild-plugin-pino");
      return { esbuild: esbuildModule.build || esbuildModule, esbuildPluginPino, globalRequire };
    } catch (e2) {
      // Try virtual store via dynamic import
      try {
        const esbuildPackageDir = await findVirtualStorePackageDir("esbuild");
        const esbuildVStorePath = path.join(esbuildPackageDir, "lib", "main.js");
        const fileUrl = pathToFileURL(esbuildVStorePath).href;
        esbuildModule = await import(fileUrl);

        try {
          const pluginPackageDir = await findVirtualStorePackageDir("esbuild-plugin-pino");
          globalRequire = createRequire(path.join(pluginPackageDir, "package.json"));
          esbuildPluginPino = globalRequire("esbuild-plugin-pino");
        } catch {
          globalRequire = createRequire(path.join(rootDir, "package.json"));
          console.warn("esbuild-plugin-pino not found, pino logging may not work");
          esbuildPluginPino = null;
        }

        return { esbuild: esbuildModule.build || esbuildModule, esbuildPluginPino, globalRequire };
      } catch (e3) {
        console.error(`Failed to resolve esbuild:\n  artifact: ${e1.message}\n  root: ${e2.message}\n  vstore: ${e3.message}`);
        process.exit(1);
      }
    }
  }
}

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
async function buildAll() {
  const { esbuild, esbuildPluginPino, globalRequire } = await resolveEsbuild();
  
  globalThis.require = globalRequire;

  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      // stripe-replit-sync ships SQL migration files it locates at runtime via
      // path.resolve(__dirname, "./migrations"). If bundled, __dirname points at
      // dist/ and the migrations are silently skipped (stripe schema stays
      // empty). Keep it external so it loads from node_modules where the SQL
      // files exist.
      "stripe-replit-sync",
      // @electric-sql/pglite (desktop embedded DB) ships a .wasm runtime and a
      // pglite.data FS image it loads at runtime relative to its own package
      // location. If bundled, that resolution points at dist/ and PGlite fails
      // with ENOENT on dist/pglite.data. Keep it external so it loads from
      // node_modules where its assets live (the desktop packager ships it).
      "@electric-sql/*",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
      // pdf-parse v2 wraps pdfjs-dist, which loads its worker/standard-font
      // assets at runtime relative to its own package location. Bundling breaks
      // that resolution, so keep both external and load them from node_modules.
      "pdf-parse",
      "pdfjs-dist",
    ],
    sourcemap: "linked",
    plugins: esbuildPluginPino ? [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] })
    ] : [],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROPS_FILE = join(ROOT, "deploy.properties");

// sw/strategies.js is stamped on upload so every deploy revs the SW cache name.
const STAMP_FILE = "client/sw/strategies.js";
function stampCacheName(content) {
  return content.replace(/self\.CACHE_NAME\s*=\s*"[^"]*"/, `self.CACHE_NAME = "newspop-${Date.now()}"`);
}

function loadProps() {
  if (!existsSync(PROPS_FILE)) {
    throw new Error(`Missing ${PROPS_FILE} — copy deploy.properties.example`);
  }
  const out = {};
  for (const line of readFileSync(PROPS_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else files.push(p);
  }
  return files;
}

function buildFileSet() {
  const files = [];
  const add = (p) => {
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else files.push(p);
  };
  for (const entry of ["app.js", "lib", "client", "feeds.json", "bias-db.json", "manifest.webmanifest", "package.json", "embed_server.py", "icons", "logos"]) {
    const p = join(ROOT, entry);
    if (existsSync(p)) add(p);
  }
  return files;
}

function remoteInfo(remoteUrl, user, password) {
  try {
    const args = ["-sS", "-I", remoteUrl, "--user", `${user}:${password}`];
    const out = execFileSync("curl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const size = Number((out.match(/Content-Length: (\d+)/i) || [])[1] || "0");
    const dateStr = (out.match(/Last-Modified: (.+)/i) || [])[1];
    const date = dateStr ? Date.parse(dateStr) : NaN;
    return { size: Number.isFinite(size) ? size : null, date: Number.isFinite(date) ? date : null };
  } catch {
    return { size: null, date: null }; // file missing or server doesn't report
  }
}

function upload(file, remoteHost, user, password, remoteDir) {
  const rel = relative(ROOT, file).split(sep).join("/");
  let localSize, localMtime;
  try {
    const st = statSync(file);
    localSize = st.size;
    localMtime = st.mtimeMs;
  } catch {
    console.log(`  ${rel} -> skipped (missing locally)`);
    return;
  }
  const remoteUrl = remoteDir
    ? `ftp://${remoteHost}/${remoteDir}/${rel}`
    : `ftp://${remoteHost}/${rel}`;
  // The SW only re-installs when sw.js's imported scripts change, so stamp a
  // fresh cache version on every deploy. Done in-memory; the local file stays
  // untouched so git stays clean.
  // Same-size edits (e.g. a version bump 1.0.0 -> 1.0.2) would otherwise be
  // skipped by the size/date check below, so always upload package.json.
  const ALWAYS_UPLOAD = ["package.json"];
  if (rel === STAMP_FILE) {
    const body = stampCacheName(readFileSync(file, "utf8"));
    const args = ["-sS", "--ftp-create-dirs", "-T", "-", remoteUrl, "--user", `${user}:${password}`];
    const out = execFileSync("curl", args, { encoding: "utf8", input: body, stdio: ["ignore", "pipe", "pipe"] });
    console.log(`  ${rel} -> ${remoteUrl} (${body.length} bytes, stamped cache version)`);
    if (out.trim()) console.log(out.trim());
    return;
  }
  if (ALWAYS_UPLOAD.includes(rel)) {
    const args = ["-sS", "--ftp-create-dirs", "-T", file, remoteUrl, "--user", `${user}:${password}`];
    const out = execFileSync("curl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    console.log(`  ${rel} -> ${remoteUrl} (${statSync(file).size} bytes, forced upload)`);
    if (out.trim()) console.log(out.trim());
    return;
  }
  const rInfo = remoteInfo(remoteUrl, user, password);
  const upToDate =
    rInfo.size !== null &&
    rInfo.size === localSize &&
    (rInfo.date === null || rInfo.date >= localMtime);
  if (upToDate) {
    console.log(`  ${rel} -> skipped (up to date)`);
    return;
  }
  const args = ["-sS", "--ftp-create-dirs", "-T", file, remoteUrl, "--user", `${user}:${password}`];
  const out = execFileSync("curl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  console.log(`  ${rel} -> ${remoteUrl} (${localSize} bytes)`);
  if (out.trim()) console.log(out.trim());
}

const props = loadProps();
const host = props.host;
const user = props.user;
const password = props.password;
if (!host || !user || !password) {
  throw new Error("deploy.properties: missing host/user/password");
}
const remoteDir = (props.remoteDir || "").replace(/^\/+|\/+$/g, "");

const files = buildFileSet().sort((a, b) => {
  const ra = relative(ROOT, a).split(sep).join("/");
  const rb = relative(ROOT, b).split(sep).join("/");
  if (ra === STAMP_FILE) return -1;
  if (rb === STAMP_FILE) return 1;
  const d = statSync(b).mtimeMs - statSync(a).mtimeMs;
  return d !== 0 ? d : ra.localeCompare(rb);
});
console.log(`Deploying ${files.length} file(s) to ftp://${host}/${remoteDir}`);
for (const f of files) upload(f, host, user, password, remoteDir);
console.log("Done.");
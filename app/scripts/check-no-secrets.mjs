// Fails if dist/ contains any secret from the repo-root .env (the testnet
// burner seeds) or anything shaped like a Stellar secret seed (S + 55 base32).
// Run after `npm run build`; `npm run deploy:pages` runs it before uploading.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(appDir, "dist");
const envFile = path.resolve(appDir, "..", ".env");

const secrets = [];
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
    if (m && (/SECRET|TOKEN|KEY|PASS/.test(m[1]) || /^S[A-Z2-7]{55}$/.test(m[2]))) secrets.push([m[1], m[2]]);
  }
}
const files = [];
const walk = (d) => readdirSync(d).forEach((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : files.push(path.join(d, f))));
if (!existsSync(dist)) throw new Error("no dist/; run npm run build first");
walk(dist);

const problems = [];
for (const f of files) {
  const body = readFileSync(f, "latin1");
  for (const [name, value] of secrets) if (body.includes(value)) problems.push(`${path.relative(appDir, f)}: contains ${name}`);
  if (/(?<![A-Z2-7])S[A-Z2-7]{55}(?![A-Z2-7])/.test(body)) problems.push(`${path.relative(appDir, f)}: Stellar secret-seed-shaped string`);
  if (body.includes("Demo account (testnet burner)")) problems.push(`${path.relative(appDir, f)}: demo signer UI is in the bundle`);
}
if (problems.length) {
  console.error(`check-no-secrets: FAIL\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-no-secrets: ok (${files.length} files, ${secrets.length} .env secrets, no S-seeds)`);

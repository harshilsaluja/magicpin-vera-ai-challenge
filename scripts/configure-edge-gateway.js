const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "wrangler.toml");
const source = fs.readFileSync(sourcePath, "utf8");
const idMatch = source.match(/^database_id\s*=\s*"([^"]+)"/m);

if (!idMatch || idMatch[1] === "replace-with-your-d1-database-id") {
  throw new Error("wrangler.toml must contain the real D1 database_id first");
}

const backend = source.replace(/^name\s*=\s*"[^"]+"/m, 'name = "vera-challenge-backend"');
fs.writeFileSync(path.join(root, "wrangler.backend.toml"), backend);

const gateway = `name = "vera-challenge"
main = "cloudflare_gateway/index.mjs"
compatibility_date = "2026-09-25"
workers_dev = true

[[d1_databases]]
binding = "DB"
database_name = "vera-production"
database_id = "${idMatch[1]}"

[[services]]
binding = "VERA_BACKEND"
service = "vera-challenge-backend"
`;
fs.writeFileSync(path.join(root, "wrangler.gateway.toml"), gateway);

console.log("Created wrangler.backend.toml and wrangler.gateway.toml.");

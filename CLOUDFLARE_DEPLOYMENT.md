# Deploy Vera with Cloudflare Workers, Python, and D1

This is the recommended free deployment. The original Node/SQLite implementation remains a tested fallback; the public target uses a lightweight JavaScript gateway, a native Python Worker, and D1. The native handler avoids the cold-start instability of a large framework bundle while preserving the same validation and API behavior.

```text
Magicpin judge -> JavaScript edge gateway -> native Python Worker -> D1
                         |                         |
                         -> fast health route     -> deterministic Vera engine
```

No external LLM, Docker container, VM, open port, or custom domain is required.

## Prerequisites

1. Create and verify a free Cloudflare account.
2. Install Node.js 24 and Python 3.13 or later.
3. Install `uv` if it is not already available:

   ```powershell
   python -m pip install uv
   ```

4. Open PowerShell in the repository and install the locked Python dependencies:

   ```powershell
   uv sync
   ```

## 1. Sign in to Cloudflare

```powershell
uv run pywrangler login
```

The browser opens a Cloudflare authorization page. Sign in and select **Allow**. Do not put API tokens in the repository.

## 2. Create the production database

```powershell
uv run pywrangler d1 create vera-production
```

Copy the `database_id` printed by the command. In `wrangler.toml`, replace:

```toml
database_id = "replace-with-your-d1-database-id"
```

with the real ID. The database ID is configuration, not a password.

## 3. Verify the submission identity

Check the `[vars]` section in `wrangler.toml`:

```toml
TEAM_NAME = "Harshil Saluja"
TEAM_MEMBER = "Harshil Saluja"
CONTACT_EMAIL = "harshilsaluja0000@gmail.com"
SUBMITTED_AT = "2026-09-26T00:00:00Z"
```

Correct any value that does not match the challenge form before deployment.

## 4. Create the remote D1 tables

```powershell
uv run pywrangler d1 migrations apply vera-production --remote
```

Confirm the migration when prompted. It creates Vera's context, suppression, conversation, turn, and reply tables.

## 5. Deploy the Python backend and edge gateway

```powershell
node scripts/configure-edge-gateway.js
uv run --python 3.14.2 pywrangler deploy --config wrangler.backend.toml
npx.cmd wrangler@latest deploy --config wrangler.gateway.toml
```

If prompted to configure a `workers.dev` subdomain, choose a short professional name. Deployment returns a URL similar to:

```text
https://vera-challenge.<account-subdomain>.workers.dev
```

## 6. Run the judge against the public deployment

Replace the example URL with the URL printed by Cloudflare:

```powershell
$env:BOT_URL="https://vera-challenge.<account-subdomain>.workers.dev"
$env:JUDGE_ALLOW_TEARDOWN="1"
node scripts/phase6-judge.js
```

The script intentionally uploads synthetic challenge data and calls `/v1/teardown`, so run it only against this Vera deployment. The expected result is:

```json
{
  "result": "pass"
}
```

Also open:

```text
https://vera-challenge.<account-subdomain>.workers.dev/v1/healthz
https://vera-challenge.<account-subdomain>.workers.dev/v1/metadata
```

## 7. Push the migration to GitHub

After the public judge passes:

```powershell
git status
git add .
git commit -m "Add Cloudflare Python Worker, edge gateway, and D1 deployment"
git push origin main
```

Never commit `.dev.vars`, Cloudflare API tokens, passwords, or private keys. Local Worker, Python, and generated package directories are already ignored.

## Local development

Create the local schema once:

```powershell
uv run pywrangler d1 migrations apply vera-production --local
```

Start the Worker:

```powershell
uv run pywrangler dev
```

Then run the judge in another PowerShell window:

```powershell
$env:BOT_URL="http://127.0.0.1:8787"
$env:JUDGE_ALLOW_TEARDOWN="1"
node scripts/phase6-judge.js
```

## Verification already completed locally

- Original Node regression suite: 41/41 passed.
- Python unit suite: 11/11 passed.
- Full contract judge against the public edge gateway and native Python Worker: passed.
- Contexts exercised: 5 categories, 10 merchants, 15 customers, and 25 triggers.
- Eligible proactive actions validated: 24.
- Auto-reply sequence: `wait`, `wait`, `end`.
- Commitment: `send`.
- Hostility: `end`.
- Load test: 10 requests per second passed.
- Teardown: verified.

Keep the public Worker deployed until Magicpin finishes evaluation.

# Vera production deployment

The service is packaged as a single Node.js 24 container with SQLite on a persistent volume. Run exactly one application instance because SQLite locking is local to one filesystem.

## Required hosting configuration

- Build from `Dockerfile`.
- Expose the platform-provided `PORT` over HTTPS.
- Attach a persistent volume at `/app/data`.
- Keep `DATABASE_PATH=/app/data/vera.sqlite`.
- Use one replica/instance.
- Configure the liveness path as `/v1/healthz`.
- Configure the readiness path as `/v1/readyz` when the provider supports a separate readiness check.
- Allow at least 10 seconds for graceful shutdown.
- Keep the service running until evaluation is finished.

## Required environment values

Copy `.env.example`, then replace every identity placeholder:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
DATABASE_PATH=/app/data/vera.sqlite
TEAM_NAME=<your submission/team label>
TEAM_MEMBER=<your full name>
CONTACT_EMAIL=<your real email>
SUBMITTED_AT=<ISO timestamp at deployment/submission>
SHUTDOWN_TIMEOUT_MS=10000
```

Production startup deliberately fails when the database is not persistent or the identity metadata is missing/invalid.

## Local container run

Create a local `.env` from `.env.example`, fill in the four identity values, then run:

```powershell
docker compose up --build -d
docker compose ps
```

The named `vera_data` volume preserves SQLite state across container restarts.

## Pre-deployment checks

```powershell
node --test
node scripts/phase6-judge.js
node scripts/deployment-preflight.js
```

## Public verification

After the hosting provider gives an HTTPS base URL:

```powershell
$BotUrl = "https://your-public-host.example.com"
Invoke-RestMethod "$BotUrl/v1/healthz"
Invoke-RestMethod "$BotUrl/v1/readyz"
Invoke-RestMethod "$BotUrl/v1/metadata"
```

Verify that metadata contains your real name and email and reports version `1.0.0`.

To run the complete contract judge against a fresh deployment, note that it writes official test contexts and calls teardown:

```powershell
$env:BOT_URL = "https://your-public-host.example.com"
$env:JUDGE_ALLOW_TEARDOWN = "1"
node scripts/phase6-judge.js
```

Do not run remote judge mode during an active official evaluation because teardown deletes the evaluation state.

## Submission checklist

1. Confirm HTTPS works without a browser warning or redirect loop.
2. Confirm health and metadata respond in under two seconds from another network.
3. Restart the container and confirm stored context counts remain present.
4. Run the remote contract judge once on the fresh deployment.
5. Confirm health returns zero counts after that judge's teardown.
6. Submit the public base URL together with your required name, email, and phone number.
7. Leave the single instance and persistent volume running for the evaluation period.

No API key or external LLM configuration is needed for this implementation.

const baseUrl = process.env.BOT_URL?.trim().replace(/\/$/, "");

if (!baseUrl) {
  console.error("Set BOT_URL before running this script.");
  process.exit(1);
}

async function wave(size) {
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: size }, async () => {
    const requestStarted = performance.now();
    const response = await fetch(`${baseUrl}/v1/healthz`, { cache: "no-store" });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
    JSON.parse(text);
    return Math.round(performance.now() - requestStarted);
  }));
  return { total_ms: Math.round(performance.now() - started), latencies_ms: results };
}

(async () => {
  const first = await wave(20);
  const second = await wave(20);
  console.log(JSON.stringify({ status: "warmed", waves: [first, second] }, null, 2));
})().catch((error) => {
  console.error(JSON.stringify({ status: "failed", error: error.message }, null, 2));
  process.exitCode = 1;
});

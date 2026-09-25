/**
 * Weave backend, port 3001.
 *
 * The browser never calls a model provider. Everything goes through here, which
 * is what makes local providers (Ollama, LM Studio) work with no CORS setup and
 * keeps API keys out of the client bundle and out of the network tab.
 */
import express from 'express';
import { listModels, ProviderError } from './providers';
import { ConfigError, runWeave } from './weave';
import { DEFAULT_CONFIG, type WeaveConfig } from '../shared/providers';

const PORT = Number(process.env.PORT ?? 3001);
const app = express();
app.use(express.json({ limit: '4mb' }));

/** Metadata only. Reasoning text is never logged, here or anywhere else. */
function log(...parts: unknown[]): void {
  console.log(`[weave] ${new Date().toISOString()}`, ...parts);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'weave', port: PORT, defaults: DEFAULT_CONFIG });
});

/**
 * GET {baseUrl}/models, proxied. Never gates a run: the UI always allows typing
 * a model name by hand, because some models respond without appearing here.
 */
app.post('/api/models', async (req, res) => {
  const slot = req.body?.slot;
  if (!slot || typeof slot.baseUrl !== 'string') {
    res.status(400).json({ ok: false, models: [], error: 'A slot with a base URL is required.' });
    return;
  }
  const result = await listModels(slot);
  log(`models ${slot.provider} ${slot.baseUrl} -> ${result.ok ? `${result.models.length} models` : `failed: ${result.error}`}`);
  res.json({ ...result, baseUrl: slot.baseUrl });
});

/**
 * POST /api/weave — Server-Sent Events so the staged states on screen are real
 * stages, not a fake progress animation: asking -> extracting -> classifying.
 */
app.post('/api/weave', async (req, res) => {
  const question = typeof req.body?.question === 'string' ? req.body.question : '';
  const config = (req.body?.config ?? DEFAULT_CONFIG) as WeaveConfig;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    if (clientGone || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // A local model can think for minutes between stages. Keepalive comments stop
  // proxies, browsers and fetch clients from dropping an idle stream.
  res.write(': connected\n\n');
  const keepalive = setInterval(() => {
    if (!clientGone && !res.writableEnded) res.write(': keepalive\n\n');
  }, 15000);

  // Watch the RESPONSE for the disconnect, never the request: on Node 16+
  // req 'close' fires as soon as the request body has been read, which is
  // immediately here, and it would silently swallow every progress event after
  // the first — leaving the staged UI stuck on "asking".
  let clientGone = false;
  res.on('close', () => {
    clientGone = true;
    clearInterval(keepalive);
  });

  const started = Date.now();
  try {
    const result = await runWeave({
      question,
      config,
      onProgress: (event) => send('progress', event),
    });
    log(
      `run ${result.runId.slice(0, 8)} nonce=${result.nonce} ${result.totalMs}ms ` +
        `A=${result.models.a.model}(${result.models.a.claims.length} claims) ` +
        `B=${result.models.b.model}(${result.models.b.claims.length} claims) ` +
        `judge=${result.judge.model} mode=${result.judge.parseMode} ` +
        `consensus=${result.consensus.consensusByNodes}%`,
    );
    send('result', result);
  } catch (error) {
    const failure = error as Error & { detail?: string; hint?: string; slot?: string; status?: number };
    const payload = {
      message: failure.message || 'The run failed.',
      detail: failure.detail,
      hint: failure.hint,
      slot: failure.slot,
      status: failure.status,
    };
    log(`run failed after ${Date.now() - started}ms: ${payload.message}${payload.detail ? ` | ${payload.detail}` : ''}`);
    send('error', payload);
  } finally {
    clearInterval(keepalive);
    if (!res.writableEnded) res.end();
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found. Weave serves /api/health, /api/models and /api/weave.' });
});

app.listen(PORT, '127.0.0.1', () => {
  log(`backend listening on http://127.0.0.1:${PORT}`);
  log('model calls run here; the browser only ever talks to this process');
});

export { ConfigError, ProviderError };
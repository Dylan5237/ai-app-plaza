import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';

/** Loopback OpenAI-compatible chat fixture. Never used by runtime configuration. */
export async function startLlmFixture() {
  const state = {
    requests: [] as { authorization?: string; body: any }[],
    reply: (() => ({ picks: [], question: null })) as (body: any) => unknown,
    status: 200,
    delayMs: 0,
  };
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: any = {};
    try { body = JSON.parse(raw); } catch { /* record the raw request below */ }
    state.requests.push({ authorization: req.headers.authorization, body });
    if (state.delayMs) await pause(state.delayMs);
    if (state.status !== 200) {
      res.writeHead(state.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'fixture failure' }));
      return;
    }
    const reply = state.reply(body);
    const content = typeof reply === 'string' ? reply : JSON.stringify(reply);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, state, close: () => new Promise<void>(done => server.close(() => done())) };
}

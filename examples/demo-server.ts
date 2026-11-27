/**
 * Runs the demo app and a mock Acme API side by side, then walks through the flow:
 *
 *   npm run demo
 *
 * Everything runs on localhost; no real provider is contacted.
 */
import { createMockAcme } from './acme/mock-acme.js';
import { buildDemo } from './demo/app.js';

const DEMO_PORT = Number(process.env.PORT ?? 3000);
const ACME_PORT = Number(process.env.ACME_PORT ?? 4010);
const credentials = {
  clientId: 'demo-client',
  clientSecret: 'demo-secret',
  webhookSecret: 'whsec_demo',
};

const acme = createMockAcme(credentials);
const demo = buildDemo({
  ...credentials,
  acmeBaseUrl: `http://127.0.0.1:${ACME_PORT}`,
  publicUrl: `http://127.0.0.1:${DEMO_PORT}`,
  logger: true,
});

await acme.app.listen({ port: ACME_PORT, host: '127.0.0.1' });
await demo.app.listen({ port: DEMO_PORT, host: '127.0.0.1' });
demo.worker.start();

const base = `http://127.0.0.1:${DEMO_PORT}`;

// 1. OAuth: fetch follows the redirects /connect -> Acme authorize -> /oauth/callback.
const connected = await (await fetch(`${base}/connect`)).json();
console.log('\n[1] connected:', connected);

// 2. Paginated, rate-limited reads (the mock returns a 429 on every third page request).
const contacts = await (await fetch(`${base}/contacts`)).json();
console.log('\n[2] contacts:', JSON.stringify(contacts));

// 3. Webhooks: deliver one event twice; the second delivery is recognised as a duplicate.
const target = `${base}/webhooks/acme`;
const first = await acme.emitWebhook(target, { id: 'evt_1', type: 'contact.created' });
const again = await acme.emitWebhook(target, { id: 'evt_1', type: 'contact.created' });
console.log(`\n[3] webhook deliveries: first=${first} redelivery=${again}`);

await new Promise((resolve) => setTimeout(resolve, 500));
const stored = await (await fetch(`${base}/webhooks/events`)).json();
console.log('\n[4] stored events:', stored);

console.log(`\nDemo is still running on ${base} (Ctrl+C to stop).`);

const shutdown = async (): Promise<void> => {
  await demo.app.close();
  await acme.app.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

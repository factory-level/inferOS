import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import router, { type Env } from '../src/index';
import { FRAME_POLICY_HEADERS } from '../src/frame-policy';
// The frontend's Static Assets headers, which the framing-policy tests hold in step with the router.
import headersFileText from '../../workshop-frontend/public/_headers?raw';
// Imported as text so the config-integrity tests run inside workerd without filesystem access.
import wranglerConfigText from '../wrangler.jsonc?raw';

function stubFetcher(label: string): Fetcher {
  return {
    fetch: async () => new Response(label),
  } as unknown as Fetcher;
}

function makeEnv(extra: Record<string, unknown> = {}): Env {
  return {
    WORKSHOP_BACKEND: stubFetcher('backend'),
    ...extra,
  } as Env;
}

async function route(env: Env, path: string): Promise<string> {
  const req = new Request(`https://example.com${path}`);
  const res = await router.fetch!(req, env, {} as ExecutionContext);
  return res.text();
}

describe('router fetch', () => {
  it('routes /api and /blueprint-screenshot prefixes to the backend', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/api')).toBe('backend');
    expect(await route(env, '/api/workshop')).toBe('backend');
    expect(await route(env, '/blueprint-screenshot')).toBe('backend');
    expect(await route(env, '/blueprint-screenshot/abc')).toBe('backend');
  });

  it('does not treat /api-lookalike paths as backend routes', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/apiary')).toBe('assets');
    expect(await route(env, '/blueprint-screenshots')).toBe('assets');
  });

  it('routes /gatekeeper/<short> by scanning GATEKEEPER_* bindings', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_GOOGLE: stubFetcher('google'),
      GATEKEEPER_HOMEASSISTANT: stubFetcher('homeassistant'),
    });
    expect(await route(env, '/gatekeeper/google')).toBe('google');
    expect(await route(env, '/gatekeeper/google/oauth')).toBe('google');
    expect(await route(env, '/gatekeeper/homeassistant/foo')).toBe('homeassistant');
  });

  it('maps underscores in binding names to dashes in the path', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_MY_SERVICE: stubFetcher('my-service'),
    });
    expect(await route(env, '/gatekeeper/my-service')).toBe('my-service');
    expect(await route(env, '/gatekeeper/my-service/oauth')).toBe('my-service');
  });

  it('does not match gatekeeper prefixes on longer path segments', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_GOOGLE: stubFetcher('google'),
    });
    expect(await route(env, '/gatekeeper/googles')).toBe('assets');
  });

  it('serves everything else from ASSETS when the binding is present', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/')).toBe('assets');
    expect(await route(env, '/blueprints/123')).toBe('assets');
    expect(await route(env, '/gatekeeper/not-installed')).toBe('assets');
  });

  // Dev has no ASSETS binding: the backend serves the frontend from its own assets binding in
  // `run-local` mode, and in normal dev mode you open the Vite server on :3000 directly.
  it('falls through to the backend when ASSETS is absent', async () => {
    const env = makeEnv();
    expect(await route(env, '/')).toBe('backend');
    expect(await route(env, '/blueprints/123')).toBe('backend');
  });
});

/** A backend stub that records each request it receives, after reading its body. */
function recordingFetcher(): { fetcher: Fetcher; received: { req: Request; body: string }[] } {
  const received: { req: Request; body: string }[] = [];
  const fetcher = {
    fetch: async (req: Request) => {
      received.push({ req, body: await req.text() });
      return new Response('backend');
    },
  } as unknown as Fetcher;
  return { fetcher, received };
}

describe('router version header', () => {
  const HEADER = 'Cloudflare-OS-Router-Version';
  const versioned = { CF_VERSION_METADATA: { id: 'v', tag: 'r42:abcd1234', timestamp: '' } };

  it('carries the router tag on every request forwarded to the backend', async () => {
    const withAssets = recordingFetcher();
    const prod = makeEnv({
      ...versioned,
      WORKSHOP_BACKEND: withAssets.fetcher,
      ASSETS: stubFetcher('assets'),
    });
    await route(prod, '/api/workshop');
    await route(prod, '/blueprint-screenshot/abc');
    const dev = recordingFetcher();
    await route(makeEnv({ ...versioned, WORKSHOP_BACKEND: dev.fetcher }), '/blueprints/123');

    const forwarded = [...withAssets.received, ...dev.received];
    expect(forwarded.map(({ req }) => new URL(req.url).pathname))
      .toEqual(['/api/workshop', '/blueprint-screenshot/abc', '/blueprints/123']);
    for (const { req } of forwarded) expect(req.headers.get(HEADER)).toBe('r42:abcd1234');
  });

  it('overwrites a client-supplied value', async () => {
    const backend = recordingFetcher();
    const env = makeEnv({ ...versioned, WORKSHOP_BACKEND: backend.fetcher });
    const req = new Request('https://example.com/api', { headers: { [HEADER]: 'forged' } });
    await router.fetch!(req, env, {} as ExecutionContext);
    expect(backend.received[0].req.headers.get(HEADER)).toBe('r42:abcd1234');
  });

  it('sends an empty value when the router has no tag', async () => {
    for (const extra of [{}, { CF_VERSION_METADATA: { id: 'v', timestamp: '' } }]) {
      const backend = recordingFetcher();
      const env = makeEnv({ ...extra, WORKSHOP_BACKEND: backend.fetcher });
      const req = new Request('https://example.com/api', { headers: { [HEADER]: 'forged' } });
      await router.fetch!(req, env, {} as ExecutionContext);
      expect(backend.received[0].req.headers.get(HEADER)).toBe('');
    }
  });

  it('preserves the method, body and other headers', async () => {
    const backend = recordingFetcher();
    const env = makeEnv({ ...versioned, WORKSHOP_BACKEND: backend.fetcher });
    const req = new Request('https://example.com/api/client-errors?x=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'session=s' },
      body: '{"a":1}',
    });
    await router.fetch!(req, env, {} as ExecutionContext);
    const [{ req: forwarded, body }] = backend.received;
    expect(forwarded.method).toBe('POST');
    expect(forwarded.url).toBe('https://example.com/api/client-errors?x=1');
    expect(forwarded.headers.get('Content-Type')).toBe('application/json');
    expect(forwarded.headers.get('Cookie')).toBe('session=s');
    expect(body).toBe('{"a":1}');
  });

  it('passes a WebSocket upgrade through to the backend', async () => {
    let upgrade: string | null = null;
    let tag: string | null = null;
    const backend = {
      fetch: async (req: Request) => {
        upgrade = req.headers.get('Upgrade');
        tag = req.headers.get(HEADER);
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        return new Response(null, { status: 101, webSocket: client });
      },
    } as unknown as Fetcher;
    const env = makeEnv({ ...versioned, WORKSHOP_BACKEND: backend });
    const req = new Request('https://example.com/api', { headers: { Upgrade: 'websocket' } });
    const res = await router.fetch!(req, env, {} as ExecutionContext);
    expect(upgrade).toBe('websocket');
    expect(tag).toBe('r42:abcd1234');
    expect(res.status).toBe(101);
    expect(res.webSocket).not.toBeNull();
    res.webSocket!.accept();
    res.webSocket!.close();
  });
});

describe('router email', () => {
  it('forwards to GATEKEEPER_EMAIL when bound', async () => {
    const received: unknown[] = [];
    const env = makeEnv({
      GATEKEEPER_EMAIL: { email: async (m: unknown) => { received.push(m); } },
    });
    const message = {} as ForwardableEmailMessage;
    await router.email!(message, env, {} as ExecutionContext);
    expect(received).toEqual([message]);
  });

  it('rejects mail when no email gatekeeper is installed', async () => {
    const rejections: string[] = [];
    const env = makeEnv();
    const message = {
      setReject: (reason: string) => { rejections.push(reason); },
    } as unknown as ForwardableEmailMessage;
    await router.email!(message, env, {} as ExecutionContext);
    expect(rejections).toHaveLength(1);
  });
});

// The deploy service renders customer instances from this config (via the release manifest), so
// the asset-routing contract must hold: worker-first prefixes cover every dynamic route, or asset
// 404 handling would swallow API and gatekeeper traffic.
describe('wrangler.jsonc contract', () => {
  const config = parse(wranglerConfigText);

  it('runs the worker first for API, screenshot, and gatekeeper prefixes', () => {
    const first: string[] = config.assets.run_worker_first;
    expect(first).toContain('/api');
    expect(first).toContain('/api/*');
    expect(first).toContain('/blueprint-screenshot');
    expect(first).toContain('/blueprint-screenshot/*');
    expect(first).toContain('/gatekeeper/*');
  });

  it('serves the frontend as a single-page application', () => {
    expect(config.assets.not_found_handling).toBe('single-page-application');
    expect(config.assets.directory).toBe('../workshop-frontend/dist');
    expect(config.assets.binding).toBe('ASSETS');
  });

  it('binds the workshop backend', () => {
    expect(config.services).toContainEqual({
      binding: 'WORKSHOP_BACKEND',
      service: 'workshop-backend',
    });
  });
});

// FAC-232: InferOS may be framed only by itself. Most shell pages are served by Workers Static
// Assets without running the router, from the `_headers` file the frontend build ships; the router
// adds the same policy to the asset responses it returns itself.
async function fetchFrom(env: Env, path: string): Promise<Response> {
  return router.fetch!(new Request(`https://example.com${path}`), env, {} as ExecutionContext);
}

describe('framing policy', () => {
  const FRAME_ANCESTORS = "frame-ancestors 'self'";

  it('refuses framing by other origins on every asset response the router returns', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    for (const path of ['/', '/workspace/abc', '/open/gadget?ref=x', '/gatekeeper/not-installed']) {
      const res = await fetchFrom(env, path);
      expect(await res.text(), path).toBe('assets');
      expect(res.headers.get('Content-Security-Policy'), path).toBe(FRAME_ANCESTORS);
      expect(res.headers.get('X-Frame-Options'), path).toBe('SAMEORIGIN');
    }
  });

  it('keeps the status and headers of the asset response', async () => {
    const assets = {
      fetch: async () => new Response('<!doctype html>', {
        status: 200, headers: { 'Content-Type': 'text/html', ETag: '"abc"' },
      }),
    } as unknown as Fetcher;
    const res = await fetchFrom(makeEnv({ ASSETS: assets }), '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html');
    expect(res.headers.get('ETag')).toBe('"abc"');
  });

  it('never weakens a stricter policy, and adds to one that does not name framers', async () => {
    const denying = {
      fetch: async () => new Response('x', {
        headers: { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' },
      }),
    } as unknown as Fetcher;
    const strict = await fetchFrom(makeEnv({ ASSETS: denying }), '/');
    expect(strict.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    expect(strict.headers.get('X-Frame-Options')).toBe('DENY');

    const scripts = {
      fetch: async () => new Response('x', { headers: { 'Content-Security-Policy': "script-src 'self'" } }),
    } as unknown as Fetcher;
    const added = await fetchFrom(makeEnv({ ASSETS: scripts }), '/');
    expect(added.headers.get('Content-Security-Policy')).toBe(`script-src 'self', ${FRAME_ANCESTORS}`);
  });

  it('leaves the API, gatekeepers and the dev fallthrough to their own headers', async () => {
    const plain = recordingFetcher();
    const env = makeEnv({
      WORKSHOP_BACKEND: plain.fetcher,
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_GOOGLE: stubFetcher('google'),
    });
    for (const path of ['/api/workshop', '/blueprint-screenshot/abc', '/gatekeeper/google/connect']) {
      const res = await fetchFrom(env, path);
      expect(res.headers.get('Content-Security-Policy'), path).toBeNull();
      expect(res.headers.get('X-Frame-Options'), path).toBeNull();
    }
    const dev = await fetchFrom(makeEnv({ WORKSHOP_BACKEND: plain.fetcher }), '/');
    expect(dev.headers.get('X-Frame-Options')).toBeNull();
  });

  it('is the policy the frontend build ships for the paths Static Assets serves itself', () => {
    const lines = headersFileText.split('\n').map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'));
    expect(lines).toEqual([
      '/*',
      `Content-Security-Policy: ${FRAME_POLICY_HEADERS['Content-Security-Policy']}`,
      `X-Frame-Options: ${FRAME_POLICY_HEADERS['X-Frame-Options']}`,
    ]);
    expect(FRAME_POLICY_HEADERS['Content-Security-Policy']).toBe(FRAME_ANCESTORS);
  });
});

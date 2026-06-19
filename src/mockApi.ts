import fs from 'fs/promises';
import http, {IncomingMessage, ServerResponse} from 'http';
import net from 'net';
import path from 'path';
import {FLOW_MANIFEST_PATH} from './flows';

export type QaMockApiResponse = {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  text?: string;
  delayMs?: number;
  delay?: number;
};

export type QaMockApiConfig = {
  root: string;
  defaultScenario: string;
};

export type RunningQaMockApiServer = {
  url: string;
  port: number;
  scenario: string;
  root: string;
  close: () => Promise<void>;
};

type MockRoute = {
  key: string;
  method: string;
  path: string;
  response: QaMockApiResponse;
};

type ManifestRecord = {
  services?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringRecord(value: unknown) {
  if (!isRecord(value)) return {};

  return Object.entries(value).reduce<Record<string, string>>(
    (record, [key, entry]) => {
      if (typeof entry === 'string') {
        record[key] = entry;
      }
      return record;
    },
    {}
  );
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeResponse(value: unknown): QaMockApiResponse {
  if (typeof value === 'number') return {status: value};
  if (typeof value === 'string') return {text: value};
  if (!isRecord(value)) return {body: value};

  return {
    status: numberValue(value.status),
    headers: stringRecord(value.headers),
    body: 'body' in value ? value.body : undefined,
    text: typeof value.text === 'string' ? value.text : undefined,
    delayMs: numberValue(value.delayMs),
    delay: numberValue(value.delay),
  };
}

function routeEntries(value: unknown) {
  if (!isRecord(value)) return {};
  if (isRecord(value.routes)) return value.routes;
  return value;
}

function parseRouteKey(key: string, response: unknown): MockRoute {
  const trimmed = key.trim();
  const match = trimmed.match(/^([A-Za-z*]+)\s+(.+)$/);
  const method = match ? match[1].toUpperCase() : 'ANY';
  const routePath = match ? match[2].trim() : trimmed;

  return {
    key: trimmed,
    method,
    path: routePath || '/',
    response: normalizeResponse(response),
  };
}

function routePatternMatches(pattern: string, requestPath: string) {
  if (pattern === requestPath) return true;
  if (!pattern.includes('*')) return false;

  const escaped = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(requestPath);
}

function findRoute(input: {
  routes: MockRoute[];
  method: string;
  pathname: string;
  pathWithSearch: string;
}) {
  const candidates = [
    input.pathWithSearch,
    input.pathname,
    input.pathname.replace(/\/+$/, '') || '/',
  ];

  return input.routes.find(route => {
    if (route.method !== 'ANY' && route.method !== '*' && route.method !== input.method) {
      return false;
    }

    return candidates.some(candidate => routePatternMatches(route.path, candidate));
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type,Authorization,X-Requested-With,X-Layout-QA-Scenario,X-Layout-Org-Id',
    'Access-Control-Max-Age': '86400',
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...corsHeaders(),
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

function sendText(
  response: ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {}
) {
  response.writeHead(status, {
    ...corsHeaders(),
    'Content-Type': headers['Content-Type'] || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

async function readScenario(input: {root: string; scenario: string}) {
  const scenarioFiles = [
    path.join(input.root, 'scenarios', `${input.scenario}.json`),
    path.join(input.root, `${input.scenario}.json`),
  ];

  for (const filePath of scenarioFiles) {
    const content = await fs.readFile(filePath, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    if (!content) continue;

    const parsed = JSON.parse(content) as unknown;
    return Object.entries(routeEntries(parsed)).map(([key, value]) =>
      parseRouteKey(key, value)
    );
  }

  throw new Error(
    `Missing Layout mock API scenario "${input.scenario}" in ${path.join(
      input.root,
      'scenarios'
    )}.`
  );
}

function resolveManifestPath(input: {manifestPath: string; targetPath: string}) {
  if (path.isAbsolute(input.targetPath)) return input.targetPath;

  const manifestDir = path.dirname(path.resolve(input.manifestPath));
  if (
    input.targetPath === '.layout' ||
    input.targetPath.startsWith(`.layout${path.sep}`) ||
    input.targetPath.startsWith('.layout/')
  ) {
    const repoRoot =
      path.basename(manifestDir) === '.layout'
        ? path.dirname(manifestDir)
        : manifestDir;
    return path.resolve(repoRoot, input.targetPath);
  }

  return path.resolve(manifestDir, input.targetPath);
}

export async function loadQaMockApiConfig(input: {
  manifestPath?: string;
  scenario?: string;
}) {
  const manifestPath = path.resolve(input.manifestPath || FLOW_MANIFEST_PATH);
  const content = await fs.readFile(manifestPath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  if (!content) return null;

  const manifest = JSON.parse(content) as ManifestRecord;
  const services = isRecord(manifest.services) ? manifest.services : {};
  const apiService = isRecord(services.api) ? services.api : null;
  if (!apiService || apiService.type !== 'mock') return null;

  const root =
    typeof apiService.root === 'string' ? apiService.root : '.layout/api';
  const defaultScenario =
    typeof apiService.scenario === 'string'
      ? apiService.scenario
      : typeof apiService.defaultScenario === 'string'
      ? apiService.defaultScenario
      : 'happy_path';

  return {
    root: resolveManifestPath({manifestPath, targetPath: root}),
    defaultScenario: input.scenario || defaultScenario,
  } satisfies QaMockApiConfig;
}

function getAvailablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate port.')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startQaMockApiServer(input: {
  root: string;
  scenario?: string;
  port?: number;
}) {
  const scenario = input.scenario || 'happy_path';
  const routes = await readScenario({root: input.root, scenario});
  const port = input.port || (await getAvailablePort());

  const server = http.createServer(async (request, response) => {
    try {
      const method = (request.method || 'GET').toUpperCase();
      if (method === 'OPTIONS') {
        response.writeHead(204, corsHeaders());
        response.end();
        return;
      }

      const requestUrl = new URL(
        request.url || '/',
        `http://${request.headers.host || `127.0.0.1:${port}`}`
      );

      if (requestUrl.pathname === '/__layout-qa/health') {
        sendJson(response, 200, {
          ok: true,
          scenario,
          routeCount: routes.length,
        });
        return;
      }

      const route = findRoute({
        routes,
        method,
        pathname: requestUrl.pathname,
        pathWithSearch: `${requestUrl.pathname}${requestUrl.search}`,
      });

      if (!route) {
        await requestBody(request).catch(() => '');
        sendJson(response, 404, {
          error: 'No Layout mock API fixture matched this request.',
          method,
          path: requestUrl.pathname,
          scenario,
          availableRoutes: routes.map(entry => entry.key),
        });
        return;
      }

      const delayMs = route.response.delayMs ?? route.response.delay ?? 0;
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      const status = route.response.status || 200;
      const headers = route.response.headers || {};
      if (route.response.text !== undefined) {
        sendText(response, status, route.response.text, headers);
      } else {
        sendJson(
          response,
          status,
          route.response.body === undefined ? null : route.response.body,
          headers
        );
      }
    } catch (error) {
      sendJson(response, 500, {
        error:
          error instanceof Error
            ? error.message
            : 'Layout mock API server failed.',
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    scenario,
    root: input.root,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
  } satisfies RunningQaMockApiServer;
}

export function starterMockScenarios() {
  return {
    happy_path: {
      'GET /api/me': {
        status: 200,
        body: {
          id: 'qa-user',
          email: 'qa@example.com',
          name: 'QA User',
        },
      },
      'GET /api/items': {
        status: 200,
        body: [
          {
            id: 'item-1',
            title: 'Example item',
            status: 'ready',
          },
        ],
      },
    },
    empty: {
      'GET /api/me': {
        status: 200,
        body: {
          id: 'qa-user',
          email: 'qa@example.com',
          name: 'QA User',
        },
      },
      'GET /api/items': {
        status: 200,
        body: [],
      },
    },
    error: {
      'GET /api/me': {
        status: 200,
        body: {
          id: 'qa-user',
          email: 'qa@example.com',
          name: 'QA User',
        },
      },
      'GET /api/items': {
        status: 500,
        body: {
          error: 'Layout QA fixture error',
        },
      },
    },
  };
}

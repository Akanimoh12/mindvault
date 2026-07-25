/**
 * Contributor-friendly mock mode for the MindVault MCP server.
 *
 * Enabled with MINDVAULT_MOCK=1, this replaces every outbound HTTP call and the
 * on-chain registry lookup with deterministic, in-memory responses, so a
 * contributor can run and exercise the server — browse, preview, wallet setup,
 * publish/buy, registry lookups — with no live backend, no funded wallet, and no
 * network access.
 *
 * The module is self-contained: `createMockFetch()` returns a drop-in for the
 * global `fetch` (routed by URL path, mirroring scripts/mock-server.ts), and
 * `mockRegistryLookup()` stands in for the Soroban registry client. Nothing here
 * touches the filesystem or the network, so it stays deterministic and testable.
 */

import { Keypair } from "@stellar/stellar-sdk";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Mock mode is opt-in: enabled only when MINDVAULT_MOCK is a truthy string. */
export function mockEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env.MINDVAULT_MOCK;
  return typeof raw === "string" && TRUTHY.has(raw.trim().toLowerCase());
}

interface MockResource {
  id: string;
  title: string;
  description: string;
  price: string;
  resourceType: "link";
  verificationStatus: "verified";
  accessUrl: string;
}

/** Two seeded resources so browse/preview/registry return content out of the box. */
function seedResources(): Map<string, MockResource> {
  const resources = new Map<string, MockResource>();
  const seed: MockResource[] = [
    {
      id: "mock-1",
      title: "Intro to Stellar Smart Contracts",
      description: "A beginner guide to Soroban.",
      price: "1.5",
      resourceType: "link",
      verificationStatus: "verified",
      accessUrl: "https://example.com/mock-1",
    },
    {
      id: "mock-2",
      title: "x402 Payments Cheat Sheet",
      description: "Pay-per-use HTTP flows with USDC.",
      price: "0.5",
      resourceType: "link",
      verificationStatus: "verified",
      accessUrl: "https://example.com/mock-2",
    },
  ];
  for (const r of seed) resources.set(r.id, r);
  return resources;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function readJson(init?: RequestInit): Promise<any> {
  const body = init?.body;
  if (typeof body !== "string" || body.length === 0) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

/**
 * Build a deterministic `fetch` replacement. State (created resources) lives in
 * the closure so a single mock instance behaves like one running server across
 * calls. Paid endpoints return 200 directly, so the x402 wrapper passes through
 * without a payment challenge — exactly as scripts/mock-server.ts does.
 */
export function createMockFetch(): typeof fetch {
  const resources = seedResources();
  let counter = 0;

  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const { pathname } = new URL(url);

    // Sponsored-account service: mint a real (random) keypair so the server can
    // build an x402 signer without hitting the chain.
    if (method === "POST" && pathname === "/create") {
      const kp = Keypair.random();
      return json({ publicKey: kp.publicKey(), secretKey: kp.secret() });
    }

    // Horizon: report a healthy USDC + native balance so funds checks pass.
    if (method === "GET" && pathname.startsWith("/accounts/")) {
      return json({
        balances: [
          { asset_type: "credit_alphanum4", asset_code: "USDC", balance: "1000.0000000" },
          { asset_type: "native", balance: "100.0000000" },
        ],
      });
    }

    // Soroban RPC (POST JSON-RPC): answer getTransaction with SUCCESS.
    if (method === "POST" && (await isSorobanRpc(init))) {
      return json({ jsonrpc: "2.0", id: 1, result: { status: "SUCCESS", latestLedger: 1000 } });
    }

    // Publisher registration.
    if (method === "POST" && pathname === "/publishers") {
      return json({ id: "mock-pub-1", apiKey: "mock-api-key" });
    }

    // Verification agent status (drives the pre-publish funds check).
    if (method === "GET" && pathname === "/agent/status") {
      return json({
        agent: { pricePerVerification: "0.01", totalEarnings: "0", verifications: 0 },
      });
    }

    // Paid content verification. 200 ⇒ x402 wrapper passes through.
    if (method === "POST" && pathname === "/verify-content") {
      return json({ isOriginal: true, flags: [] });
    }

    // Resource collection: browse (GET) / create (POST).
    if (pathname === "/resources") {
      if (method === "GET") {
        // Advertise a fresh cache so the browse staleness check has metadata.
        return json([...resources.values()], 200, {
          "Cache-Control": "max-age=60",
          Age: "0",
          Date: new Date().toUTCString(),
        });
      }
      if (method === "POST") {
        const body = await readJson(init);
        counter += 1;
        const id = `mock-new-${counter}`;
        const resource: MockResource = {
          id,
          title: typeof body.title === "string" ? body.title : "Untitled",
          description: typeof body.description === "string" ? body.description : "",
          price: typeof body.price === "string" ? body.price : "0",
          resourceType: "link",
          verificationStatus: "verified",
          accessUrl: `https://example.com/${id}`,
        };
        resources.set(id, resource);
        return json(resource, 201);
      }
    }

    // Per-resource routes: /resources/:id[/meta|/register].
    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] === "resources" && parts.length >= 2) {
      const id = parts[1];
      const sub = parts[2];
      const resource = resources.get(id);

      if (sub === "register" && method === "POST") {
        return json({ onchainStatus: "registered", onchainTxHash: `MOCK_TX_${id}` });
      }
      if (sub === "meta" && method === "GET") {
        return resource ? json(resource) : json({ error: "not found" }, 404);
      }
      if (sub === undefined && method === "GET") {
        return resource
          ? json({ ...resource, content: `Mock content for ${id}` })
          : json({ error: "not found" }, 404);
      }
    }

    return json({ error: `no mock route for ${method} ${pathname}` }, 404);
  };

  return mockFetch as typeof fetch;
}

/** True when the request body is a Soroban JSON-RPC call (used to route txStatus). */
async function isSorobanRpc(init?: RequestInit): Promise<boolean> {
  if (typeof init?.body !== "string") return false;
  try {
    const parsed = JSON.parse(init.body);
    return parsed?.jsonrpc === "2.0" && typeof parsed?.method === "string";
  } catch {
    return false;
  }
}

/**
 * Stand-in for the on-chain registry client's lookup. Returns the same JSON
 * shape as the live path so agents see identical output in mock mode.
 */
export function mockRegistryLookup(resourceId: string, contractId: string): string {
  const seeded: Record<string, { creator: string; price: string; metadata: string }> = {
    "mock-1": { creator: "GMOCKCREATOR1", price: "1.5000000", metadata: "Intro to Stellar" },
    "mock-2": { creator: "GMOCKCREATOR2", price: "0.5000000", metadata: "x402 Cheat Sheet" },
  };
  const hit = seeded[resourceId];
  if (!hit) {
    return JSON.stringify(
      {
        source: "on-chain (mock)",
        found: false,
        resourceId,
        message: `Resource "${resourceId}" is not registered on-chain (mock mode).`,
        contract: contractId,
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      source: "on-chain (mock)",
      found: true,
      id: resourceId,
      creator: hit.creator,
      price: `${hit.price} USDC`,
      metadata: hit.metadata,
      listed: true,
      tags: [],
      contract: contractId,
    },
    null,
    2,
  );
}

import { describe, expect, spyOn, test } from "bun:test";
import {
  type CodeWhispererStreamingClient,
  GenerateAssistantResponseCommand,
  type GenerateAssistantResponseCommandInput,
} from "@aws/codewhisperer-streaming-client";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpRequest } from "@smithy/protocol-http";
import {
  buildClientConfig,
  clearSdkClientCache,
  createSdkClient,
  evictSdkClientsForAccount,
  mergeModelRequestFields,
} from "../src/core/sdk-client.js";
import type { KiroAuthDetails } from "../src/kiro/types.js";

class CapturedRequestError extends Error {
  readonly name = "CapturedRequestError";

  constructor() {
    super("request captured before transport");
  }
}

function makeAuth(): KiroAuthDetails {
  return {
    refresh: "refresh-token",
    access: "access-token",
    expires: Date.now() + 3_600_000,
    authMethod: "idc",
    region: "us-east-1",
    email: "sdk-client@example.com",
  };
}

async function captureBuiltRequest(
  client: CodeWhispererStreamingClient,
  wireModel: string,
  additionalModelRequestFields?: GenerateAssistantResponseCommandInput["additionalModelRequestFields"],
): Promise<HttpRequest> {
  let capturedRequest: HttpRequest | undefined;
  client.middlewareStack.add(
    () => async (args) => {
      if (!(args.request instanceof HttpRequest)) {
        throw new TypeError("expected a Smithy HttpRequest");
      }
      capturedRequest = args.request;
      throw new CapturedRequestError();
    },
    { step: "finalizeRequest", name: `captureRequest-${wireModel}`, priority: "high" },
  );

  const command = new GenerateAssistantResponseCommand({
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: "sdk-client-test",
      currentMessage: {
        userInputMessage: {
          content: "hello",
          modelId: wireModel,
          origin: "AI_EDITOR",
        },
      },
    },
    ...(additionalModelRequestFields === undefined ? {} : { additionalModelRequestFields }),
  });

  try {
    await client.send(command);
  } catch (error) {
    if (!(error instanceof CapturedRequestError)) throw error;
  }

  if (!capturedRequest) throw new TypeError("request middleware was not invoked");
  return capturedRequest;
}

function parseRequestBody(request: HttpRequest): Record<string, unknown> {
  let bodyText: string;
  if (typeof request.body === "string") {
    bodyText = request.body;
  } else if (request.body instanceof Uint8Array) {
    bodyText = new TextDecoder().decode(request.body);
  } else {
    throw new TypeError("expected a string or Uint8Array request body");
  }

  const parsed: unknown = JSON.parse(bodyText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("expected a JSON object request body");
  }
  return parsed as Record<string, unknown>;
}

async function resolveHandlerConfig(
  client: CodeWhispererStreamingClient,
): Promise<ReturnType<NodeHttpHandler["httpHandlerConfigs"]>> {
  const requestHandler = client.config.requestHandler;
  if (!(requestHandler instanceof NodeHttpHandler)) {
    throw new TypeError("expected a NodeHttpHandler");
  }

  const abortController = new AbortController();
  abortController.abort();
  try {
    await requestHandler.handle(
      new HttpRequest({ protocol: "http:", hostname: "127.0.0.1", method: "GET", path: "/" }),
      { abortSignal: abortController.signal },
    );
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  }

  return requestHandler.httpHandlerConfigs();
}

describe("createSdkClient", () => {
  test("sets Kiro headers and respects the injected endpoint", async () => {
    clearSdkClientCache();
    const client = createSdkClient(
      makeAuth(),
      "us-east-1",
      undefined,
      "http://127.0.0.1:43127/mock",
    );

    const request = await captureBuiltRequest(client, "claude-sonnet-4.6");

    expect(request.headers["x-amzn-kiro-agent-mode"]).toBe("vibe");
    expect(request.protocol).toBe("http:");
    expect(request.hostname).toBe("127.0.0.1");
    expect(request.port).toBe(43127);
    expect(request.path.startsWith("/mock")).toBe(true);
    // The pipeline owns retries; the SDK must not add a second retry layer.
    expect(await client.config.maxAttempts()).toBe(1);
    const retryMode = client.config.retryMode;
    expect(typeof retryMode === "function" ? await retryMode() : retryMode).toBe("standard");
    clearSdkClientCache();
  });

  test("sends the command additionalModelRequestFields verbatim without an effort middleware", async () => {
    clearSdkClientCache();
    const client = createSdkClient(makeAuth(), "us-east-1", "high");

    const request = await captureBuiltRequest(client, "claude-opus-5", {
      max_tokens: 4096,
      output_config: { effort: "high" },
    });
    const body = parseRequestBody(request);

    expect(body.additionalModelRequestFields).toEqual({
      max_tokens: 4096,
      output_config: { effort: "high" },
    });
    const plainClient = createSdkClient(
      makeAuth(),
      "us-east-1",
      "high",
      undefined,
      undefined,
      "plain",
    );
    const plain = await captureBuiltRequest(plainClient, "gpt-5.6-sol");
    expect("additionalModelRequestFields" in parseRequestBody(plain)).toBe(false);
    clearSdkClientCache();
  });

  test("mergeModelRequestFields deep-merges additions without dropping existing keys", () => {
    expect(mergeModelRequestFields(undefined, { output_config: { effort: "max" } })).toEqual({
      output_config: { effort: "max" },
    });
    expect(
      mergeModelRequestFields(
        { max_tokens: 4096, output_config: { verbosity: "low" } },
        { output_config: { effort: "high" } },
      ),
    ).toEqual({ max_tokens: 4096, output_config: { verbosity: "low", effort: "high" } });
    expect(
      mergeModelRequestFields({ reasoning: "scalar" }, { reasoning: { effort: "low" } }),
    ).toEqual({
      reasoning: { effort: "low" },
    });
  });

  test("configures the same fresh-socket proxy agent for HTTP and HTTPS endpoints", async () => {
    clearSdkClientCache();
    const proxyUrl = "http://127.0.0.1:43128";
    const client = createSdkClient(
      makeAuth(),
      "us-east-1",
      undefined,
      "http://127.0.0.1:43127/mock",
      proxyUrl,
    );

    const handlerConfig = await resolveHandlerConfig(client);

    expect(handlerConfig.httpAgent).toBe(handlerConfig.httpsAgent);
    expect(handlerConfig.httpAgent).toMatchObject({ keepAlive: false, maxSockets: 50 });
    clearSdkClientCache();
  });

  test("uses fresh direct HTTP and HTTPS sockets by default without reducing capacity", async () => {
    clearSdkClientCache();
    const auth = makeAuth();
    const directConfig = buildClientConfig(auth, "us-east-1", "https://q.us-east-1.amazonaws.com");
    const client = createSdkClient(makeAuth(), "us-east-1");
    const handlerConfig = await resolveHandlerConfig(client);

    expect(directConfig.requestHandler).toBeInstanceOf(NodeHttpHandler);
    expect(client.config.requestHandler).toBeInstanceOf(NodeHttpHandler);
    expect(handlerConfig.httpAgent).toMatchObject({ keepAlive: false, maxSockets: 50 });
    expect(handlerConfig.httpsAgent).toMatchObject({ keepAlive: false, maxSockets: 50 });
    clearSdkClientCache();
  });

  test("allows explicit cross-request socket reuse", async () => {
    clearSdkClientCache();
    const client = createSdkClient(
      makeAuth(),
      "us-east-1",
      undefined,
      undefined,
      undefined,
      "account-a",
      true,
    );
    const handlerConfig = await resolveHandlerConfig(client);

    expect(handlerConfig.httpAgent).toMatchObject({ keepAlive: true, maxSockets: 50 });
    expect(handlerConfig.httpsAgent).toMatchObject({ keepAlive: true, maxSockets: 50 });
    clearSdkClientCache();
  });

  test("separates proxied and direct clients while caching identical proxy arguments", () => {
    clearSdkClientCache();
    const auth = makeAuth();
    const endpoint = "http://127.0.0.1:43127/mock";
    const proxyUrl = "http://127.0.0.1:43128";

    const proxiedClient = createSdkClient(auth, "us-east-1", "high", endpoint, proxyUrl);
    const cachedProxiedClient = createSdkClient(auth, "us-east-1", "high", endpoint, proxyUrl);
    const directClient = createSdkClient(auth, "us-east-1", "high", endpoint);

    expect(cachedProxiedClient).toBe(proxiedClient);
    expect(directClient).not.toBe(proxiedClient);
    clearSdkClientCache();
  });

  test("keeps fresh-socket and keep-alive transports in separate cache entries", () => {
    clearSdkClientCache();
    const auth = makeAuth();
    const fresh = createSdkClient(
      auth,
      "us-east-1",
      "high",
      undefined,
      undefined,
      "account-a",
      false,
    );
    const reused = createSdkClient(
      auth,
      "us-east-1",
      "high",
      undefined,
      undefined,
      "account-a",
      true,
    );
    const reusedAgain = createSdkClient(
      auth,
      "us-east-1",
      "high",
      undefined,
      undefined,
      "account-a",
      true,
    );

    expect(reused).not.toBe(fresh);
    expect(reused.config.requestHandler).not.toBe(fresh.config.requestHandler);
    expect(reusedAgain).toBe(reused);
    clearSdkClientCache();
  });

  test("rebuilds the SDK client after a token change while reusing its transport", async () => {
    clearSdkClientCache();
    const firstAuth = makeAuth();
    const first = createSdkClient(
      firstAuth,
      "us-east-1",
      "high",
      undefined,
      undefined,
      "account-a",
    );
    const refreshed = createSdkClient(
      { ...firstAuth, access: "refreshed-access-token" },
      "us-east-1",
      "high",
      undefined,
      undefined,
      "account-a",
    );

    expect(refreshed).not.toBe(first);
    expect(refreshed.config.requestHandler).toBe(first.config.requestHandler);
    const firstToken = first.config.token;
    const refreshedToken = refreshed.config.token;
    if (!firstToken || !refreshedToken) {
      throw new TypeError("SDK client token provider is required");
    }
    expect(await firstToken()).toEqual({ token: "access-token" });
    expect(await refreshedToken()).toEqual({ token: "refreshed-access-token" });
    clearSdkClientCache();
  });

  test("sends the refreshed bearer token on the next real HTTP request", async () => {
    clearSdkClientCache();
    const authorizationHeaders: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        authorizationHeaders.push(request.headers.get("authorization") ?? "");
        return Response.json({ message: "intentional test rejection" }, { status: 400 });
      },
    });
    const endpoint = `http://127.0.0.1:${server.port}`;
    const command = () =>
      new GenerateAssistantResponseCommand({
        conversationState: {
          chatTriggerType: "MANUAL",
          conversationId: "sdk-client-token-refresh-test",
          currentMessage: {
            userInputMessage: {
              content: "hello",
              modelId: "claude-sonnet-4.6",
              origin: "AI_EDITOR",
            },
          },
        },
      });

    try {
      const firstAuth = makeAuth();
      const first = createSdkClient(
        firstAuth,
        "us-east-1",
        undefined,
        endpoint,
        undefined,
        "account-a",
      );
      await expect(first.send(command())).rejects.toBeDefined();

      const refreshed = createSdkClient(
        { ...firstAuth, access: "refreshed-access-token" },
        "us-east-1",
        undefined,
        endpoint,
        undefined,
        "account-a",
      );
      await expect(refreshed.send(command())).rejects.toBeDefined();

      expect(authorizationHeaders).toHaveLength(2);
      expect(authorizationHeaders[0]).toBe("Bearer access-token");
      expect(authorizationHeaders[1]).toBe("Bearer refreshed-access-token");
    } finally {
      server.stop(true);
      clearSdkClientCache();
    }
  });

  test("emits content-free connection-pool hit and miss evidence", () => {
    clearSdkClientCache();
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const auth = makeAuth();
      createSdkClient(auth, "us-east-1", "high", undefined, undefined, "account-a");
      createSdkClient(auth, "us-east-1", "high", undefined, undefined, "account-a");

      const events = consoleError.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        event: "sdk_connection_pool_selected",
        account_hash: expect.any(String),
        region: "us-east-1",
        effort: "high",
        http_keep_alive: false,
        transport_pool_hit: false,
        sdk_client_pool_hit: false,
      });
      expect(events[1]).toMatchObject({
        event: "sdk_connection_pool_selected",
        account_hash: events[0].account_hash,
        transport_pool_hit: true,
        sdk_client_pool_hit: true,
        sdk_client_rebuilt_for_token_change: false,
      });
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("account-a");
      expect(serialized).not.toContain(auth.access);
      expect(serialized).not.toContain(auth.refresh);
    } finally {
      consoleError.mockRestore();
      clearSdkClientCache();
    }
  });

  test("separates accounts even when their email and endpoint are identical", () => {
    clearSdkClientCache();
    const auth = makeAuth();
    const first = createSdkClient(auth, "us-east-1", undefined, undefined, undefined, "account-a");
    const second = createSdkClient(auth, "us-east-1", undefined, undefined, undefined, "account-b");

    expect(second).not.toBe(first);
    expect(second.config.requestHandler).not.toBe(first.config.requestHandler);
    clearSdkClientCache();
  });

  test("reuses one client and transport across effort levels for one account", () => {
    clearSdkClientCache();
    const auth = makeAuth();
    const low = createSdkClient(auth, "us-east-1", "low", undefined, undefined, "account-a");
    const high = createSdkClient(auth, "us-east-1", "high", undefined, undefined, "account-a");

    expect(high).toBe(low);
    expect(high.config.requestHandler).toBe(low.config.requestHandler);
    clearSdkClientCache();
  });

  test("evicting an account destroys its transports and drops its clients", () => {
    clearSdkClientCache();
    const auth = makeAuth();
    const direct = createSdkClient(auth, "us-east-1", undefined, undefined, undefined, "account-a");
    const keepAlive = createSdkClient(
      auth,
      "us-east-1",
      undefined,
      undefined,
      undefined,
      "account-a",
      true,
    );
    const other = createSdkClient(auth, "us-east-1", undefined, undefined, undefined, "account-b");
    const directHandler = direct.config.requestHandler;
    const keepAliveHandler = keepAlive.config.requestHandler;
    const otherHandler = other.config.requestHandler;
    if (
      !(directHandler instanceof NodeHttpHandler) ||
      !(keepAliveHandler instanceof NodeHttpHandler) ||
      !(otherHandler instanceof NodeHttpHandler)
    ) {
      throw new TypeError("expected NodeHttpHandler transports");
    }
    const directDestroy = spyOn(directHandler, "destroy");
    const keepAliveDestroy = spyOn(keepAliveHandler, "destroy");
    const otherDestroy = spyOn(otherHandler, "destroy");

    evictSdkClientsForAccount("account-a");

    expect(directDestroy).toHaveBeenCalledTimes(1);
    expect(keepAliveDestroy).toHaveBeenCalledTimes(1);
    expect(otherDestroy).not.toHaveBeenCalled();
    const rebuilt = createSdkClient(
      auth,
      "us-east-1",
      undefined,
      undefined,
      undefined,
      "account-a",
    );
    expect(rebuilt).not.toBe(direct);
    expect(rebuilt.config.requestHandler).not.toBe(directHandler);
    expect(createSdkClient(auth, "us-east-1", undefined, undefined, undefined, "account-b")).toBe(
      other,
    );
    evictSdkClientsForAccount("never-created");
    clearSdkClientCache();
  });
});

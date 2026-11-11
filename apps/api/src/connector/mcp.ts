import { callTool, toolDefinitions, type ToolContext } from './tools';

/**
 * The MCP protocol over Streamable HTTP, stateless: every POST carries one JSON-RPC message and is
 * answered with plain JSON, so no session id is minted and nothing streams. Claude's connectors
 * follow the 2025 revisions of the spec, which start with `initialize`.
 */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

const INSTRUCTIONS = `Officina is the workshop where a team asks for changes to its products in plain language. Agents interview, plan, build and review; people approve the plan, check the result and merge.

How to help the person:
- To ask for something (change a text, report a bug, add a feature), gather what, where, why and what must not change, one question at a time, then call open_request.
- To see what needs them, call whats_waiting_on_me, then show_task for each item.
- An agent's question: relay it in plain words and pass the answer with answer_question.
- A plan to approve or a result to check: show the plan or the checklist from show_task, and call review only after the person confirms.
Always give the person the task link. Never invent their answers or decisions.`;

type JsonRpcId = string | number;

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: JsonRpcId | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

const ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602
} as const;

export type McpReply =
  { readonly status: 202 } | { readonly status: 200 | 400; readonly body: Record<string, unknown> };

const failure = (id: JsonRpcId | null, code: number, message: string): McpReply => ({
  status: code === ERRORS.parse || code === ERRORS.invalidRequest ? 400 : 200,
  body: { jsonrpc: '2.0', id, error: { code, message } }
});

const success = (id: JsonRpcId, result: Record<string, unknown>): McpReply => ({
  status: 200,
  body: { jsonrpc: '2.0', id, result }
});

/** Answers one JSON-RPC message from an authenticated member. */
export const handleMcp = async (
  message: unknown,
  context: () => Promise<ToolContext>,
  serverVersion: string
): Promise<McpReply> => {
  if (Array.isArray(message))
    return failure(null, ERRORS.invalidRequest, 'send one JSON-RPC message per request');
  const request = message as JsonRpcRequest | null;
  if (!request || typeof request !== 'object' || request.jsonrpc !== '2.0')
    return failure(null, ERRORS.invalidRequest, 'not a JSON-RPC 2.0 message');
  // Notifications and responses need no answer.
  if (request.id === undefined || request.id === null || typeof request.method !== 'string')
    return { status: 202 };
  const { id } = request;

  switch (request.method) {
    case 'initialize': {
      const asked = request.params?.protocolVersion;
      return success(id, {
        protocolVersion:
          PROTOCOL_VERSIONS.find((version) => version === asked) ?? PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'officina', title: 'Officina', version: serverVersion },
        instructions: INSTRUCTIONS
      });
    }
    case 'ping':
      return success(id, {});
    case 'tools/list':
      return success(id, { tools: toolDefinitions() });
    case 'tools/call': {
      const name = request.params?.name;
      if (typeof name !== 'string') return failure(id, ERRORS.invalidParams, 'name is required');
      const outcome = await callTool(await context(), name, request.params?.arguments);
      if (!outcome) return failure(id, ERRORS.invalidParams, `unknown tool ${name}`);
      return success(id, {
        content: [{ type: 'text', text: outcome.text }],
        isError: outcome.isError
      });
    }
    default:
      return failure(id, ERRORS.methodNotFound, `method ${request.method} is not supported`);
  }
};

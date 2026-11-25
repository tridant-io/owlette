/**
 * @jest-environment node
 *
 * Tests for Hoot history repair (repairDanglingToolParts). Pins: clean histories pass
 * through by reference; dangling `input-available`/`input-streaming` parts on a superseded
 * assistant turn become terminal `output-error`; unanswered `approval-requested` parts
 * superseded by a later user message are resolved; the final in-flight assistant message
 * is never touched (the tier-3 approval round-trip needs it); a regression pin against the
 * real AI SDK (broken shape throws MissingToolResultsError, repaired shape converts); and
 * the async resolver overload — `{ output }` → `output-available`, `{ errorText }`
 * customizes the error, `null` → LOST_RESULT_ERROR, approvals never consult the resolver.
 */

import { convertToModelMessages, streamText, type UIMessage } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import {
  applyApprovalConsumption,
  reapplyConsumedParts,
  repairDanglingToolParts,
  APPROVAL_ALREADY_CONSUMED_ERROR,
  LATE_DENIAL_ERROR,
  LOST_RESULT_ERROR,
  SUPERSEDED_APPROVAL_ERROR,
  STILL_RUNNING_ERROR,
} from '@/lib/hoot/repairMessages';

function userMsg(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] } as UIMessage;
}

function assistantMsg(id: string, parts: unknown[]): UIMessage {
  return { id, role: 'assistant', parts } as UIMessage;
}

const danglingToolPart = {
  type: 'tool-execute_script',
  toolCallId: 'toolu_dangling_1',
  state: 'input-available',
  input: { script: 'sfc /scannow', timeout_seconds: 1800 },
};

const completedToolPart = {
  type: 'tool-execute_script',
  toolCallId: 'toolu_done_1',
  state: 'output-available',
  input: { script: 'Get-Date' },
  output: { exit_code: 0, stdout: 'ok' },
};

describe('repairDanglingToolParts', () => {
  it('returns clean histories untouched (same message references)', () => {
    const messages = [
      userMsg('u1', 'run a script'),
      assistantMsg('a1', [{ type: 'text', text: 'done' }, completedToolPart]),
      userMsg('u2', 'thanks'),
    ];

    const { messages: out, repairedToolCallIds } = repairDanglingToolParts(messages);

    expect(repairedToolCallIds).toEqual([]);
    expect(out[1]).toBe(messages[1]);
  });

  it('repairs a dangling input-available part on a superseded turn', () => {
    const messages = [
      userMsg('u1', 'run sfc and dism'),
      assistantMsg('a1', [{ type: 'text', text: 'running both' }, completedToolPart, danglingToolPart]),
      userMsg('u2', 'still running?'),
    ];

    const { messages: out, repairedToolCallIds } = repairDanglingToolParts(messages);

    expect(repairedToolCallIds).toEqual(['toolu_dangling_1']);
    const parts = out[1].parts as Array<Record<string, unknown>>;
    expect(parts[1]).toBe(completedToolPart); // untouched sibling
    expect(parts[2]).toMatchObject({
      type: 'tool-execute_script',
      toolCallId: 'toolu_dangling_1',
      state: 'output-error',
      errorText: LOST_RESULT_ERROR,
      input: danglingToolPart.input, // captured input preserved
    });
  });

  it('repairs input-streaming parts and defaults missing input to {}', () => {
    const messages = [
      userMsg('u1', 'go'),
      assistantMsg('a1', [
        { type: 'tool-execute_script', toolCallId: 'toolu_stream_1', state: 'input-streaming' },
      ]),
      userMsg('u2', 'hello?'),
    ];

    const { messages: out, repairedToolCallIds } = repairDanglingToolParts(messages);

    expect(repairedToolCallIds).toEqual(['toolu_stream_1']);
    expect((out[1].parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      state: 'output-error',
      errorText: LOST_RESULT_ERROR,
      input: {},
    });
  });

  it('resolves an unanswered approval superseded by a later user message', () => {
    const messages = [
      userMsg('u1', 'reboot it'),
      assistantMsg('a1', [
        {
          type: 'tool-reboot_machine',
          toolCallId: 'toolu_approval_1',
          state: 'approval-requested',
          input: {},
          approval: { id: 'appr_1' },
        },
      ]),
      userMsg('u2', 'actually, wait'),
    ];

    const { messages: out, repairedToolCallIds } = repairDanglingToolParts(messages);

    expect(repairedToolCallIds).toEqual(['toolu_approval_1']);
    const part = (out[1].parts as Array<Record<string, unknown>>)[0];
    expect(part).toMatchObject({ state: 'output-error', errorText: SUPERSEDED_APPROVAL_ERROR });
    expect(part.approval).toBeUndefined();
  });

  it('never touches the final in-flight assistant message (approval round-trip)', () => {
    const pendingApproval = assistantMsg('a1', [
      {
        type: 'tool-reboot_machine',
        toolCallId: 'toolu_pending_1',
        state: 'approval-requested',
        input: {},
        approval: { id: 'appr_1' },
      },
    ]);
    const messages = [userMsg('u1', 'reboot it'), pendingApproval];

    const { messages: out, repairedToolCallIds } = repairDanglingToolParts(messages);

    expect(repairedToolCallIds).toEqual([]);
    expect(out[1]).toBe(pendingApproval);
  });

  it('preserves toolName on repaired dynamic-tool parts', () => {
    const messages = [
      userMsg('u1', 'go'),
      assistantMsg('a1', [
        {
          type: 'dynamic-tool',
          toolName: 'execute_script',
          toolCallId: 'toolu_dyn_1',
          state: 'input-available',
          input: { script: 'dir' },
        },
      ]),
      userMsg('u2', 'and?'),
    ];

    const { messages: out } = repairDanglingToolParts(messages);

    expect((out[1].parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'execute_script',
      state: 'output-error',
    });
  });

  it('leaves output-error and DENIED approval-responded parts untouched', () => {
    const erroredPart = {
      type: 'tool-execute_script',
      toolCallId: 'toolu_err_1',
      state: 'output-error',
      input: {},
      errorText: 'agent said no',
    };
    const deniedPart = {
      type: 'tool-reboot_machine',
      toolCallId: 'toolu_resp_1',
      state: 'approval-responded',
      input: {},
      approval: { id: 'appr_2', approved: false, reason: 'denied' },
    };
    const messages = [
      userMsg('u1', 'go'),
      assistantMsg('a1', [erroredPart, deniedPart]),
      userMsg('u2', 'ok'),
    ];

    const { messages: out, repairedToolCallIds } = repairDanglingToolParts(messages);

    expect(repairedToolCallIds).toEqual([]);
    expect(out[1]).toBe(messages[1]);
  });

  // The prod failure the live smoke surfaced: a tier-3 tool approved and executing, then
  // superseded by a new user message. Its part is `approval-responded` with no output —
  // repair must synthesize a result, else convertToModelMessages emits a dangling tool_use
  // and the provider 400s the request ("tool_use ids without tool_result").
  it('repairs an APPROVED approval-responded part superseded mid-execution', () => {
    const approvedInflight = {
      type: 'tool-execute_script',
      toolCallId: 'toolu_appr_exec_1',
      state: 'approval-responded',
      input: { script: 'Start-Sleep -Seconds 300' },
      approval: { id: 'appr_3', approved: true },
    };
    const messages = [
      userMsg('u1', 'run the long script'),
      assistantMsg('a1', [{ type: 'text', text: 'running that now' }, approvedInflight]),
      userMsg('u2', 'while that runs, what is the uptime?'),
    ];

    const { messages: out, repairedToolCallIds } = repairDanglingToolParts(messages);

    expect(repairedToolCallIds).toEqual(['toolu_appr_exec_1']);
    const part = (out[1].parts as Array<Record<string, unknown>>)[1];
    expect(part).toMatchObject({
      type: 'tool-execute_script',
      toolCallId: 'toolu_appr_exec_1',
      state: 'output-error',
      errorText: LOST_RESULT_ERROR,
    });
    expect(part.approval).toBeUndefined();
  });

  it('recovers the real result for an APPROVED approval-responded part via the resolver', async () => {
    const approvedInflight = {
      type: 'tool-execute_script',
      toolCallId: 'toolu_appr_exec_2',
      state: 'approval-responded',
      input: { script: 'Get-Uptime' },
      approval: { id: 'appr_4', approved: true },
    };
    const messages = [
      userMsg('u1', 'run it'),
      assistantMsg('a1', [approvedInflight]),
      userMsg('u2', 'and?'),
    ];

    const seen: string[] = [];
    const { messages: out } = await repairDanglingToolParts(messages, {
      resolveLostResult: async (id) => {
        seen.push(id);
        return { output: { exit_code: 0, stdout: 'up 3 days' } };
      },
    });

    expect(seen).toContain('toolu_appr_exec_2');
    expect((out[1].parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      state: 'output-available',
      output: { exit_code: 0, stdout: 'up 3 days' },
    });
  });

  // The regression pin this module exists for: the prod failure shape (dangling tool call
  // followed by user messages) throws MissingToolResultsError during streamText's prompt
  // preparation — inside convertToLanguageModelPrompt, NOT convertToModelMessages, so the
  // pin must exercise streamText itself. The repaired history streams cleanly.
  it('unbricks streamText for the prod failure shape', async () => {
    const broken = [
      userMsg('u1', 'run sfc /scannow and DISM in parallel'),
      assistantMsg('a1', [
        { type: 'text', text: "I'll run both." },
        completedToolPart,
        danglingToolPart,
      ]),
      userMsg('u2', 'looks like one is still running, right?'),
      userMsg('u3', 'still running?'),
    ];

    async function streamErrors(messages: UIMessage[]): Promise<unknown[]> {
      const errors: unknown[] = [];
      const result = streamText({
        model: new MockLanguageModelV3({
          doStream: async () => ({
            stream: simulateReadableStream({
              chunks: [
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'ok' },
                { type: 'text-end', id: 't1' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: undefined },
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
            }),
          }),
        }),
        messages: await convertToModelMessages(messages),
        onError: ({ error }) => {
          errors.push(error);
        },
      });
      await result.consumeStream();
      return errors;
    }

    const brokenErrors = await streamErrors(broken);
    expect(brokenErrors.some((e) => /missing for tool call.*toolu_dangling_1/.test(String(e)))).toBe(
      true,
    );

    const { messages: repaired } = repairDanglingToolParts(broken);
    const repairedErrors = await streamErrors(repaired);
    expect(repairedErrors).toEqual([]);

    // The dangling call now has a matching error tool-result, satisfying SDK validation.
    const modelMessages = await convertToModelMessages(repaired);
    const toolResults = modelMessages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content as Array<{ type: string; toolCallId?: string }>);
    expect(toolResults.some((c) => c.toolCallId === 'toolu_dangling_1')).toBe(true);
  });
});

describe('a denied call', () => {
  const denied = {
    type: 'tool-set_launch_mode',
    toolCallId: 'denied_1',
    state: 'output-denied',
    input: { process_name: 'P', mode: 'always' },
  };
  const history = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }] },
    { id: 'a1', role: 'assistant', parts: [denied] },
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'why not?' }] },
  ] as unknown as UIMessage[];

  it('stays denied on the next turn, and asks no resolver', async () => {
    const resolveLostResult = jest.fn();

    const { messages, repairedToolCallIds } = await repairDanglingToolParts(history, { resolveLostResult });

    expect(messages[1].parts[0]).toEqual(denied);
    expect(repairedToolCallIds).toEqual([]);
    expect(resolveLostResult).not.toHaveBeenCalled();
  });
});

describe('repairDanglingToolParts with resolveLostResult (async overload)', () => {
  function brokenHistory(): UIMessage[] {
    return [
      userMsg('u1', 'run sfc and dism'),
      assistantMsg('a1', [{ type: 'text', text: 'running both' }, completedToolPart, danglingToolPart]),
      userMsg('u2', 'still running?'),
    ];
  }

  it('splices a recovered { output } in as output-available', async () => {
    const recovered = { exit_code: 0, stdout: 'scan complete, no violations' };
    const resolveLostResult = jest.fn().mockResolvedValue({ output: recovered });

    const { messages: out, repairedToolCallIds } = await repairDanglingToolParts(brokenHistory(), {
      resolveLostResult,
    });

    expect(resolveLostResult).toHaveBeenCalledTimes(1);
    expect(resolveLostResult).toHaveBeenCalledWith('toolu_dangling_1');
    expect(repairedToolCallIds).toEqual(['toolu_dangling_1']);
    const parts = out[1].parts as Array<Record<string, unknown>>;
    expect(parts[1]).toBe(completedToolPart); // untouched sibling
    expect(parts[2]).toMatchObject({
      type: 'tool-execute_script',
      toolCallId: 'toolu_dangling_1',
      state: 'output-available',
      output: recovered,
      input: danglingToolPart.input, // captured input preserved
    });
    expect((parts[2] as Record<string, unknown>).errorText).toBeUndefined();

    // The recovered history must also satisfy the SDK's validation.
    const modelMessages = await convertToModelMessages(out);
    const toolResults = modelMessages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content as Array<{ type: string; toolCallId?: string }>);
    expect(toolResults.some((c) => c.toolCallId === 'toolu_dangling_1')).toBe(true);
  });

  it('uses a resolver-supplied { errorText } for the output-error', async () => {
    const { messages: out } = await repairDanglingToolParts(brokenHistory(), {
      resolveLostResult: async () => ({ errorText: STILL_RUNNING_ERROR }),
    });

    expect((out[1].parts as Array<Record<string, unknown>>)[2]).toMatchObject({
      state: 'output-error',
      errorText: STILL_RUNNING_ERROR,
      input: danglingToolPart.input,
    });
  });

  it('falls back to LOST_RESULT_ERROR when the resolver returns null', async () => {
    const { messages: out, repairedToolCallIds } = await repairDanglingToolParts(brokenHistory(), {
      resolveLostResult: async () => null,
    });

    expect(repairedToolCallIds).toEqual(['toolu_dangling_1']);
    expect((out[1].parts as Array<Record<string, unknown>>)[2]).toMatchObject({
      state: 'output-error',
      errorText: LOST_RESULT_ERROR,
    });
  });

  it('never invokes the resolver for superseded approval-requested parts', async () => {
    const resolveLostResult = jest.fn().mockResolvedValue({ output: { exit_code: 0 } });
    const messages = [
      userMsg('u1', 'reboot it'),
      assistantMsg('a1', [
        {
          type: 'tool-reboot_machine',
          toolCallId: 'toolu_approval_1',
          state: 'approval-requested',
          input: {},
          approval: { id: 'appr_1' },
        },
      ]),
      userMsg('u2', 'actually, wait'),
    ];

    const { messages: out, repairedToolCallIds } = await repairDanglingToolParts(messages, {
      resolveLostResult,
    });

    expect(resolveLostResult).not.toHaveBeenCalled();
    expect(repairedToolCallIds).toEqual(['toolu_approval_1']);
    expect((out[1].parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      state: 'output-error',
      errorText: SUPERSEDED_APPROVAL_ERROR, // the tool never ran — not resolver-eligible
    });
  });

  it('keeps the no-opts signature synchronous (not a Promise)', () => {
    const result = repairDanglingToolParts(brokenHistory());

    expect(result).not.toBeInstanceOf(Promise);
    expect(result.repairedToolCallIds).toEqual(['toolu_dangling_1']);
  });
});

// One-shot approval consumption (OWL-47): the IN-FLIGHT assistant segment's answered
// approvals are claimed atomically; a lost claim rewrites the part terminal so the SDK
// never re-executes an already-dispatched tier-3 tool.
describe('applyApprovalConsumption', () => {
  const approvedPart = (toolCallId: string) => ({
    type: 'tool-reboot_machine',
    toolCallId,
    state: 'approval-responded',
    input: {},
    approval: { id: `appr_${toolCallId}`, approved: true },
  });
  const deniedPart = (toolCallId: string) => ({
    type: 'tool-reboot_machine',
    toolCallId,
    state: 'approval-responded',
    input: {},
    approval: { id: `appr_${toolCallId}`, approved: false },
  });

  const claimed = jest.fn().mockResolvedValue('claimed');
  const consumed = jest.fn().mockResolvedValue('already-consumed');
  const noResolution = jest.fn().mockResolvedValue(null);

  beforeEach(() => jest.clearAllMocks());

  it('leaves a freshly-claimed approval untouched (this turn owns the dispatch)', async () => {
    const messages = [userMsg('u1', 'reboot it'), assistantMsg('a1', [approvedPart('tc1')])];

    const { messages: out, consumedParts } = await applyApprovalConsumption(messages, {
      claim: claimed,
      resolveLostResult: noResolution,
    });

    expect(claimed).toHaveBeenCalledWith('tc1');
    expect(consumedParts.size).toBe(0);
    expect(out[1]).toBe(messages[1]);
    expect(noResolution).not.toHaveBeenCalled();
  });

  it('rewrites an already-consumed approval to APPROVAL_ALREADY_CONSUMED_ERROR', async () => {
    const messages = [userMsg('u1', 'reboot it'), assistantMsg('a1', [approvedPart('tc1')])];

    const { messages: out, consumedParts } = await applyApprovalConsumption(messages, {
      claim: consumed,
      resolveLostResult: noResolution,
    });

    const part = (out[1].parts as Array<Record<string, unknown>>)[0];
    expect(part).toMatchObject({
      state: 'output-error',
      toolCallId: 'tc1',
      errorText: APPROVAL_ALREADY_CONSUMED_ERROR,
    });
    expect(part.approval).toBeUndefined();
    expect(consumedParts.get('tc1')).toBe(part);
  });

  it('splices in the real result when the resolver recovers one', async () => {
    const messages = [userMsg('u1', 'reboot it'), assistantMsg('a1', [approvedPart('tc1')])];
    const resolver = jest.fn().mockResolvedValue({ output: { exit_code: 0 } });

    const { messages: out } = await applyApprovalConsumption(messages, {
      claim: consumed,
      resolveLostResult: resolver,
    });

    expect((out[1].parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      state: 'output-available',
      output: { exit_code: 0 },
    });
  });

  it('rewrites a late denial (approval consumed elsewhere) to LATE_DENIAL_ERROR', async () => {
    const messages = [userMsg('u1', 'reboot it'), assistantMsg('a1', [deniedPart('tc1')])];

    const { messages: out } = await applyApprovalConsumption(messages, {
      claim: consumed,
      resolveLostResult: noResolution,
    });

    expect((out[1].parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      state: 'output-error',
      errorText: LATE_DENIAL_ERROR,
    });
    expect(noResolution).not.toHaveBeenCalled(); // denials never dispatched from here
  });

  it('leaves a normally-denied approval untouched when the claim succeeds', async () => {
    const messages = [userMsg('u1', 'reboot it'), assistantMsg('a1', [deniedPart('tc1')])];

    const { messages: out, consumedParts } = await applyApprovalConsumption(messages, {
      claim: claimed,
      resolveLostResult: noResolution,
    });

    expect(out[1]).toBe(messages[1]);
    expect(consumedParts.size).toBe(0);
  });

  it('never touches assistant turns at or before the last user message', async () => {
    const messages = [
      userMsg('u1', 'first'),
      assistantMsg('a1', [approvedPart('tc_old')]),
      userMsg('u2', 'second'),
      assistantMsg('a2', [{ type: 'text', text: 'ok' }]),
    ];

    const { messages: out } = await applyApprovalConsumption(messages, {
      claim: consumed,
      resolveLostResult: noResolution,
    });

    expect(claimed).not.toHaveBeenCalled();
    expect(consumed).not.toHaveBeenCalled();
    expect(out[1]).toBe(messages[1]);
  });
});

describe('reapplyConsumedParts', () => {
  it('replaces a resurfaced approval-responded part and leaves terminal parts alone', () => {
    const rewritten = {
      type: 'tool-reboot_machine',
      toolCallId: 'tc1',
      state: 'output-error',
      input: {},
      errorText: APPROVAL_ALREADY_CONSUMED_ERROR,
    };
    const consumedParts = new Map([['tc1', rewritten as never]]);

    const resurfaced = assistantMsg('a1', [
      {
        type: 'tool-reboot_machine',
        toolCallId: 'tc1',
        state: 'approval-responded',
        input: {},
        approval: { id: 'appr_tc1', approved: true },
      },
      completedToolPart,
    ]);
    const out = reapplyConsumedParts([userMsg('u1', 'go'), resurfaced], consumedParts);

    expect((out[1].parts as Array<Record<string, unknown>>)[0]).toBe(rewritten);
    expect((out[1].parts as Array<Record<string, unknown>>)[1]).toBe(completedToolPart);

    // A part the SDK actually finished is NOT clobbered.
    const finished = assistantMsg('a2', [
      { type: 'tool-reboot_machine', toolCallId: 'tc1', state: 'output-available', input: {}, output: { ok: true } },
    ]);
    const out2 = reapplyConsumedParts([finished], consumedParts);
    expect(out2[0]).toBe(finished);
  });

  it('is a no-op passthrough for an empty map', () => {
    const messages = [userMsg('u1', 'go')];
    expect(reapplyConsumedParts(messages, new Map())).toBe(messages);
  });
});

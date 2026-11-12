/** @jest-environment node */

/**
 * Hoot dispatch audit integration.
 *
 * Uses the real `invokeAsSystem` entry point with mocked audit/rate-limit
 * dependencies so the test observes the actual allow audit entry produced
 * before `executeMachineCommand` writes the pending command.
 */

import { Capability } from '@/lib/capabilities';

const mockBlockingAuditCalls: Array<{
  siteId: string;
  entry: Record<string, unknown>;
}> = [];

jest.mock('firebase-admin/firestore', () => {
  class FakeTimestamp {
    static fromMillis(ms: number) {
      return { _ms: ms, isFakeTimestamp: true };
    }
  }
  return {
    __esModule: true,
    FieldValue: {
      delete: () => '__FIELD_DELETE__',
      serverTimestamp: () => '__SERVER_TS__',
    },
    Timestamp: FakeTimestamp,
  };
});

jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  getAdminDb: jest.fn(() => {
    throw new Error('dispatch audit tests must inject db');
  }),
}));

process.env.CORTEX_INTERNAL_SECRET = 'test-secret';

jest.mock('@/lib/hoot-utils.server', () => ({
  __esModule: true,
  COMMAND_POLL_INTERVAL_MS: 0,
  COMMAND_TIMEOUT_MS: 30000,
}));

jest.mock('@/lib/auditLogClient', () => ({
  __esModule: true,
  emitMutation: jest.fn(),
}));

jest.mock('@/lib/auditLog.server', () => ({
  __esModule: true,
  generateCorrelationId: () => 'corr_hoot_audit',
  writeAuditEntry: jest.fn(),
  writeAuditEntryBlocking: async (siteId: string, entry: Record<string, unknown>) => {
    mockBlockingAuditCalls.push({ siteId, entry });
  },
}));

jest.mock('@/lib/rateLimit.server', () => ({
  __esModule: true,
  checkRateLimit: jest.fn(async () => ({ ok: true })),
  bucketForActor: (actor: { type: string }) => (actor.type === 'system' ? 'system' : 'user'),
}));

jest.mock('@/lib/securityConfig.server', () => ({
  __esModule: true,
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: true,
      rate_limit_enforcement: true,
      lastUpdated: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    })),
  },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

import {
  dispatchToolCallAsSystem,
  type AutonomousDispatchContext,
} from '@/lib/hoot/dispatch.server';

function buildFakeDb() {
  function makeCollection(parentPath: string[]): { doc: (id: string) => unknown } {
    return {
      doc: (id: string) => {
        const docPath = [...parentPath, id];
        return {
          set: jest.fn(async () => undefined),
          update: jest.fn(async () => undefined),
          get: jest.fn(async () => {
            if (docPath[docPath.length - 1] === 'completed') {
              return {
                exists: true,
                data: () =>
                  new Proxy({}, {
                    get: (_target, key) => {
                      if (typeof key === 'string' && key.startsWith('cmd_')) {
                        return { status: 'success', result: { ok: true } };
                      }
                      return undefined;
                    },
                  }),
              };
            }
            if (
              docPath.length === 4 &&
              docPath[0] === 'sites' &&
              docPath[2] === 'machines'
            ) {
              return { exists: true, data: () => ({ online: true }) };
            }
            return { exists: false, data: () => undefined };
          }),
          collection: (name: string) => makeCollection([...docPath, name]),
        };
      },
    };
  }

  return {
    collection: (name: string) => makeCollection([name]),
  } as unknown as FirebaseFirestore.Firestore;
}

describe('hoot dispatch audit entries', () => {
  beforeEach(() => {
    mockBlockingAuditCalls.length = 0;
  });

  it('writes the allow audit as the cortex_autonomous system actor', async () => {
    const ctx: AutonomousDispatchContext = {
      db: buildFakeDb(),
      siteId: 'site-a',
      machineId: 'machine-1',
      chatId: 'auto_chat_1',
      eventId: 'evt_1',
    };

    await dispatchToolCallAsSystem(ctx, 'get_system_info', {});

    expect(mockBlockingAuditCalls).toHaveLength(1);
    expect(mockBlockingAuditCalls[0].siteId).toBe('site-a');
    expect(mockBlockingAuditCalls[0].entry).toMatchObject({
      correlationId: 'corr_hoot_audit',
      actor: {
        type: 'system',
        name: 'cortex_autonomous',
      },
      capability: Capability.MACHINE_EXEC_COMMAND,
      target: {
        kind: 'machine',
        id: 'machine-1',
        machineId: 'machine-1',
      },
      outcome: 'allow',
      metadata: {
        cortexChatId: 'auto_chat_1',
        cortexEventId: 'evt_1',
        toolName: 'get_system_info',
        commandType: 'mcp_tool_call',
        paramNames: [],
        paramsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });
});

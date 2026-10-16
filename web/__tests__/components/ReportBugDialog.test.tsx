/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * ReportBugDialog — the success toast names the issue number that
 * POST /api/bug-report returns, and falls back to the plain toast when the
 * response carries no integer number.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReportBugDialog } from '@/components/ReportBugDialog';
import { toast } from '@/lib/toast';

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
});

function respond(body: unknown) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => body });
}

async function submit() {
  const user = userEvent.setup();
  const onOpenChange = jest.fn();
  render(<ReportBugDialog open onOpenChange={onOpenChange} />);
  await user.type(screen.getByLabelText('title'), 'it broke');
  await user.type(screen.getByLabelText('description'), 'the thing stopped');
  await user.click(screen.getByRole('button', { name: 'submit' }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
}

describe('ReportBugDialog success toast', () => {
  it('names the issue number when the response carries one', async () => {
    respond({ success: true, id: 'abc', number: 42 });
    await submit();
    expect(fetchMock).toHaveBeenCalledWith('/api/bug-report', expect.objectContaining({ method: 'POST' }));
    expect(toast.success).toHaveBeenCalledWith('issue #42 submitted — thank you!');
  });

  it.each([
    ['no number', { success: true, id: 'abc' }],
    ['a null number', { success: true, id: 'abc', number: null }],
    ['a non-integer number', { success: true, id: 'abc', number: '42' }],
  ])('falls back to the plain toast for %s', async (_label, body) => {
    respond(body);
    await submit();
    expect(toast.success).toHaveBeenCalledWith('issue submitted — thank you!');
  });

  it('falls back when the body is not json', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new Error('not json'); } });
    await submit();
    expect(toast.success).toHaveBeenCalledWith('issue submitted — thank you!');
  });
});

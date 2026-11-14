/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * BackupCodesPanel — the shown-once sheet can be saved as a file, not only
 * copied to a clipboard the next copy overwrites.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BackupCodesPanel } from '@/components/BackupCodesPanel';

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const codes = Array.from({ length: 10 }, (_, i) => `CODE${String(i).padStart(16, '0')}`);

function captureDownload() {
  const clicked: HTMLAnchorElement[] = [];
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
  return clicked;
}

function fileText(a: HTMLAnchorElement): string {
  const [, body] = a.href.split(',');
  return decodeURIComponent(body);
}

afterEach(() => jest.restoreAllMocks());

test('download codes saves every code, numbered, with the account it belongs to', async () => {
  const clicked = captureDownload();
  render(<BackupCodesPanel codes={codes} account="ops@example.com" />);

  await userEvent.click(screen.getByRole('button', { name: 'download codes' }));

  expect(clicked).toHaveLength(1);
  expect(clicked[0].download).toBe('owlette-backup-codes.txt');
  expect(clicked[0].href).toMatch(/^data:text\/plain;charset=utf-8,/);
  const text = fileText(clicked[0]);
  expect(text).toContain('account: ops@example.com');
  expect(text).toContain(`1.  ${codes[0]}\n`);
  expect(text).toContain(`10. ${codes[9]}\n`);
  for (const code of codes) expect(text).toContain(code);
});

test('the file leaves the account line out when there is no email', async () => {
  const clicked = captureDownload();
  render(<BackupCodesPanel codes={codes} />);

  await userEvent.click(screen.getByRole('button', { name: 'download codes' }));

  expect(fileText(clicked[0])).not.toContain('account:');
});

/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /add's success screen: a machine that asked for hoot at pairing offers the
 * site admin the allow card; everything else keeps the plain screen.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddMachinePage from '@/app/add/page';

let administers = true;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1', email: 'a@b.c' },
    loading: false,
    isSuperadmin: false,
    userSites: ['site 1'],
    isSiteAdmin: () => administers,
  }),
}));
jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  doc: jest.fn(),
  getDoc: jest.fn().mockResolvedValue({ exists: () => true, id: 'site 1', data: () => ({ name: 'one' }) }),
}));

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

let wantsHoot = true;
jest.mock('@/hooks/useDeviceCodeAuthorize', () => ({
  useDeviceCodeAuthorize: () => ({
    phrase: '',
    setPhrase: jest.fn(),
    review: null,
    lookUp: jest.fn(),
    authorize: jest.fn(),
    cancel: jest.fn(),
    isAuthorizing: false,
    success: true,
    authorizedMachineId: 'kiosk 1',
    authorizedWantsHoot: wantsHoot,
  }),
}));

beforeEach(() => {
  push.mockClear();
  administers = true;
  wantsHoot = true;
});

test('a site admin is offered the allow card, and can decline it', async () => {
  render(<AddMachinePage />);

  expect(await screen.findByText(/asked to let/i)).toHaveTextContent(
    'kiosk 1 asked to let ai tools on it act on other machines.',
  );
  await userEvent.click(screen.getByRole('button', { name: 'allow it to use hoot' }));
  expect(push).toHaveBeenCalledWith('/admin/hoot?site=site%201&machine=kiosk%201');

  await userEvent.click(screen.getByRole('button', { name: 'not now' }));
  expect(push).toHaveBeenLastCalledWith('/dashboard');
});

test('a machine that did not ask keeps the plain screen', async () => {
  wantsHoot = false;
  render(<AddMachinePage />);

  expect(await screen.findByRole('button', { name: 'go to dashboard' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'allow it to use hoot' })).toBeNull();
});

test('a member who does not administer the site keeps the plain screen', async () => {
  administers = false;
  render(<AddMachinePage />);

  expect(await screen.findByRole('button', { name: 'go to dashboard' })).toBeInTheDocument();
  expect(screen.queryByText(/asked to let/i)).toBeNull();
});

/**
 * @jest-environment jsdom
 *
 * A failed sign-in, sign-up or google sign-in shows one toast. /login and
 * /register own it (they toast what they caught); the context used to toast
 * the same failure first, so every mistyped password showed two. A sign-up
 * also toasted "you can now sign in" to a user it had just signed in.
 */
import { useEffect } from 'react';
import { act, render } from '@testing-library/react';

jest.mock('@/lib/firebase', () => ({ auth: {}, db: {}, storage: null }));

const signInWithEmailAndPassword = jest.fn();
const createUserWithEmailAndPassword = jest.fn();
const signInWithPopup = jest.fn();

jest.mock('firebase/auth', () => ({
  onAuthStateChanged: jest.fn(() => () => {}),
  GoogleAuthProvider: class {},
  EmailAuthProvider: { credential: jest.fn() },
  signInWithEmailAndPassword: (...args: unknown[]) => signInWithEmailAndPassword(...args),
  createUserWithEmailAndPassword: (...args: unknown[]) => createUserWithEmailAndPassword(...args),
  signOut: jest.fn(),
  getAdditionalUserInfo: jest.fn(),
  signInWithPopup: (...args: unknown[]) => signInWithPopup(...args),
  updateProfile: jest.fn(),
  updatePassword: jest.fn(),
  reauthenticateWithCredential: jest.fn(),
}));

jest.mock('firebase/firestore', () => ({
  doc: jest.fn(() => ({})),
  setDoc: jest.fn(async () => {}),
  collectionGroup: jest.fn(() => ({})),
  where: jest.fn(() => ({})),
  query: jest.fn((ref: unknown) => ref),
  onSnapshot: jest.fn(() => () => {}),
}));

jest.mock('firebase/storage', () => ({
  ref: jest.fn(),
  uploadBytes: jest.fn(),
  getDownloadURL: jest.fn(),
  deleteObject: jest.fn(),
}));

const captureException = jest.fn();
jest.mock('@sentry/nextjs', () => ({
  setUser: jest.fn(),
  captureMessage: jest.fn(),
  captureException: (...args: unknown[]) => captureException(...args),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

import { toast } from '@/lib/toast';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';

let auth: ReturnType<typeof useAuth>;
function Probe() {
  const value = useAuth();
  useEffect(() => {
    auth = value;
  });
  return null;
}

function mount() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

const wrongPassword = Object.assign(new Error('Firebase: wrong password'), { code: 'auth/wrong-password' });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('a failed sign-in throws for the page to say, and toasts nothing itself', async () => {
  signInWithEmailAndPassword.mockRejectedValue(wrongPassword);
  mount();

  await act(async () => {
    await expect(auth.signIn('dylan@example.com', 'nope')).rejects.toBe(wrongPassword);
  });

  expect(toast.error).not.toHaveBeenCalled();
});

it('a failed google sign-in throws for the page to say, and toasts nothing itself', async () => {
  signInWithPopup.mockRejectedValue(Object.assign(new Error('Firebase: internal'), { code: 'auth/internal-error' }));
  mount();

  await act(async () => {
    await expect(auth.signInWithGoogle()).rejects.toThrow('Firebase: internal');
  });

  expect(toast.error).not.toHaveBeenCalled();
});

it('a failed sign-up throws for the page to say, and toasts nothing itself', async () => {
  createUserWithEmailAndPassword.mockRejectedValue(
    Object.assign(new Error('Firebase: weak password'), { code: 'auth/weak-password' }),
  );
  mount();

  await act(async () => {
    await expect(auth.signUp('dylan@example.com', 'x')).rejects.toThrow('Firebase: weak password');
  });

  expect(toast.error).not.toHaveBeenCalled();
});

it('a sign-up leaves its success to the page, which signs the user straight in', async () => {
  createUserWithEmailAndPassword.mockResolvedValue({ user: { uid: 'dylan', email: 'dylan@example.com', getIdToken: async () => 't' } });
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
  mount();

  await act(async () => {
    await auth.signUp('dylan@example.com', 'a-long-password');
  });

  expect(toast.success).not.toHaveBeenCalled();
});

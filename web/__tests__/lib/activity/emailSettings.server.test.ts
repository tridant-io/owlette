/**
 * @jest-environment node
 */
import { emailSettingsFrom } from '@/lib/activity/emailSettings.server';

const snap = (fields: Record<string, unknown>) => ({ get: (field: string) => fields[field] });

const originalActivity = process.env.ACTIVITY_EMAIL;
const originalAdmin = process.env.ADMIN_EMAIL_DEV;

beforeEach(() => {
  delete process.env.ACTIVITY_EMAIL;
  delete process.env.ADMIN_EMAIL_DEV;
});

afterAll(() => {
  if (originalActivity !== undefined) process.env.ACTIVITY_EMAIL = originalActivity;
  if (originalAdmin !== undefined) process.env.ADMIN_EMAIL_DEV = originalAdmin;
});

describe('emailSettingsFrom', () => {
  it('is on by default', () => {
    expect(emailSettingsFrom(snap({})).enabled).toBe(true);
    expect(emailSettingsFrom(snap({ emailEnabled: false })).enabled).toBe(false);
  });

  it('starts a list nobody has saved with the configured address', () => {
    process.env.ADMIN_EMAIL_DEV = 'admin@example.test';
    expect(emailSettingsFrom(snap({})).recipients).toEqual(['admin@example.test']);

    process.env.ACTIVITY_EMAIL = 'watch@example.test';
    expect(emailSettingsFrom(snap({})).recipients).toEqual(['watch@example.test']);
  });

  it('starts it empty when no address is configured', () => {
    expect(emailSettingsFrom(snap({})).recipients).toEqual([]);
  });

  it('keeps a saved list as it is, an emptied one included', () => {
    process.env.ACTIVITY_EMAIL = 'watch@example.test';
    expect(emailSettingsFrom(snap({ emailRecipients: ['a@example.test'] })).recipients).toEqual(['a@example.test']);
    expect(emailSettingsFrom(snap({ emailRecipients: [] })).recipients).toEqual([]);
  });
});

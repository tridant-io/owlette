/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the general section of a site's settings: the site's name and timezone, and
 * one save that sends only what changed. a site with no timezone shows UTC, and
 * a rename must not store that UTC as if someone had picked it.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from '@/lib/toast';
import { SiteGeneralSection } from '@/components/admin/sites/SiteGeneralSection';

// jsdom ships no ResizeObserver; radix's popover positioning constructs one
// when the timezone select opens.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

type Site = { id: string; name: string; timezone?: string };
type Updates = { name?: string; timezone?: string };
type User = ReturnType<typeof userEvent.setup>;

const SITE: Site = { id: 'site-a', name: 'Site A', timezone: 'Europe/Berlin' };

function renderSection(site: Site = SITE, onSave = jest.fn(async (_siteId: string, _updates: Updates) => {})) {
  const user = userEvent.setup();
  render(<SiteGeneralSection site={site} onSave={onSave} />);
  return { user, onSave };
}

const nameField = () => screen.getByRole('textbox', { name: 'site name' });
const timezoneField = () => screen.getByRole('combobox', { name: 'timezone' });
const saveButton = () => screen.getByRole('button', { name: 'save' });

async function rename(user: User, next: string) {
  await user.clear(nameField());
  await user.type(nameField(), next);
}

async function pickTimezone(user: User, city: string) {
  await user.click(timezoneField());
  await user.type(screen.getByRole('textbox', { name: 'search timezones' }), city);
  await user.click(await screen.findByRole('button', { name: new RegExp(city) }));
}

describe('the general section', () => {
  it("is a panel holding the site's name and timezone", () => {
    renderSection();

    const panel = screen.getByRole('region', { name: 'general' });
    expect(within(panel).getByRole('heading', { level: 2, name: 'general' })).toHaveAttribute(
      'id',
      'site-section-general',
    );
    expect(
      within(panel).getByText("the site's name, and the timezone its talons and site-time schedules run on."),
    ).toBeInTheDocument();
    expect(nameField()).toHaveAttribute('id', 'site-settings-name');
    expect(nameField()).toHaveValue('Site A');
    expect(timezoneField()).toHaveAttribute('id', 'site-settings-timezone');
    expect(timezoneField()).toHaveTextContent('Berlin (CET)');
  });
});

describe('save', () => {
  it('is disabled until something changes, and again once it is put back', async () => {
    const { user } = renderSection();
    expect(saveButton()).toBeDisabled();

    await rename(user, 'Site B');
    expect(saveButton()).toBeEnabled();

    // the name is compared trimmed, so stray spaces are no change
    await rename(user, '  Site A  ');
    expect(saveButton()).toBeDisabled();

    await pickTimezone(user, 'Tokyo');
    expect(saveButton()).toBeEnabled();

    await pickTimezone(user, 'Berlin');
    expect(saveButton()).toBeDisabled();
  });

  it('counts a site with no timezone as UTC, and a rename leaves its timezone unset', async () => {
    const { user, onSave } = renderSection({ id: 'site-a', name: 'Site A' });
    expect(timezoneField()).toHaveTextContent('UTC');
    expect(saveButton()).toBeDisabled();

    await rename(user, 'Site B');
    await user.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]).toStrictEqual(['site-a', { name: 'Site B' }]);
  });

  it('sends only the name, trimmed, when only the name changed', async () => {
    const { user, onSave } = renderSection();

    await rename(user, '  Site B  ');
    await user.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]).toStrictEqual(['site-a', { name: 'Site B' }]);
  });

  it('sends only the timezone when only the timezone changed', async () => {
    const { user, onSave } = renderSection();

    await pickTimezone(user, 'Tokyo');
    await user.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]).toStrictEqual(['site-a', { timezone: 'Asia/Tokyo' }]);
  });

  it('sends both when both changed', async () => {
    const { user, onSave } = renderSection();

    await rename(user, 'Site B');
    await pickTimezone(user, 'Tokyo');
    await user.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]).toStrictEqual(['site-a', { name: 'Site B', timezone: 'Asia/Tokyo' }]);
  });

  it('refuses an empty name with a toast, and sends nothing', async () => {
    const { user, onSave } = renderSection();

    await user.clear(nameField());
    await user.click(saveButton());
    await user.type(nameField(), '   ');
    await user.click(saveButton());

    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenNthCalledWith(1, 'site name cannot be empty');
    expect(toast.error).toHaveBeenNthCalledWith(2, 'site name cannot be empty');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves on enter in the name field, and enter with nothing changed sends nothing', async () => {
    const { user, onSave } = renderSection();

    await user.type(nameField(), '{Enter}');
    expect(onSave).not.toHaveBeenCalled();

    await rename(user, 'Site B{Enter}');

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]).toStrictEqual(['site-a', { name: 'Site B' }]);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('site updated'));
  });

  it('reads saving… and takes no second save while one is in flight', async () => {
    let finish: () => void = () => {};
    const onSave = jest.fn(
      (_siteId: string, _updates: Updates) =>
        new Promise<void>((resolve) => {
          finish = () => resolve();
        }),
    );
    const { user } = renderSection(SITE, onSave);

    await rename(user, 'Site B');
    await user.click(saveButton());

    expect(screen.getByRole('button', { name: 'saving…' })).toBeDisabled();
    await user.type(nameField(), '{Enter}');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();

    finish();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('site updated'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts a failure with its message, and keeps the edit to try again', async () => {
    const onSave = jest.fn(async (_siteId: string, _updates: Updates) => {
      throw new Error('capability not granted');
    });
    const { user } = renderSection(SITE, onSave);

    await rename(user, 'Site B');
    await user.click(saveButton());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('could not update the site', { description: 'capability not granted' }),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(nameField()).toHaveValue('Site B');
    await waitFor(() => expect(saveButton()).toBeEnabled());
  });
});

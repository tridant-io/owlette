/// <reference types="@testing-library/jest-dom" />
import { createElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  ApiKeyScopeFields,
  customScopesForSelection,
  presetForScopes,
  resolveScopes,
  validateScopeSelection,
} from '@/components/ApiKeyScopeFields';
import {
  SCOPE_PRESETS,
  SUPERADMIN_ONLY_RESOURCES,
  type ApiKeyScope,
} from '@/lib/apiKeyTypes';

let mockIsSuperadmin = false;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isSuperadmin: mockIsSuperadmin }),
}));

// radix select drives its trigger with pointer capture and scrolls the active item into view
window.HTMLElement.prototype.scrollIntoView = jest.fn();
window.HTMLElement.prototype.hasPointerCapture = jest.fn();

/**
 * The pure half of the shared scope builder. `presetForScopes` is the piece
 * with a real failure mode: it decides whether a key reopens on its minting
 * preset or drops into the sixteen-checkbox custom builder, and getting it
 * wrong silently converts every edited preset key into a custom one.
 */

describe('presetForScopes', () => {
  it.each(Object.keys(SCOPE_PRESETS) as (keyof typeof SCOPE_PRESETS)[])(
    'recognises the %s preset from its expanded scopes',
    (preset) => {
      expect(presetForScopes(SCOPE_PRESETS[preset])).toBe(preset);
    },
  );

  it('matches regardless of scope or permission ordering', () => {
    const shuffled = [...SCOPE_PRESETS.publisher]
      .reverse()
      .map((s) => ({ ...s, permissions: [...s.permissions].reverse() }));
    expect(presetForScopes(shuffled)).toBe('publisher');
  });

  it('falls back to custom when a preset is one permission off', () => {
    const nearlyPublisher = SCOPE_PRESETS.publisher.map((s, i) =>
      i === 0 ? { ...s, permissions: ['read' as const] } : s,
    );
    expect(presetForScopes(nearlyPublisher)).toBe('custom');
  });

  it('falls back to custom when a preset has an extra scope', () => {
    const widened: ApiKeyScope[] = [
      ...SCOPE_PRESETS.readonly,
      { resource: 'installer', id: '*', permissions: ['write'] },
    ];
    expect(presetForScopes(widened)).toBe('custom');
  });

  it('treats a legacy key with no scopes as custom', () => {
    expect(presetForScopes(null)).toBe('custom');
    expect(presetForScopes([])).toBe('custom');
  });
});

describe('resolveScopes', () => {
  it('expands a preset and ignores whatever is in the custom builder', () => {
    const custom: ApiKeyScope[] = [{ resource: 'site', id: 'abc', permissions: ['admin'] }];
    expect(resolveScopes('operator', custom)).toEqual(SCOPE_PRESETS.operator);
  });

  it('passes custom scopes through untouched', () => {
    const custom: ApiKeyScope[] = [{ resource: 'installer', id: '*', permissions: ['write'] }];
    expect(resolveScopes('custom', custom)).toEqual(custom);
  });
});

describe('validateScopeSelection', () => {
  it('never blocks a preset, even with an empty custom builder', () => {
    expect(validateScopeSelection('publisher', [])).toBeNull();
  });

  it('rejects an empty custom scope list', () => {
    expect(validateScopeSelection('custom', [])).toBe('add at least one scope');
  });

  it('rejects a blank id, naming the offending row', () => {
    expect(
      validateScopeSelection('custom', [{ resource: 'site', id: '  ', permissions: ['read'] }]),
    ).toBe('scope 1: id is required (use * for all)');
  });

  it('rejects a scope with no permissions checked', () => {
    expect(
      validateScopeSelection('custom', [
        { resource: 'site', id: '*', permissions: ['read'] },
        { resource: 'machine', id: '*', permissions: [] },
      ]),
    ).toBe('scope 2: pick at least one permission');
  });

  it('accepts a well-formed custom selection', () => {
    expect(
      validateScopeSelection('custom', [
        { resource: 'installer', id: '*', permissions: ['read', 'write'] },
      ]),
    ).toBeNull();
  });
});

describe('customScopesForSelection', () => {
  const grants = (scopes: ApiKeyScope[]) =>
    scopes.reduce((n, s) => n + s.permissions.length, 0);

  it('carries the selected preset into the builder (regression: preset->custom scope loss)', () => {
    const seeded = customScopesForSelection('custom', 'operator', [
      { resource: 'site', id: '*', permissions: ['read', 'write'] },
    ]);
    expect(seeded).toEqual(SCOPE_PRESETS.operator);
    expect(grants(seeded!)).toBe(16);
  });

  /**
   * NEGATIVE CONTROL — the behaviour that shipped. The builder opened on a
   * hardcoded literal regardless of preset, dropping 3 of 4 resources and 14
   * of 16 grants, and every validator plus POST /api/keys accepted it.
   */
  it('the old behaviour opened on one unrelated row, losing 14 of 16 grants', () => {
    const OLD_SEED: ApiKeyScope[] = [
      { resource: 'site', id: '*', permissions: ['read', 'write'] },
    ];
    expect(grants(resolveScopes('operator', OLD_SEED))).toBe(16);
    expect(grants(resolveScopes('custom', OLD_SEED))).toBe(2);
    expect(resolveScopes('custom', OLD_SEED)).toHaveLength(1);
  });

  it('leaves the builder alone when the user is already in custom', () => {
    const edited: ApiKeyScope[] = [
      { resource: 'installer', id: '*', permissions: ['write'] },
    ];
    // Re-seeding here would discard work in progress on every re-render.
    expect(customScopesForSelection('custom', 'custom', edited)).toBeNull();
  });

  it('does nothing when moving between named presets', () => {
    expect(customScopesForSelection('admin', 'operator', [])).toBeNull();
  });

  it('copies the preset rather than handing over the shared singleton', () => {
    const seeded = customScopesForSelection('custom', 'publisher', [])!;
    seeded[0].permissions.push('admin');
    // wildcardScopes gives all four rows ONE permissions array, so a shallow
    // hand-off corrupts the constant for the whole tab.
    expect(SCOPE_PRESETS.publisher[0].permissions).toEqual(['read', 'write']);
  });

  it('seeds the editor from the preset just picked, not the key it opened on', () => {
    // The editor's version of the bug: publisher key -> operator -> custom
    // showed the original publisher rows, reverting the choice just made.
    const keyScopes = SCOPE_PRESETS.publisher;
    expect(customScopesForSelection('custom', 'operator', keyScopes)).toEqual(
      SCOPE_PRESETS.operator,
    );
  });
});

describe('ApiKeyScopeFields resource picker', () => {
  function renderFields(customScopes: ApiKeyScope[]) {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(ApiKeyScopeFields, {
          preset: 'custom',
          onPresetChange: jest.fn(),
          customScopes,
          onCustomScopesChange: jest.fn(),
        }),
      ),
    );
  }

  async function offeredResources(row: number): Promise<string[]> {
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: `scope ${row} resource` }));
    return (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
  }

  const siteRow: ApiKeyScope = { resource: 'site', id: '*', permissions: ['read'] };

  it('offers a superadmin every superadmin-only resource', async () => {
    mockIsSuperadmin = true;
    renderFields([siteRow]);

    const offered = await offeredResources(1);
    expect(offered).toEqual(expect.arrayContaining(['site', 'user', 'installer']));
    for (const r of SUPERADMIN_ONLY_RESOURCES) expect(offered).toContain(r);
  });

  it('hides superadmin-only resources from everyone else', async () => {
    mockIsSuperadmin = false;
    renderFields([siteRow]);

    const offered = await offeredResources(1);
    expect(offered).toContain('site');
    for (const r of SUPERADMIN_ONLY_RESOURCES) expect(offered).not.toContain(r);
  });

  it.each(SUPERADMIN_ONLY_RESOURCES)(
    'still shows an existing %s row to a non-superadmin, read-only',
    (resource) => {
      mockIsSuperadmin = false;
      renderFields([siteRow, { resource, id: '*', permissions: ['read', 'write'] }]);

      const trigger = screen.getByRole('combobox', { name: 'scope 2 resource' });
      expect(trigger).toHaveTextContent(resource);
      expect(trigger).toBeDisabled();
      expect(screen.getByRole('textbox', { name: 'scope 2 id' })).toBeDisabled();
      const perms = within(screen.getByRole('group', { name: 'scope 2 permissions' }));
      expect(perms.getByRole('checkbox', { name: 'read' })).toBeChecked();
      expect(perms.getByRole('checkbox', { name: 'write' })).toBeChecked();
      for (const box of perms.getAllByRole('checkbox')) expect(box).toBeDisabled();
      expect(screen.getByRole('button', { name: 'remove scope 2' })).toBeDisabled();
      expect(screen.getByText('only a superadmin can change this scope')).toBeInTheDocument();

      // the row beside it stays editable
      expect(screen.getByRole('combobox', { name: 'scope 1 resource' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'remove scope 1' })).toBeEnabled();
    },
  );

  it('lets a superadmin edit a superadmin-only row like any other', () => {
    mockIsSuperadmin = true;
    renderFields([siteRow, { resource: SUPERADMIN_ONLY_RESOURCES[0], id: '*', permissions: ['read'] }]);

    expect(screen.getByRole('combobox', { name: 'scope 2 resource' })).toBeEnabled();
    expect(screen.queryByText('only a superadmin can change this scope')).not.toBeInTheDocument();
  });
});

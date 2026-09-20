import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    // biome-ignore lint/a11y/useAltText: test mock; alt comes from spread props
    return <img {...props} />;
  },
}));

vi.mock('@/services/environment', () => ({
  getInitializedAppService: () => null,
  isTauriAppPlatform: () => false,
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    envConfig: { getAppService: async () => ({ saveSettings: vi.fn(async () => {}) }) },
    appService: null,
  }),
}));

import RandomPickDialog from '@/app/library/components/randompick/RandomPickDialog';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { useLibraryStore } from '@/store/libraryStore';
import { useRandomPickStore } from '@/store/randomPickStore';
import { useSettingsStore } from '@/store/settingsStore';
import { Book } from '@/types/book';
import { SystemSettings } from '@/types/settings';

const makeBook = (overrides: Partial<Book> & { hash: string }): Book =>
  ({
    title: `Book ${overrides.hash}`,
    author: 'Author',
    format: 'EPUB',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }) as Book;

const dune = makeBook({ hash: 'dune', title: 'Dune' });

const setLibrary = (books: Book[]) =>
  useLibraryStore.setState({
    visibleLibrary: books,
    library: books,
    coverThumbnails: new Map(),
    groups: {},
  });

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useSettingsStore.setState({ settings: { ...DEFAULT_SYSTEM_SETTINGS } as SystemSettings });
  useRandomPickStore.setState({
    pickedHashes: new Set<string>(),
    isSpinning: false,
    pickCount: 0,
  });
  setLibrary([dune]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RandomPickDialog', () => {
  it('disables the spin button when the candidate pool is empty', () => {
    setLibrary([]);
    render(<RandomPickDialog onClose={vi.fn()} onOpenBook={vi.fn()} />);
    expect((screen.getByText('Start Random Pick') as HTMLButtonElement).disabled).toBe(true);
  });

  it('skips the animation and reveals the result for a single candidate', async () => {
    render(<RandomPickDialog onClose={vi.fn()} onOpenBook={vi.fn()} />);
    fireEvent.click(screen.getByText('Start Random Pick'));
    await waitFor(() => expect(screen.getByText('Pick Result')).toBeTruthy());
    expect(screen.getAllByText('Dune').length).toBeGreaterThan(0);
  });

  it('marks the drawn book as picked and shows the session counter', async () => {
    render(<RandomPickDialog onClose={vi.fn()} onOpenBook={vi.fn()} />);
    fireEvent.click(screen.getByText('Start Random Pick'));
    await waitFor(() => expect(useRandomPickStore.getState().pickCount).toBe(1));
    expect(useRandomPickStore.getState().pickedHashes.has('dune')).toBe(true);
  });

  it('reports exhaustion once every candidate has been drawn', async () => {
    render(<RandomPickDialog onClose={vi.fn()} onOpenBook={vi.fn()} />);
    fireEvent.click(screen.getByText('Start Random Pick'));
    await waitFor(() => expect(screen.getByText('Spin Again')).toBeTruthy());
    fireEvent.click(screen.getByText('Spin Again'));
    await waitFor(() =>
      expect(screen.getByText('All candidate books have been picked')).toBeTruthy(),
    );
  });

  it('hands the drawn book to onOpenBook when starting reading', async () => {
    const onOpenBook = vi.fn();
    render(<RandomPickDialog onClose={vi.fn()} onOpenBook={onOpenBook} />);
    fireEvent.click(screen.getByText('Start Random Pick'));
    await waitFor(() => expect(screen.getByText('Start Reading')).toBeTruthy());
    fireEvent.click(screen.getByText('Start Reading'));
    expect(onOpenBook).toHaveBeenCalledWith(expect.objectContaining({ hash: 'dune' }));
  });

  it('clears the picked list on reset and allows spinning again', async () => {
    render(<RandomPickDialog onClose={vi.fn()} onOpenBook={vi.fn()} />);
    fireEvent.click(screen.getByText('Start Random Pick'));
    await waitFor(() => expect(screen.getByText('Reset Picked')).toBeTruthy());
    fireEvent.click(screen.getByText('Reset Picked'));
    expect(useRandomPickStore.getState().pickCount).toBe(0);
    expect(useRandomPickStore.getState().pickedHashes.size).toBe(0);
  });

  it('narrows the candidate pool when a group is added to the include list', async () => {
    setLibrary([dune, makeBook({ hash: 'cosmos', title: 'Cosmos', groupName: '科学' })]);
    useLibraryStore.setState({ groups: { 'id-science': '科学' } });
    render(<RandomPickDialog onClose={vi.fn()} onOpenBook={vi.fn()} />);
    expect(screen.getByText(/Candidate Pool: 2 of 2/)).toBeTruthy();

    fireEvent.click(screen.getAllByText('Add Group')[0]!);
    fireEvent.click(screen.getByText('科学'));
    await waitFor(() => expect(screen.getByText(/Candidate Pool: 1 of 2/)).toBeTruthy());
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import { useRandomPickStore } from '@/store/randomPickStore';

const resetStore = () =>
  useRandomPickStore.setState({
    pickedHashes: new Set<string>(),
    isSpinning: false,
    pickCount: 0,
  });

describe('randomPickStore', () => {
  beforeEach(resetStore);

  it('accumulates picked hashes and keeps pickCount in sync', () => {
    useRandomPickStore.getState().markPicked('a');
    useRandomPickStore.getState().markPicked('b');
    const state = useRandomPickStore.getState();
    expect([...state.pickedHashes].sort()).toEqual(['a', 'b']);
    expect(state.pickCount).toBe(2);
  });

  it('ignores a repeated hash and keeps the Set reference stable', () => {
    useRandomPickStore.getState().markPicked('a');
    const before = useRandomPickStore.getState().pickedHashes;
    useRandomPickStore.getState().markPicked('a');
    const state = useRandomPickStore.getState();
    expect(state.pickCount).toBe(1);
    expect(state.pickedHashes).toBe(before);
  });

  it('replaces the Set instance on a new hash so subscribers re-render', () => {
    const before = useRandomPickStore.getState().pickedHashes;
    useRandomPickStore.getState().markPicked('a');
    expect(useRandomPickStore.getState().pickedHashes).not.toBe(before);
  });

  it('tracks the spinning flag', () => {
    useRandomPickStore.getState().setSpinning(true);
    expect(useRandomPickStore.getState().isSpinning).toBe(true);
    useRandomPickStore.getState().setSpinning(false);
    expect(useRandomPickStore.getState().isSpinning).toBe(false);
  });

  it('clears picked hashes and the counter on reset', () => {
    const store = useRandomPickStore.getState();
    store.markPicked('a');
    store.resetPicked();
    const state = useRandomPickStore.getState();
    expect(state.pickedHashes.size).toBe(0);
    expect(state.pickCount).toBe(0);
  });
});

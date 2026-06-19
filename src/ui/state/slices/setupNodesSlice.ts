import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type SetupNodeSection = 'bootstrap' | 'relay';

export interface SetupNodeStatus {
  address: string;
  connected: boolean | null;
}

interface SectionState {
  nodes: SetupNodeStatus[];
  loadedOnce: boolean;
  generation: number;
}

interface SetupNodesState {
  bootstrap: SectionState;
  relay: SectionState;
}

const emptySection = (): SectionState => ({ nodes: [], loadedOnce: false, generation: 0 });

const initialState: SetupNodesState = {
  bootstrap: emptySection(),
  relay: emptySection(),
};

const setupNodesSlice = createSlice({
  name: 'setupNodes',
  initialState,
  reducers: {
    mergeConfiguredNodes: (
      state,
      action: PayloadAction<{
        section: SetupNodeSection;
        configured: SetupNodeStatus[];
        requestGeneration: number;
      }>,
    ) => {
      const { section, configured, requestGeneration } = action.payload;
      if (requestGeneration < state[section].generation) {
        return;
      }
      const previous = state[section].nodes;
      state[section].nodes = configured.map((node) => {
        const existing = previous.find((entry) => entry.address === node.address);
        return {
          address: node.address,
          connected: existing ? existing.connected : node.connected,
        };
      });
      state[section].loadedOnce = true;
    },
    applyLiveness: (
      state,
      action: PayloadAction<{
        section: SetupNodeSection;
        statuses: { address: string; connected: boolean }[];
      }>,
    ) => {
      const { section, statuses } = action.payload;
      const byAddress = new Map(statuses.map((status) => [status.address, status.connected]));
      for (const node of state[section].nodes) {
        if (byAddress.has(node.address)) {
          node.connected = byAddress.get(node.address)!;
        }
      }
    },
    setSetupNodes: (
      state,
      action: PayloadAction<{ section: SetupNodeSection; nodes: SetupNodeStatus[] }>,
    ) => {
      state[action.payload.section].nodes = action.payload.nodes;
      state[action.payload.section].generation += 1;
    },
    bumpSetupGeneration: (state, action: PayloadAction<{ section: SetupNodeSection }>) => {
      state[action.payload.section].generation += 1;
    },
  },
});

export const {
  mergeConfiguredNodes,
  applyLiveness,
  setSetupNodes,
  bumpSetupGeneration,
} = setupNodesSlice.actions;

export default setupNodesSlice.reducer;

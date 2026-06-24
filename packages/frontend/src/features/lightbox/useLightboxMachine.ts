import { useReducer } from 'react';
import type { DocumentItem, LightboxPhase } from '../../types/document';

export interface LightboxModel {
  phase: LightboxPhase;
  item: DocumentItem | null;
  sourceRect: DOMRect | null;
  sourceRadius: number;
}

type Event =
  | { type: 'OPEN'; item: DocumentItem; sourceRect: DOMRect; sourceRadius: number }
  | { type: 'OPENED' }
  | { type: 'CLOSE' }
  | { type: 'CLOSED' }
  | { type: 'SWITCH'; item: DocumentItem };

const initialState: LightboxModel = { phase: 'closed', item: null, sourceRect: null, sourceRadius: 0 };

function reducer(state: LightboxModel, event: Event): LightboxModel {
  switch (event.type) {
    case 'OPEN':
      if (state.phase !== 'closed') return state;
      return { phase: 'opening', item: event.item, sourceRect: event.sourceRect, sourceRadius: event.sourceRadius };
    case 'OPENED':
      return { ...state, phase: state.item ? 'open' : 'closed' };
    case 'CLOSE':
      return { ...state, phase: state.item ? 'closing' : 'closed' };
    case 'CLOSED':
      return initialState;
    case 'SWITCH':
      return { ...state, item: event.item };
    default:
      return state;
  }
}

export function useLightboxMachine() {
  return useReducer(reducer, initialState);
}

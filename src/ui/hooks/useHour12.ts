import { useSelector } from 'react-redux';
import type { RootState } from '../state/store';

export const useHour12 = (): boolean =>
  useSelector((state: RootState) => state.uiPrefs.timeFormat === '12h');

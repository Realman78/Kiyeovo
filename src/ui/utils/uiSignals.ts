import type { SetupSection } from '../components/sidebar/navigation';

export const OPEN_REGISTER_DIALOG_EVENT = 'kiyeovo:open-register-dialog';
export const OPEN_SIDEBAR_ACTION_EVENT = 'kiyeovo:open-sidebar-action';
export const OPEN_SETUP_EVENT = 'kiyeovo:open-setup';

export type SidebarAction = 'new-conversation' | 'new-group' | 'import-trusted-user';

export function requestOpenRegisterDialog(): void {
  window.dispatchEvent(new Event(OPEN_REGISTER_DIALOG_EVENT));
}

export function requestSidebarAction(action: SidebarAction): void {
  window.dispatchEvent(new CustomEvent<SidebarAction>(OPEN_SIDEBAR_ACTION_EVENT, { detail: action }));
}

export function requestOpenSetup(section: SetupSection = 'bootstrap'): void {
  window.dispatchEvent(new CustomEvent<SetupSection>(OPEN_SETUP_EVENT, { detail: section }));
}

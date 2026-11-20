export const WORKSPACES = {
  cnc: { label: 'CNC', tabs: ['console', 'resume', 'probe'], defaultTab: 'console' },
  laser: { label: 'Laser', tabs: ['laser', 'console', 'zones'], defaultTab: 'laser' },
  configuration: { label: 'Configuration', tabs: ['settings', 'zones', 'macros', 'console'], defaultTab: 'settings' },
};

export function workspaceForTab(tab, preferred = 'cnc') {
  if (Object.hasOwn(WORKSPACES, preferred) && WORKSPACES[preferred].tabs.includes(tab)) return preferred;
  return Object.keys(WORKSPACES).find((name) => WORKSPACES[name].tabs.includes(tab)) || 'cnc';
}

export function workspaceTab(workspace, rememberedTab) {
  const definition = Object.hasOwn(WORKSPACES, workspace) ? WORKSPACES[workspace] : WORKSPACES.cnc;
  return definition.tabs.includes(rememberedTab) ? rememberedTab : definition.defaultTab;
}

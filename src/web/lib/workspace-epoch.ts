let epoch: string | undefined;

export function rememberWorkspaceEpoch(response: Response): void {
  const current = response.headers.get('X-Whim-Workspace-Epoch');
  // Reconnect health checks must not retarget drafts already loaded in this page.
  if (current && epoch === undefined) epoch = current;
}

export function workspaceRequestScope(): { workspaceEpoch?: string } {
  return { workspaceEpoch: epoch };
}

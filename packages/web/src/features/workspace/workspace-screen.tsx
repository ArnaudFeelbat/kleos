/**
 * Workspace window for one session: title bar tinted by connection color, schema
 * sidebar, and the Schema / Data / Query / Monitor tabs. Provides WorkspaceContext.
 * PLACEHOLDER: implemented in the workspace milestone.
 */
export function WorkspaceScreen({ sid }: { sid: string }) {
  return <div className="p-6">Workspace {sid}</div>;
}

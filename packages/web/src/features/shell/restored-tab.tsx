import type { SavedConnection } from '@kleos/shared';
import { LoaderCircle, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConnectActions } from '@/features/connections/connect-context';
import type { ConnectionTab } from './tabs-store';

/**
 * A server tab put back from the last window that has no session yet: a quiet spinner while
 * it reconnects by itself, then — if it needs the user or failed — its name, the reason and a
 * Connect button that runs the usual flow (prompts included) and turns the tab into a workspace.
 */
export function RestoredTab({
  tab,
  favorite,
  onClose,
}: {
  tab: ConnectionTab;
  favorite: SavedConnection | undefined;
  onClose(): void;
}) {
  const { connect, connectingId } = useConnectActions();
  const restore = tab.restore;
  if (!restore || restore.state === 'connecting') {
    return (
      <div className="bg-background flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
        <LoaderCircle className="text-muted-foreground size-5 animate-spin" aria-hidden="true" />
        <p className="text-muted-foreground" role="status">
          Reconnecting to {tab.nickname}…
        </p>
      </div>
    );
  }
  const connecting = connectingId === tab.connectionId;
  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
      <section
        aria-label={`Reconnect ${tab.nickname}`}
        className="flex max-w-md flex-col items-center gap-3 text-center"
      >
        <span className="surface-raised flex size-11 items-center justify-center rounded-xl">
          <Unplug className="text-muted-foreground size-5" aria-hidden="true" />
        </span>
        <h1 className="text-[15px] font-semibold">{tab.nickname}</h1>
        <p className="text-muted-foreground break-words">{restore.reason}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close tab
          </Button>
          <Button size="sm" disabled={!favorite || connecting} onClick={() => favorite && void connect(favorite)}>
            {connecting && <LoaderCircle className="animate-spin" aria-hidden="true" />}
            {connecting ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      </section>
    </div>
  );
}

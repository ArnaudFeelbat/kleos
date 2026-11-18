import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConnectionsScreen } from '@/features/connections/connections-screen';
import { WorkspaceScreen } from '@/features/workspace/workspace-screen';
import { useRoute } from '@/lib/route';

export function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false },
          mutations: { retry: false },
        },
      }),
  );
  const route = useRoute();
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={400}>
        {route.name === 'workspace' ? <WorkspaceScreen key={route.sid} sid={route.sid} /> : <ConnectionsScreen />}
        <Toaster position="bottom-right" closeButton />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

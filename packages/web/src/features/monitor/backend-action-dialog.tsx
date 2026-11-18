import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useWorkspace } from '@/features/workspace/context';
import { api, errorText, queryKeys } from '@/lib/api';
import { backendActionCopy, type BackendTarget } from './monitor-format';

export type BackendActionRequest = {
  mode: 'cancel' | 'terminate';
  target: BackendTarget;
  /** Backends waiting on this one's locks, named in the confirmation. */
  waiterPids: number[];
};

/** Confirms, then runs pg_cancel_backend / pg_terminate_backend and reports with a toast. */
export function BackendActionDialog({ request, onClose }: { request: BackendActionRequest | null; onClose(): void }) {
  const { sid } = useWorkspace();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (r: BackendActionRequest) => api.backendAction(sid, r.target.pid, r.mode),
    onSuccess: (result, r) => {
      const done = r.mode === 'terminate' ? 'terminated' : 'cancelled';
      if (result.ok) toast.success(`Backend ${r.target.pid} ${done}`);
      else toast.warning(`Backend ${r.target.pid} was not signalled`, { description: 'It may have ended already.' });
    },
    onError: (err, r) => toast.error(`Could not ${r.mode} backend ${r.target.pid}`, { description: errorText(err) }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.stats(sid, 'sessions') });
      void queryClient.invalidateQueries({ queryKey: queryKeys.stats(sid, 'locks') });
    },
  });

  const copy = request ? backendActionCopy(request.mode, request.target, request.waiterPids) : null;
  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      {request && copy && (
        <AlertDialogContent size="sm" className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[15px]">{copy.title}</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">{copy.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm">Keep it</AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant={request.mode === 'terminate' ? 'destructive' : 'default'}
              onClick={() => {
                mutation.mutate(request);
                onClose();
              }}
            >
              {copy.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}

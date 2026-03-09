import { memo, useCallback } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { IconButton } from '~/components/ui/IconButton';
import { coolifyContainers } from '~/lib/stores/coolifyPreview';

interface CoolifyShareButtonProps {
  chatId?: string;
}

export const CoolifyShareButton = memo(({ chatId }: CoolifyShareButtonProps) => {
  const containers = useStore(coolifyContainers);

  const container = chatId ? containers[chatId] : null;

  const handleShare = useCallback(() => {
    if (!container?.domain) {
      return;
    }

    const url = container.domain.startsWith('http') ? container.domain : `https://${container.domain}`;

    navigator.clipboard.writeText(url).then(() => {
      toast.success('Shareable URL copied to clipboard');
    });
  }, [container]);

  if (!container || container.status !== 'running') {
    return null;
  }

  return (
    <IconButton
      icon="i-ph:share-network"
      onClick={handleShare}
      title={`Share Coolify preview: ${container.domain}`}
    />
  );
});

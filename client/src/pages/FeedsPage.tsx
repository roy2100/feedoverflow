import FeedSidebar from '../components/FeedSidebar';
import { useStore } from '../store';
import type { MobilePage, View } from '../types';

interface FeedsPageProps {
  onOpenAddModal: () => void;
  onNavigate: (page: MobilePage) => void;
}

export default function FeedsPage({ onOpenAddModal, onNavigate }: FeedsPageProps) {
  const { feeds, selectedView, selectView, loadArticles } = useStore();

  const handleSelectView = (view: View) => {
    selectView(view);
    onNavigate('list');
  };

  return (
    <FeedSidebar
      isMobile
      feeds={feeds}
      selectedView={selectedView}
      onSelectView={handleSelectView}
      onRefresh={() => loadArticles(selectedView)}
      onOpenAddModal={onOpenAddModal}
      onOpenManageModal={null}
      onOpenSettings={null}
    />
  );
}

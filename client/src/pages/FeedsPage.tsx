import FeedSidebar from '../components/FeedSidebar';
import { useStore } from '../store';
import type { MobilePage, View } from '../types';

interface FeedsPageProps {
  onOpenAddModal: () => void;
  onNavigate: (page: MobilePage) => void;
}

export default function FeedsPage({ onOpenAddModal, onNavigate }: FeedsPageProps) {
  const { feeds, selectedView, selectView, search, loadArticles } = useStore();

  const handleSelectView = (view: View) => {
    selectView(view);
    onNavigate('list');
  };

  const handleSearch = (query: string) => {
    if (query.trim().length < 2) return;
    search(query);
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
      onSearch={handleSearch}
    />
  );
}

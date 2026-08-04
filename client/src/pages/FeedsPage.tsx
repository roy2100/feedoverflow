import FeedSidebar from '../components/FeedSidebar';
import { useStore } from '../store';
import type { MobilePage, View } from '../types';

interface FeedsPageProps {
  onOpenAddModal: () => void;
  onOpenManageModal: () => void;
  onOpenCollectionsModal: () => void;
  onNavigate: (page: MobilePage) => void;
}

export default function FeedsPage({
  onOpenAddModal,
  onOpenManageModal,
  onOpenCollectionsModal,
  onNavigate,
}: FeedsPageProps) {
  const { feeds, collections, selectedView, selectView, search, loadArticles } = useStore();

  const handleSelectView = (view: View) => {
    selectView(view);
    onNavigate('list');
  };

  const handleSearch = (query: string) => {
    search(query);
    onNavigate('list');
  };

  return (
    <FeedSidebar
      isMobile
      feeds={feeds}
      collections={collections}
      selectedView={selectedView}
      onSelectView={handleSelectView}
      onRefresh={() => loadArticles(selectedView)}
      onOpenAddModal={onOpenAddModal}
      onOpenManageModal={onOpenManageModal}
      onOpenCollectionsModal={onOpenCollectionsModal}
      onOpenSettings={null}
      onSearch={handleSearch}
    />
  );
}

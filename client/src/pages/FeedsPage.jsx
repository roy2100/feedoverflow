import FeedSidebar from '../components/FeedSidebar';
import { useStore } from '../store';

export default function FeedsPage({ onOpenAddModal, onNavigate }) {
  const { feeds, selectedView, starredCount, selectView, loadArticles } = useStore();

  const handleSelectView = (view) => {
    selectView(view);
    onNavigate('list');
  };

  return (
    <FeedSidebar
      isMobile
      feeds={feeds}
      selectedView={selectedView}
      onSelectView={handleSelectView}
      starredCount={starredCount}
      onRefresh={() => loadArticles(selectedView)}
      onOpenAddModal={onOpenAddModal}
      onOpenManageModal={null}
      onOpenSettings={null}
    />
  );
}

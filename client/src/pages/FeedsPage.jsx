import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import FeedSidebar from '../components/FeedSidebar';

export default function FeedsPage({ onOpenAddModal }) {
  const navigate = useNavigate();
  const { feeds, selectedView, articles, starredCount, selectView, loadArticles } = useStore();
  const unreadCount = articles.filter(a => !a.isRead).length;

  const handleSelectView = (view) => {
    selectView(view);
    navigate('/list');
  };

  return (
    <FeedSidebar
      isMobile
      feeds={feeds}
      selectedView={selectedView}
      onSelectView={handleSelectView}
      unreadCount={unreadCount}
      starredCount={starredCount}
      onRefresh={() => loadArticles(selectedView)}
      onOpenAddModal={onOpenAddModal}
      onOpenManageModal={null}
      onOpenSettings={null}
    />
  );
}

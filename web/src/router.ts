import { createRouter, createWebHashHistory } from 'vue-router';
import ShelfPage from './pages/ShelfPage.vue';
import BookDetailPage from './pages/BookDetailPage.vue';
import WritingPage from './pages/WritingPage.vue';
import FactsPage from './pages/FactsPage.vue';
import PackingPage from './pages/PackingPage.vue';
import OutlinePage from './pages/OutlinePage.vue';
import ReferencesPage from './pages/ReferencesPage.vue';
import ReferenceDetailPage from './pages/ReferenceDetailPage.vue';
import MaterialsPage from './pages/MaterialsPage.vue';
import DetectorsPage from './pages/DetectorsPage.vue';
import SettingsPage from './pages/SettingsPage.vue';

// hash 路由：生产模式由后端直接静态托管，无需 SPA fallback
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/books' },
    { path: '/books', component: ShelfPage },
    { path: '/books/:id', component: BookDetailPage },
    { path: '/books/:id/writing', component: WritingPage },
    { path: '/books/:id/outline', component: OutlinePage },
    { path: '/books/:id/facts', component: FactsPage },
    { path: '/books/:id/packing', component: PackingPage },
    { path: '/references', component: ReferencesPage },
    { path: '/references/:id', component: ReferenceDetailPage },
    { path: '/materials', component: MaterialsPage },
    { path: '/detectors', component: DetectorsPage },
    { path: '/settings', component: SettingsPage },
    { path: '/:pathMatch(.*)*', redirect: '/books' },
  ],
});

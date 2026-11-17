import { createRouter, createWebHashHistory } from 'vue-router';
import SettingsPage from './pages/SettingsPage.vue';
import MaterialsPage from './pages/MaterialsPage.vue';

// hash 路由：生产模式由后端直接静态托管，无需 SPA fallback
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/materials' },
    { path: '/materials', component: MaterialsPage },
    { path: '/settings', component: SettingsPage },
    { path: '/:pathMatch(.*)*', redirect: '/materials' },
  ],
});

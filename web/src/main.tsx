import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import './styles/tokens.css';
import './styles/greptile.css';
import './styles/app.css';
import { ToastProvider } from './components/ui.tsx';
import { Layout } from './routes/Layout.tsx';
import { Runs } from './routes/Runs.tsx';
import { Dashboard } from './routes/Dashboard.tsx';
import { Run } from './routes/Run.tsx';
import { Bug } from './routes/Bug.tsx';
import { Job, Jobs } from './routes/Job.tsx';
import { Improvements } from './routes/Improvements.tsx';
import { Compare } from './routes/Compare.tsx';
import { Settings } from './routes/Settings.tsx';
import { Schedules } from './routes/Schedules.tsx';
import { Prs } from './routes/Prs.tsx';

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'runs', element: <Runs /> },
      { path: 'runs/:ws/:run', element: <Run /> },
      { path: 'runs/:ws/:run/bugs/:id', element: <Bug /> },
      { path: 'jobs', element: <Jobs /> },
      { path: 'jobs/:id', element: <Job /> },
      { path: 'improvements', element: <Improvements /> },
      { path: 'compare', element: <Compare /> },
      { path: 'settings', element: <Settings /> },
      { path: 'schedules', element: <Schedules /> },
      { path: 'prs', element: <Prs /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </StrictMode>,
);

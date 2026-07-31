import { createBrowserRouter } from 'react-router';
import { ProtectedRoute } from '@/app/ProtectedRoute';
import { LoginPage } from '@/features/auth/LoginPage';
import { TodayPage } from '@/features/today/TodayPage';
import { FaultReportPage } from '@/features/fault-report/FaultReportPage';
import { FuelEntryPage } from '@/features/fuel/FuelEntryPage';
import { GloveboxPage } from '@/features/glovebox/GloveboxPage';
import { ChecklistPage } from '@/features/checklist/ChecklistPage';
import { FormsPage } from '@/features/forms/FormsPage';
import { MessagesPage } from '@/features/messages/MessagesPage';
import { StopPage } from '@/features/delivery/StopPage';
import { NotificationsPage } from '@/features/notifications/NotificationsPage';
import { HelpPage } from '@/features/help/HelpPage';
import { NotFoundPage } from '@/features/shared/NotFoundPage';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      { path: '/', element: <TodayPage /> },
      { path: '/fault-report', element: <FaultReportPage /> },
      { path: '/fuel', element: <FuelEntryPage /> },
      { path: '/glovebox', element: <GloveboxPage /> },
      { path: '/checklist', element: <ChecklistPage /> },
      { path: '/forms', element: <FormsPage /> },
      { path: '/messages', element: <MessagesPage /> },
      { path: '/stop', element: <StopPage /> },
      { path: '/notifications', element: <NotificationsPage /> },
      { path: '/help', element: <HelpPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

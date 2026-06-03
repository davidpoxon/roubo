import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import ToastProvider from "./components/ToastProvider";
import TeardownTrackerProvider from "./components/ClearingTrackerProvider";
import ErrorBoundary from "./components/ErrorBoundary";
import "./globals.css";

if (import.meta.env.DEV) document.title = "[DEV] Roubo";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 2000,
    },
  },
});

const router = createBrowserRouter([{ path: "*", element: <App /> }]);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <TeardownTrackerProvider>
            <RouterProvider router={router} />
          </TeardownTrackerProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);

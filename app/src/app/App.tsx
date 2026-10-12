import { Component, lazy, useEffect, type ErrorInfo, type ReactNode } from "react";
import { createHashRouter, RouterProvider, useLocation } from "react-router";

import { LaunchFlowKeeper } from "../components/launchTracker";
import { CreatePage } from "../pages/create/CreatePage";
import { HomePage } from "../pages/Home";
import { NotFoundPage, SecurityPage } from "../pages/SecurityPage";
import { ShieldPage } from "../pages/ShieldPage";
import { VerifyPage } from "../pages/verify/VerifyPage";
import { TokenPage } from "../pages/token/TokenPage";
import { VaultPage } from "../pages/vault/VaultPage";
import { Layout } from "./Layout";
import { NetworkProvider } from "./network";
import { SettingsProvider } from "./settings";
import { pageTitle } from "./titles";
import { TxProvider } from "./tx";
import { WalletProviders } from "./wallet";

// The developer docs and the whitepaper are large and static: loaded on first visit (Layout shows a spinner).
const DocsPage = lazy(() => import("../pages/docs/DocsPage").then((m) => ({ default: m.DocsPage })));
// A token's Autopilot (the graph canvas, the simulator) loads on first visit too.
const AutopilotPage = lazy(() => import("../pages/autopilot/AutopilotPage").then((m) => ({ default: m.AutopilotPage })));
const AutopilotIndex = lazy(() => import("../pages/autopilot/AutopilotIndex").then((m) => ({ default: m.AutopilotIndex })));
const WhitepaperPage = lazy(() => import("../pages/whitepaper/WhitepaperPage").then((m) => ({ default: m.WhitepaperPage })));

/** Hash routing: works from any IPFS gateway path without server rewrites. */
const router = createHashRouter([
  {
    path: "/",
    element: <Shell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "create", element: <CreatePage /> },
      { path: "token/:address", element: <TokenPage /> },
      // PROGRAMMABLE_V1 §6: a token's Autopilot, and every token's at a glance.
      { path: "token/:address/autopilot", element: <AutopilotPage /> },
      { path: "autopilot", element: <AutopilotIndex /> },
      { path: "vault", element: <VaultPage /> },
      { path: "shield", element: <ShieldPage /> },
      { path: "verify", element: <VerifyPage /> },
      { path: "verify/:address", element: <VerifyPage /> },
      { path: "security", element: <SecurityPage /> },
      { path: "docs", element: <DocsPage /> },
      { path: "docs/*", element: <DocsPage /> },
      { path: "whitepaper", element: <WhitepaperPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

function Shell(): ReactNode {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    // Docs and token pages name themselves (their effects run before this one, so this one must not overwrite them).
    const title = pageTitle(pathname);
    if (title !== null) document.title = title;
  }, [pathname]);
  return <Layout />;
}

function RouteError(): ReactNode {
  return (
    <div className="mx-auto max-w-xl p-8">
      <h1 className="text-xl font-bold">Something went wrong</h1>
      <p className="mt-2 text-muted">This page failed to render. Nothing was signed or sent.</p>
      <a className="link mt-4 inline-block" href="#/">
        Back to launches
      </a>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Shown on the page; never sent anywhere.
    console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-xl p-8">
          <h1 className="text-xl font-bold">Something went wrong</h1>
          <p className="mt-2 break-words text-muted">{this.state.error.message}</p>
          <p className="mt-2 text-sm text-muted">Nothing was signed or sent. Reload the page to continue.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App(): ReactNode {
  return (
    <ErrorBoundary>
      <SettingsProvider>
        <WalletProviders>
          <NetworkProvider>
            <TxProvider>
              {/* The launches this browser runs keep going on every page, and resume after a reload. */}
              <LaunchFlowKeeper />
              <RouterProvider router={router} />
            </TxProvider>
          </NetworkProvider>
        </WalletProviders>
      </SettingsProvider>
    </ErrorBoundary>
  );
}

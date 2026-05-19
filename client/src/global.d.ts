interface Window {
  roubo?: {
    onDeepLink: (callback: (url: string) => void) => () => void;
    onNavigate: (callback: (path: string) => void) => () => void;
    getAppVersion: () => Promise<string>;
    platform: string;
    setTitleBarOverlayTheme: (theme: "light" | "dark") => void;
    setBadgeCount: (count: number) => void;
    showNotification: (req: { title: string; body: string; routeTo?: string }) => void;
  };
}

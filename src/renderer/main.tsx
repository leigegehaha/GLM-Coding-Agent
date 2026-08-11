import './index.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';

import { ensureWebConsoleBridge } from './services/webBridge';
import { store } from './store';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}

/** 在加载 App 模块前准备运行时 Bridge，避免浏览器执行顶层 Electron 调用。 */
const bootstrap = async (): Promise<void> => {
  try {
    await ensureWebConsoleBridge();
    const { default: App } = await import('./App');
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <Provider store={store}>
          <App />
        </Provider>
      </React.StrictMode>
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to render the app:', error);
    ReactDOM.createRoot(rootElement).render(
      <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
        <section className="w-full max-w-md border border-border bg-card p-6 shadow-sm">
          <h1 className="text-lg font-semibold">智码 GLM Code Web</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{message}</p>
        </section>
      </main>
    );
  }
};

void bootstrap();

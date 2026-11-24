import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
import { initSharedPluginRuntime, KERNEL_PUBLIC_SDK } from './kernel/client';

// Publish immutable React 19 / Zustand / Lucide / @agy-desk/kernel singletons BEFORE any plugin loads
initSharedPluginRuntime(KERNEL_PUBLIC_SDK);

class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-6 font-mono text-xs space-y-2" style={{ color: 'var(--danger)' }}>
          <div className="font-bold text-sm">agy-desk 커널 렌더러 오류</div>
          <pre className="whitespace-pre-wrap">{this.state.error.stack || this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
);

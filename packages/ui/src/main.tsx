import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CoreClient, resolveConnection } from './api';
import { AppProvider } from './state';
import { App } from './App';
import { applyTheme, storedTheme } from './theme';

applyTheme(storedTheme());

const root = createRoot(document.getElementById('root')!);

resolveConnection().then(
  (conn) => {
    if (!conn) {
      root.render(
        <div className="empty" style={{ height: '100%', justifyContent: 'center' }}>
          <div className="panel-title">No core to connect to</div>
          <div>
            Start the core with <span className="mono">siq proxy</span> and open this page with <span className="mono">?api=ws://127.0.0.1:PORT&amp;token=TOKEN</span>, or run the desktop app.
          </div>
        </div>,
      );
      return;
    }
    const client = new CoreClient(conn);
    root.render(
      <StrictMode>
        <AppProvider client={client}>
          <App />
        </AppProvider>
      </StrictMode>,
    );
  },
  (err: unknown) => root.render(<div className="empty error-text">Could not reach the core: {String(err)}</div>),
);

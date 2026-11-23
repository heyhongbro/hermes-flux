package com.hermesflux.app;

import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import java.io.IOException;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "HermesMainActivity";
    private GatewayWsProxyServer wsProxyServer;
    private int wsProxyPort;

    @Override
    protected void load() {
        try {
            wsProxyServer = new GatewayWsProxyServer();
            wsProxyPort = wsProxyServer.start();
        } catch (IOException err) {
            Log.e(TAG, "Failed to start local WebSocket Origin proxy", err);
        }

        // Inject HermesWsProxy/<port> into WebView UA before Capacitor loads index.html
        if (wsProxyPort > 0) {
            final WebView preWebView = findViewById(com.getcapacitor.android.R.id.webview);
            if (preWebView != null) {
                appendProxyUserAgent(preWebView, wsProxyPort);
            }
        }

        super.load();

        if (wsProxyPort > 0 && getBridge() != null && getBridge().getWebView() != null) {
            appendProxyUserAgent(getBridge().getWebView(), wsProxyPort);
        }
    }

    private static void appendProxyUserAgent(WebView webView, int port) {
        final String token = "HermesWsProxy/" + port;
        final WebSettings settings = webView.getSettings();
        final String current = settings.getUserAgentString();
        if (current != null && !current.contains("HermesWsProxy/")) {
            settings.setUserAgentString(current + " " + token);
        }
    }

    @Override
    public void onDestroy() {
        if (wsProxyServer != null) {
            wsProxyServer.stop();
            wsProxyServer = null;
        }
        super.onDestroy();
    }
}

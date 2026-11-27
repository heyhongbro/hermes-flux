package com.hermesflux.app;

import android.net.Uri;
import android.util.Log;
import android.webkit.CookieManager;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Embedded loopback WebSocket upgrade proxy for Android WebView.
 *
 * Mirrors scripts/lib/ws-proxy.mjs: Android System WebView forces
 * "Origin: https://localhost" on Capacitor pages and rejects JS attempts
 * to override it, which Hermes Gateway (>= 0.23.1) anti-CSWSH rejects
 * with HTTP 403. Binding strictly to 127.0.0.1 rewrites the upstream
 * Upgrade Origin to match the target gateway while forwarding WebView cookies.
 */
final class GatewayWsProxyServer {
    private static final String TAG = "HermesWsProxy";
    private static final int HANDSHAKE_TIMEOUT_MS = 15_000;
    private static final int MAX_HEADER_BYTES = 16_384;
    private static final String[] PASSTHROUGH_HEADERS = {
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
        "sec-websocket-extensions",
    };

    private static final class HeaderReadResult {
        final byte[] raw;
        final int headerEnd;

        HeaderReadResult(byte[] raw, int headerEnd) {
            this.raw = raw;
            this.headerEnd = headerEnd;
        }
    }

    private static final class HeaderTooLargeException extends IOException {
        HeaderTooLargeException() {
            super("HTTP header block exceeded limit");
        }
    }

    private final Set<Socket> activeSockets = Collections.synchronizedSet(new HashSet<>());
    private final Set<String> allowedTargetOrigins = Collections.synchronizedSet(new HashSet<>());
    private final String authNonce = generateAuthNonce();
    private volatile boolean running;
    private ServerSocket serverSocket;
    private Thread acceptThread;

    String getAuthNonce() {
        return authNonce;
    }

    void allowTargetOrigin(String rawOrigin) {
        if (rawOrigin == null || rawOrigin.trim().isEmpty()) {
            return;
        }
        try {
            final URI parsed = new URI(rawOrigin.trim());
            final String scheme = parsed.getScheme() == null ? "" : parsed.getScheme().toLowerCase(Locale.ROOT);
            final String host = parsed.getHost();
            if (host == null || host.isEmpty()) {
                return;
            }
            if (!"ws".equals(scheme) && !"wss".equals(scheme) && !"http".equals(scheme) && !"https".equals(scheme)) {
                return;
            }
            allowedTargetOrigins.add(canonicalTargetOrigin(scheme, host, parsed.getPort()));
        } catch (Exception ignored) {
            // Ignore malformed origin entries
        }
    }

    synchronized int start() throws IOException {
        if (running && serverSocket != null && !serverSocket.isClosed()) {
            return serverSocket.getLocalPort();
        }
        serverSocket = new ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
        running = true;
        final int port = serverSocket.getLocalPort();
        acceptThread = new Thread(this::acceptLoop, "hermes-ws-proxy-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
        return port;
    }

    synchronized void stop() {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
                // Closing listening socket during Activity teardown
            }
            serverSocket = null;
        }
        final List<Socket> remaining;
        synchronized (activeSockets) {
            remaining = new ArrayList<>(activeSockets);
            activeSockets.clear();
        }
        for (final Socket socket : remaining) {
            closeQuietly(socket);
        }
        acceptThread = null;
    }

    private void acceptLoop() {
        while (running) {
            final ServerSocket srv = serverSocket;
            if (srv == null || srv.isClosed()) {
                return;
            }
            try {
                final Socket client = srv.accept();
                if (!running) {
                    closeQuietly(client);
                    return;
                }
                activeSockets.add(client);
                final Thread connThread = new Thread(() -> handleClient(client), "hermes-ws-proxy-conn");
                connThread.setDaemon(true);
                connThread.start();
            } catch (IOException err) {
                if (running) {
                    Log.w(TAG, "accept error: " + err.getClass().getSimpleName());
                }
            }
        }
    }

    private void handleClient(Socket client) {
        Socket upstream = null;
        try {
            client.setTcpNoDelay(true);
            client.setSoTimeout(HANDSHAKE_TIMEOUT_MS);

            final InputStream clientIn = client.getInputStream();
            final OutputStream clientOut = client.getOutputStream();

            final HeaderReadResult clientHdr;
            try {
                clientHdr = readHeaderBlock(clientIn, MAX_HEADER_BYTES);
            } catch (HeaderTooLargeException tooLarge) {
                rejectHttp(clientOut, 431, "Request Header Fields Too Large");
                closeTracked(client);
                return;
            }
            if (clientHdr == null) {
                closeTracked(client);
                return;
            }

            final String headerText = new String(
                clientHdr.raw,
                0,
                clientHdr.headerEnd - 4,
                StandardCharsets.ISO_8859_1
            );
            final int headLen = clientHdr.raw.length - clientHdr.headerEnd;
            final byte[] clientHead = headLen > 0
                ? Arrays.copyOfRange(clientHdr.raw, clientHdr.headerEnd, clientHdr.raw.length)
                : null;

            final String[] lines = headerText.split("\r\n", -1);
            if (lines.length == 0 || containsBareControlNewline(lines[0])) {
                rejectHttp(clientOut, 400, "Bad Request");
                closeTracked(client);
                return;
            }

            final String[] reqParts = lines[0].split(" ");
            if (reqParts.length < 2 || !"GET".equalsIgnoreCase(reqParts[0]) || containsBareControlNewline(reqParts[1])) {
                rejectHttp(clientOut, 400, "Bad Request");
                closeTracked(client);
                return;
            }

            final Map<String, String> headers = new LinkedHashMap<>();
            for (int i = 1; i < lines.length; i++) {
                if (containsBareControlNewline(lines[i])) {
                    rejectHttp(clientOut, 400, "Bad Request");
                    closeTracked(client);
                    return;
                }
                final int colon = lines[i].indexOf(':');
                if (colon <= 0) {
                    rejectHttp(clientOut, 400, "Bad Request");
                    closeTracked(client);
                    return;
                }
                final String name = lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT);
                final String val = lines[i].substring(colon + 1).trim();
                if (containsBareControlNewline(name) || containsBareControlNewline(val)) {
                    rejectHttp(clientOut, 400, "Bad Request");
                    closeTracked(client);
                    return;
                }
                headers.put(name, val);
            }

            final String originHeader = headers.get("origin");
            if (originHeader != null && !originHeader.isEmpty() && !isLoopbackOrigin(originHeader)) {
                rejectHttp(clientOut, 403, "Forbidden");
                closeTracked(client);
                return;
            }

            final Uri reqUri = Uri.parse("http://127.0.0.1" + reqParts[1]);
            if (!"/__gw/ws".equals(reqUri.getPath())) {
                rejectHttp(clientOut, 404, "Not Found");
                closeTracked(client);
                return;
            }

            final String token = reqUri.getQueryParameter("token");
            if (!isValidNonce(token)) {
                rejectHttp(clientOut, 403, "Forbidden");
                closeTracked(client);
                return;
            }

            final String rawTarget = reqUri.getQueryParameter("target");
            if (rawTarget == null || rawTarget.isEmpty()) {
                rejectHttp(clientOut, 400, "Bad Request");
                closeTracked(client);
                return;
            }

            final URI targetUri;
            try {
                targetUri = new URI(rawTarget);
            } catch (Exception err) {
                rejectHttp(clientOut, 400, "Bad Request");
                closeTracked(client);
                return;
            }

            final String scheme = targetUri.getScheme() == null ? "" : targetUri.getScheme().toLowerCase(Locale.ROOT);
            final String host = targetUri.getHost();
            if ((!"ws".equals(scheme) && !"wss".equals(scheme)) || host == null || host.isEmpty()) {
                rejectHttp(clientOut, 400, "Bad Request");
                closeTracked(client);
                return;
            }
            if (isProxySelfPath(targetUri.getPath())) {
                rejectHttp(clientOut, 400, "Bad Request");
                closeTracked(client);
                return;
            }
            if (isBlockedTargetHost(host) || !isAllowedWsPath(targetUri.getRawPath())) {
                rejectHttp(clientOut, 403, "Forbidden");
                closeTracked(client);
                return;
            }

            final boolean isTls = "wss".equals(scheme);
            final int port = targetUri.getPort() > 0 ? targetUri.getPort() : (isTls ? 443 : 80);
            final String targetOrigin = canonicalTargetOrigin(scheme, host, port);
            if (!allowedTargetOrigins.isEmpty() && !allowedTargetOrigins.contains(targetOrigin)) {
                rejectHttp(clientOut, 403, "Forbidden");
                closeTracked(client);
                return;
            }

            upstream = openUpstreamSocket(host, port, isTls);
            activeSockets.add(upstream);
            upstream.setTcpNoDelay(true);
            upstream.setSoTimeout(HANDSHAKE_TIMEOUT_MS);

            final String hostHeader = targetUri.getPort() > 0 ? (host + ":" + targetUri.getPort()) : host;
            final String upstreamOrigin = (isTls ? "https://" : "http://") + hostHeader;
            final String rawPath = (targetUri.getRawPath() == null || targetUri.getRawPath().isEmpty())
                ? "/"
                : targetUri.getRawPath();
            final String fullPath = targetUri.getRawQuery() != null
                ? (rawPath + "?" + targetUri.getRawQuery())
                : rawPath;

            final StringBuilder upstreamReq = new StringBuilder();
            upstreamReq.append("GET ").append(fullPath).append(" HTTP/1.1\r\n");
            upstreamReq.append("Host: ").append(hostHeader).append("\r\n");
            upstreamReq.append("Upgrade: websocket\r\n");
            upstreamReq.append("Connection: Upgrade\r\n");
            upstreamReq.append("Origin: ").append(upstreamOrigin).append("\r\n");
            for (final String passthrough : PASSTHROUGH_HEADERS) {
                final String value = headers.get(passthrough);
                if (value != null && !value.isEmpty() && !containsBareControlNewline(value)) {
                    upstreamReq.append(passthrough).append(": ").append(value).append("\r\n");
                }
            }

            try {
                final String cookie = CookieManager.getInstance().getCookie(upstreamOrigin);
                if (cookie != null && !cookie.isEmpty() && !containsBareControlNewline(cookie)) {
                    upstreamReq.append("Cookie: ").append(cookie).append("\r\n");
                }
            } catch (Throwable ignored) {
                // CookieManager unavailable in restricted test harnesses
            }
            upstreamReq.append("\r\n");

            final OutputStream upstreamOut = upstream.getOutputStream();
            final InputStream upstreamIn = upstream.getInputStream();
            upstreamOut.write(upstreamReq.toString().getBytes(StandardCharsets.ISO_8859_1));
            if (clientHead != null && clientHead.length > 0) {
                upstreamOut.write(clientHead);
            }
            upstreamOut.flush();

            // Keep HANDSHAKE_TIMEOUT_MS armed until upstream responds with HTTP/1.1 101
            final HeaderReadResult upHdr = readHeaderBlock(upstreamIn, MAX_HEADER_BYTES);
            if (upHdr == null) {
                rejectHttp(clientOut, 502, "Bad Gateway");
                closeTracked(upstream);
                closeTracked(client);
                return;
            }

            final String upHeaderText = new String(upHdr.raw, 0, upHdr.headerEnd - 4, StandardCharsets.ISO_8859_1);
            final int firstCrLf = upHeaderText.indexOf("\r\n");
            final String statusLine = firstCrLf >= 0 ? upHeaderText.substring(0, firstCrLf) : upHeaderText;
            final String[] statusParts = statusLine.split(" ");
            final boolean isSwitched = statusParts.length >= 2 && "101".equals(statusParts[1]);

            clientOut.write(upHdr.raw, 0, upHdr.raw.length);
            clientOut.flush();

            if (!isSwitched) {
                closeTracked(upstream);
                closeTracked(client);
                return;
            }

            client.setSoTimeout(0);
            upstream.setSoTimeout(0);

            final Socket clientSock = client;
            final Socket upstreamSock = upstream;
            final Thread upToClient = new Thread(() -> pipeStream(upstreamIn, clientOut, clientSock, upstreamSock), "hermes-ws-up2cli");
            final Thread clientToUp = new Thread(() -> pipeStream(clientIn, upstreamOut, upstreamSock, clientSock), "hermes-ws-cli2up");
            upToClient.setDaemon(true);
            clientToUp.setDaemon(true);
            upToClient.start();
            clientToUp.start();
        } catch (Exception err) {
            Log.w(TAG, "proxy tunnel failed: " + err.getClass().getSimpleName());
            try {
                rejectHttp(client.getOutputStream(), 502, "Bad Gateway");
            } catch (IOException ignored) {
                // Client already disconnected
            }
            closeTracked(upstream);
            closeTracked(client);
        }
    }

    private static HeaderReadResult readHeaderBlock(InputStream in, int maxBytes) throws IOException {
        final ByteArrayOutputStream buf = new ByteArrayOutputStream();
        final byte[] chunk = new byte[2048];
        int headerEnd = -1;
        while (headerEnd < 0) {
            final int n = in.read(chunk);
            if (n < 0) {
                return null;
            }
            buf.write(chunk, 0, n);
            if (buf.size() > maxBytes) {
                throw new HeaderTooLargeException();
            }
            headerEnd = findHeaderEnd(buf.toByteArray());
        }
        return new HeaderReadResult(buf.toByteArray(), headerEnd);
    }

    private static Socket openUpstreamSocket(String host, int port, boolean isTls) throws IOException {
        final Socket plain = new Socket();
        plain.connect(new InetSocketAddress(host, port), HANDSHAKE_TIMEOUT_MS);
        plain.setSoTimeout(HANDSHAKE_TIMEOUT_MS);
        plain.setKeepAlive(true);
        if (!isTls) {
            return plain;
        }
        try {
            final SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault())
                .createSocket(plain, host, port, true);
            final SSLParameters params = ssl.getSSLParameters();
            params.setEndpointIdentificationAlgorithm("HTTPS");
            ssl.setSSLParameters(params);
            ssl.startHandshake();
            return ssl;
        } catch (IOException | RuntimeException err) {
            closeQuietly(plain);
            throw err;
        }
    }

    private void pipeStream(InputStream in, OutputStream out, Socket a, Socket b) {
        final byte[] buf = new byte[16_384];
        try {
            int n;
            while ((n = in.read(buf)) >= 0) {
                if (n > 0) {
                    out.write(buf, 0, n);
                    out.flush();
                }
            }
        } catch (IOException ignored) {
            // Normal socket teardown from peer disconnect
        } finally {
            closeTracked(a);
            closeTracked(b);
        }
    }

    private static boolean containsBareControlNewline(String value) {
        return value != null && (value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0);
    }

    private boolean isValidNonce(String candidate) {
        if (candidate == null || candidate.isEmpty()) {
            return false;
        }
        return MessageDigest.isEqual(
            authNonce.getBytes(StandardCharsets.UTF_8),
            candidate.getBytes(StandardCharsets.UTF_8)
        );
    }

    private static String generateAuthNonce() {
        final byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        final StringBuilder hex = new StringBuilder(bytes.length * 2);
        for (final byte b : bytes) {
            hex.append(Character.forDigit((b >> 4) & 0xF, 16));
            hex.append(Character.forDigit(b & 0xF, 16));
        }
        return hex.toString();
    }

    private static String canonicalTargetOrigin(String scheme, String host, int port) {
        final String httpScheme = ("wss".equals(scheme) || "https".equals(scheme)) ? "https" : "http";
        final int effectivePort = port > 0 ? port : ("https".equals(httpScheme) ? 443 : 80);
        final String lowerHost = host.toLowerCase(Locale.ROOT);
        final String formattedHost = (lowerHost.contains(":") && !lowerHost.startsWith("["))
            ? ("[" + lowerHost + "]")
            : lowerHost;
        return httpScheme + "://" + formattedHost + ":" + effectivePort;
    }

    private static boolean isBlockedTargetHost(String host) {
        final String lower = host.toLowerCase(Locale.ROOT);
        final String bare = lower.startsWith("[") && lower.endsWith("]")
            ? lower.substring(1, lower.length() - 1)
            : lower;
        return bare.startsWith("169.254.")
            || bare.startsWith("fe80:")
            || "metadata.google.internal".equals(bare);
    }

    private static boolean isAllowedWsPath(String rawPath) {
        if (rawPath == null || rawPath.isEmpty()) {
            return false;
        }
        final String decoded;
        try {
            decoded = URLDecoder.decode(rawPath, "UTF-8");
        } catch (Exception err) {
            return false;
        }
        if (rawPath.contains("..") || decoded.contains("..") || rawPath.contains("\\") || decoded.contains("\\")) {
            return false;
        }
        final String normalized = decoded.replaceAll("/+", "/");
        if (isProxySelfPath(normalized)) {
            return false;
        }
        return "/api/ws".equals(normalized)
            || normalized.startsWith("/api/ws/")
            || "/ws".equals(normalized)
            || normalized.startsWith("/ws/");
    }

    private static boolean isProxySelfPath(String decodedPath) {
        if (decodedPath == null || decodedPath.isEmpty()) {
            return false;
        }
        final String normalized = decodedPath.replaceAll("/+", "/");
        return "/__gw/ws".equals(normalized) || normalized.startsWith("/__gw/ws/");
    }

    private static int findHeaderEnd(byte[] bytes) {
        for (int i = 3; i < bytes.length; i++) {
            if (bytes[i - 3] == '\r' && bytes[i - 2] == '\n' && bytes[i - 1] == '\r' && bytes[i] == '\n') {
                return i + 1;
            }
        }
        return -1;
    }

    private static boolean isLoopbackOrigin(String rawOrigin) {
        try {
            final URI uri = new URI(rawOrigin);
            final String scheme = uri.getScheme();
            final String host = uri.getHost();
            if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
                return false;
            }
            return "localhost".equalsIgnoreCase(host)
                || "127.0.0.1".equals(host)
                || "[::1]".equals(host);
        } catch (Exception err) {
            return false;
        }
    }

    private static void rejectHttp(OutputStream out, int code, String reason) throws IOException {
        final String resp = "HTTP/1.1 " + code + " " + reason + "\r\nConnection: close\r\n\r\n";
        out.write(resp.getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }

    private void closeTracked(Socket socket) {
        if (socket != null) {
            activeSockets.remove(socket);
            closeQuietly(socket);
        }
    }

    private static void closeQuietly(Socket socket) {
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
                // Socket cleanup
            }
        }
    }
}
